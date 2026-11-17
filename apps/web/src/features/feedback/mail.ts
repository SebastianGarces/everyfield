import "server-only";
import { sql } from "@everyfield/db/query";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { database } from "../../server/database.ts";
import type { OperatorMail, OperatorNotice } from "../../server/jobs/feedback-publication.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type MailPass,
	type MailTransport,
} from "../../server/jobs/mail.ts";
import { mailEnv } from "../../server/mail-env.ts";

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	FEEDBACK_OPERATOR_EMAIL: z.email().max(320),
	...mailEnv,
});
const KEY = /^feedback\/([0-9a-f-]{36})$/;

export const operatorMailConfigured = (source: Readonly<Record<string, string | undefined>> = process.env) =>
	env.safeParse(source).success;

function feedbackMailService(v: z.infer<typeof env>, transport?: MailTransport) {
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const inbox = createHmac("sha256", addressKey).update(v.FEEDBACK_OPERATOR_EMAIL.trim().toLowerCase()).digest("hex");
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		authorize: async (tx, list) => {
			const wanted = list.flatMap((m) => {
				const key = KEY.exec(m.logicalKey);
				return key && m.purpose === "notification" && m.recipient === null && m.addressHash === inbox
					? [{ id: m.id, feedback: key[1], account: m.tenant }]
					: [];
			});
			if (!wanted.length) return new Set();
			const found = await tx.execute(
				sql`SELECT w.id FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) w(id uuid,feedback uuid,account uuid)
 JOIN feedback f ON f.id=w.feedback AND f.account_id=w.account`,
			);
			return new Set(found.rows.map((r) => z.uuid().parse(r.id)));
		},
		transport,
	});
}

function operatorContent(notice: Omit<OperatorNotice, "tenant" | "feedbackId">, origin: string) {
	const triage = `Triage it in Everyfield: ${origin}/feedback/triage`;
	if (!notice.issue)
		return {
			subject: "Feedback held for triage",
			text: `A feedback report was submitted. Nothing was published: it is held for triage. Reference: ${notice.reference}.\n\n${triage}`,
		};
	const link = notice.url ? `Public issue: ${notice.url}` : "No public issue was published: it is held for triage.";
	return { subject: notice.issue.title, text: `${notice.issue.body}\n\n${link}\n\n${triage}` };
}

export function operatorMail(source: Readonly<Record<string, string | undefined>> = process.env): OperatorMail | null {
	const parsed = env.safeParse(source);
	if (!parsed.success) return null;
	const v = parsed.data;
	const mail = feedbackMailService(v);
	return (notice) =>
		mail.queued([
			{
				owner: { kind: "account", id: notice.tenant },
				purpose: "notification",
				logicalKey: `feedback/${notice.feedbackId}`,
				recipient: null,
				address: v.FEEDBACK_OPERATOR_EMAIL,
				content: operatorContent(notice, new URL(v.IDENTITY_ORIGIN).origin),
				operation: null,
				notice: null,
				eligibleAt: new Date().toISOString(),
			},
		]).ctes;
}

export function feedbackMailPass(transport: MailTransport): MailPass | null {
	const parsed = env.safeParse(process.env);
	if (!parsed.success) return null;
	const db = database(parsed.data.IDENTITY_DATABASE_URL),
		mail = feedbackMailService(parsed.data, transport);
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.feedback, limit, until);
}
