import "server-only";
import type { CredentialConfig, DeletionEffects } from "@everyfield/domain/settings";
import { and, eq, gt, inArray, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { database } from "../../server/database.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type MailPass,
	type MailTransport,
} from "../../server/jobs/mail.ts";
import { protectedTemplate } from "../../server/jobs/templates.ts";
import { mailEnv } from "../../server/mail-env.ts";
import { workspaceDeletionContent } from "./deletion-mail.ts";

// The settings mount's mail (WP-010): the email-change link and the security notices its credential changes queue,
// and the church workspace deletion notices (T-272), under one rule at enqueue and again when the scheduled runner hands them to the email service. Relative imports, so
// node tests can import it by path.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	...mailEnv,
});

/** A workspace deletion notice's key: its kind and request. The recipient account is its tenant. */
const WORKSPACE_NOTICE = /^workspace-deletion\/(requested|cancelled)\/([0-9a-f-]{36})$/;
const noticeHolder = z.object({ id: z.uuid(), email: z.string() });

function settingsMailService(v: z.infer<typeof env>, transport?: MailTransport) {
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const addressHash = (address: string) =>
		createHmac("sha256", addressKey).update(address.trim().toLowerCase()).digest("hex");
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		// An email-change link goes only to the address of the account's live proof; a security notice only to its
		// own account. A workspace deletion notice goes only while its request is still in the state it tells of, to
		// an account that still holds a seat in that church at the address it was queued for, with no personal
		// deletion of its own pending. Mail whose tenant is a church in deletion stays stopped by the mail service.
		authorize: async (tx, list) => {
			const notices = list.flatMap((m) => {
				const key = WORKSPACE_NOTICE.exec(m.logicalKey);
				return key && m.purpose === "notification" && m.recipient === m.tenant
					? [{ id: m.id, account: m.tenant, kind: key[1], request: key[2] }]
					: [];
			});
			const held = notices.length
				? (
						await tx.execute(
							sql`SELECT n.id, c.email FROM jsonb_to_recordset(${JSON.stringify(notices)}::jsonb) n(id uuid,account uuid,kind text,request uuid)
 JOIN lifecycle_witness w ON w.kind='plant' AND w.request_id=n.request
  AND CASE n.kind WHEN 'requested' THEN w.state='pending_deletion' AND w.cancel_until>clock_timestamp() ELSE w.state='cancelled' END
 CROSS JOIN LATERAL access_account_contact(n.account) c
 WHERE EXISTS(SELECT FROM seat s WHERE s.account_id=n.account AND s.plant_id=w.plant_id AND s.ended_at IS NULL)
  AND NOT EXISTS(SELECT FROM lifecycle_witness h WHERE h.kind='account' AND h.opaque_subject_id=n.account AND h.state NOT IN ('active','cancelled'))`,
						)
					).rows.map((r) => noticeHolder.parse(r))
				: [];
			const proofs = await tx
				.select({ account: t.identity_proof.account_id, address: t.identity_proof.proposed_email })
				.from(t.identity_proof)
				.where(
					and(
						inArray(
							t.identity_proof.account_id,
							list.map((m) => m.tenant),
						),
						eq(t.identity_proof.purpose, "email_change"),
						isNull(t.identity_proof.superseded_at),
						isNull(t.identity_proof.consumed_at),
						gt(t.identity_proof.expires_at, sql`clock_timestamp()`),
					),
				);
			return new Set(
				list
					.filter(
						(m) =>
							m.recipient === m.tenant &&
							(m.purpose === "email_change"
								? proofs.some((p) => p.account === m.tenant && p.address && addressHash(p.address) === m.addressHash)
								: m.purpose === "notification" &&
									(m.logicalKey.startsWith("security/") ||
										held.some((h) => h.id === m.id && addressHash(h.email) === m.addressHash))),
					)
					.map((m) => m.id),
			);
		},
		transport,
	});
}

/**
 * The two mail effects the credential producer calls, each queueing its mail in the producer's own writes. Null when
 * the deployment has no identity or mail configuration.
 */
export function settingsMail():
	(Pick<CredentialConfig, "deliverVerification" | "securityNotice"> & Pick<DeletionEffects, "workspaceNotice">) | null {
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	const origin = parsed.data.IDENTITY_ORIGIN;
	const mail = settingsMailService(parsed.data);
	return {
		deliverVerification: async (tx, i, writes) => {
			const url = `${origin}/confirm-email?token=${encodeURIComponent(i.token)}`;
			await mail.append(
				tx,
				{
					owner: { kind: "account", id: i.accountId },
					purpose: "email_change",
					logicalKey: `email-change/${randomUUID()}`,
					recipient: i.accountId,
					address: i.address,
					content: protectedTemplate({ purpose: "email_change", url }, origin),
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				writes,
			);
		},
		securityNotice: (tx, i, writes) =>
			mail.append(
				tx,
				{
					owner: { kind: "account", id: i.accountId },
					purpose: "notification",
					logicalKey: `security/${i.correlationId}`,
					recipient: i.accountId,
					address: i.address,
					content:
						i.action === "password_changed"
							? {
									subject: "Your Everyfield password changed",
									text: "The password for your Everyfield account changed. Other devices were signed out.\n\nIf you did not change it, reset your password now.",
								}
							: {
									subject: "Your Everyfield sign-in email changed",
									text: "The email you use to sign in to Everyfield changed. This address no longer signs in.\n\nIf you did not change it, contact Everyfield support now.",
								},
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				writes,
			),
		// A service notice: no notice row, so cadence and unsubscribe settings never hold it back; the suppression
		// list still does.
		workspaceNotice: async (tx, notice, writes) => {
			for (const recipient of notice.recipients)
				await mail.append(
					tx,
					{
						owner: { kind: "account", id: recipient.accountId },
						purpose: "notification",
						logicalKey: `workspace-deletion/${notice.kind}/${notice.requestId}`,
						recipient: recipient.accountId,
						address: recipient.address,
						content: workspaceDeletionContent(notice, recipient, origin),
						operation: null,
						notice: null,
						eligibleAt: new Date().toISOString(),
					},
					writes,
				);
		},
	};
}

/**
 * The scheduled runner's settings mail pass: one bounded batch of this mount's due mail through `transport`, each
 * rechecked under the mount's own rule. Null when the deployment has no configuration for this mount.
 */
export function settingsMailPass(transport: MailTransport): MailPass | null {
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	const db = database(parsed.data.IDENTITY_DATABASE_URL),
		mail = settingsMailService(parsed.data, transport);
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.settings, limit, until);
}
