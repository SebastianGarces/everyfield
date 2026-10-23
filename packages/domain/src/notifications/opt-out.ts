import { notificationCategory, type NotificationReply } from "@everyfield/contracts/notifications";
import { emailOptOutResult, emailOptOutRequest, optOutPurpose } from "@everyfield/contracts/notifications";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { deny, parse, readReply } from "./core.ts";

const payload = z.strictObject({
	v: z.literal(1),
	purpose: optOutPurpose,
	accountId: z.uuid(),
	category: notificationCategory,
	exp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
	unsubscribeRevision: z.string().regex(/^(0|[1-9]\d*)$/),
});
type Payload = z.infer<typeof payload>;
const DAY = 86_400_000;
const stateRow = z.object({
	account_id: z.uuid().nullable(),
	rev: z.string().nullable(),
	email_enabled: z.boolean().nullable(),
	in_app_enabled: z.boolean().nullable(),
	changed: z.boolean(),
});

export function issueEmailOptOutToken(key: Buffer, input: Omit<Payload, "v">): string {
	if (key.length !== 32) throw new Error("opt_out_key");
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(JSON.stringify({ v: 1, ...input })), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function openToken(key: Buffer, token: string): Payload | null {
	try {
		const buf = Buffer.from(token, "base64url");
		if (buf.length < 29) return null;
		const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
		decipher.setAuthTag(buf.subarray(12, 28));
		const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString();
		const parsed = payload.safeParse(JSON.parse(json));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function defaultInApp(category: string) {
	return category !== "planter_digest";
}

async function readState(db: Database, claim: Payload) {
	const result = await db.execute(sql`WITH locked AS (
			SELECT id FROM account WHERE id = ${claim.accountId}::uuid AND registration_state = 'active'
		)
		SELECT (SELECT id FROM locked) AS account_id,
			COALESCE((SELECT unsubscribe_revision::text FROM notification_preference
				WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'email'), '0') AS rev,
			COALESCE((SELECT enabled FROM notification_preference
				WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'email'), true) AS email_enabled,
			COALESCE((SELECT enabled FROM notification_preference
				WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'in_app'), ${defaultInApp(claim.category)}) AS in_app_enabled,
			false AS changed`);
	return stateRow.parse(result.rows[0]);
}

async function writeState(db: Database, claim: Payload) {
	const enable = claim.purpose === "undo";
	const field = `${claim.category}.email`;
	const result = await db.execute(sql`WITH locked AS (
			SELECT id FROM account WHERE id = ${claim.accountId}::uuid AND registration_state = 'active' FOR UPDATE
		),
		email_pref AS (
			SELECT enabled, unsubscribe_revision FROM notification_preference
			WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'email'
		),
		state AS (
			SELECT (SELECT id FROM locked) AS account_id,
				COALESCE((SELECT unsubscribe_revision::text FROM email_pref), '0') AS rev,
				COALESCE((SELECT enabled FROM email_pref), true) AS email_enabled,
				COALESCE((SELECT enabled FROM notification_preference
					WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'in_app'), ${defaultInApp(claim.category)}) AS in_app_enabled
		),
		upserted AS (
			INSERT INTO notification_preference (account_id, category, channel, enabled, unsubscribe_revision)
			SELECT account_id, ${claim.category}, 'email', ${enable},
				CASE WHEN ${claim.purpose} = 'disable' THEN COALESCE((SELECT unsubscribe_revision FROM email_pref), 0) + 1
					ELSE COALESCE((SELECT unsubscribe_revision FROM email_pref), 1) END
			FROM state
			WHERE account_id IS NOT NULL AND rev = ${claim.unsubscribeRevision}
				AND ((${claim.purpose} = 'disable' AND email_enabled IS TRUE) OR (${claim.purpose} = 'undo' AND email_enabled IS FALSE))
			ON CONFLICT (account_id, category, channel) DO UPDATE SET
				enabled = EXCLUDED.enabled,
				unsubscribe_revision = CASE WHEN ${claim.purpose} = 'disable'
					THEN notification_preference.unsubscribe_revision + 1 ELSE notification_preference.unsubscribe_revision END,
				revision = notification_preference.revision + 1
			WHERE notification_preference.enabled IS DISTINCT FROM EXCLUDED.enabled
			RETURNING unsubscribe_revision::text AS rev
		),
		audited AS (
			INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, metadata)
			SELECT account_id, account_id, 'settings.changed', 'preference', 'record', account_id,
				jsonb_build_object('section','notifications','diff', jsonb_build_object(${field}::text, true))
			FROM state WHERE EXISTS (SELECT FROM upserted)
			RETURNING id
		)
		SELECT (SELECT account_id FROM state) AS account_id,
			COALESCE((SELECT rev FROM upserted), (SELECT rev FROM state)) AS rev,
			(SELECT email_enabled FROM state) AS email_enabled,
			(SELECT in_app_enabled FROM state) AS in_app_enabled,
			EXISTS(SELECT FROM upserted) AS changed`);
	return stateRow.parse({ ...result.rows[0], changed: result.rows[0]?.changed });
}

export function emailOptOut(
	db: Database,
	key: Buffer,
	now: () => Date,
	raw: unknown,
	purpose: "disable" | "undo" | "describe",
): Promise<NotificationReply<z.infer<typeof emailOptOutResult>>> {
	return readReply(async () => {
		const input =
			purpose === "describe" ? { token: parse(emailOptOutRequest, raw).token } : parse(emailOptOutRequest, raw);
		const claim = openToken(key, input.token);
		if (!claim || (purpose !== "describe" && claim.purpose !== purpose)) deny("access_denied");
		if (!claim) deny("access_denied");
		if (claim.category === "wiki_upstream_review") deny("invalid_input");
		const expired = Date.parse(claim.exp) <= now().getTime();
		const row = expired || purpose === "describe" ? await readState(db, claim) : await writeState(db, claim);
		if (!row.account_id || row.rev === null || row.email_enabled === null || row.in_app_enabled === null)
			deny("access_denied");
		const already =
			(purpose === "disable" && row.email_enabled === false) || (purpose === "undo" && row.email_enabled === true);
		if (!expired && purpose !== "describe" && row.rev !== claim.unsubscribeRevision && !row.changed && !already)
			deny("access_denied");
		const emailEnabled = row.changed ? purpose === "undo" : row.email_enabled;
		const undo =
			purpose === "disable" && !expired && (row.changed || row.email_enabled === false)
				? issueEmailOptOutToken(key, {
						purpose: "undo",
						accountId: claim.accountId,
						category: claim.category,
						exp: new Date(now().getTime() + 60 * 60 * 1000).toISOString(),
						unsubscribeRevision: row.rev,
					})
				: null;
		return emailOptOutResult.parse({
			category: claim.category,
			purpose: claim.purpose,
			expired,
			changed: expired || purpose === "describe" ? false : row.changed,
			emailEnabled,
			inAppEnabled: row.in_app_enabled,
			undoToken: undo,
		});
	});
}

export const OPT_OUT_DISABLE_MS = 180 * DAY;
