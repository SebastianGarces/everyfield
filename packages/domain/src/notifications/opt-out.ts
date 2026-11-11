import { notificationCategory, type NotificationReply } from "@everyfield/contracts/notifications";
import { emailOptOutResult, emailOptOutRequest, optOutPurpose } from "@everyfield/contracts/notifications";
import { defaultChannelEnabled, notificationChannels } from "@everyfield/contracts/settings";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { deny, parse, readReply } from "./core.ts";

const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const payload = z.strictObject({
	v: z.literal(1),
	purpose: optOutPurpose,
	accountId: z.uuid(),
	category: notificationCategory,
	iat: stamp,
	exp: stamp,
	unsubscribeRevision: z.string().regex(/^(0|[1-9]\d*)$/),
});
type Payload = z.infer<typeof payload>;
const DAY = 86_400_000;
const HOUR = 60 * 60 * 1000;
export const OPT_OUT_DISABLE_MS = 180 * DAY;
export type OptOutKeyRing = { current: Buffer; previous?: readonly Buffer[] };

function asRing(key: Buffer | OptOutKeyRing): OptOutKeyRing {
	return Buffer.isBuffer(key) ? { current: key } : key;
}
function boundMs(purpose: Payload["purpose"]) {
	return purpose === "undo" ? HOUR : OPT_OUT_DISABLE_MS;
}
const stateRow = z.object({
	account_id: z.uuid().nullable(),
	rev: z.string().nullable(),
	email_enabled: z.boolean().nullable(),
	in_app_enabled: z.boolean().nullable(),
	changed: z.boolean(),
});

export function issueEmailOptOutToken(
	key: Buffer | OptOutKeyRing,
	input: Omit<Payload, "v" | "iat" | "exp"> & { iat?: string; exp?: string },
): string {
	return seal(key, input, () => randomBytes(12));
}

/**
 * The disable token one email carries in its Unsubscribe link and List-Unsubscribe header. The same mail gives the same
 * token on every send attempt, so a retried provider request keeps its body under its idempotency key: the IV is derived
 * from the claim under a subkey of the current key (synthetic IV), and `iat` is the mail's own creation time.
 */
export function issueMailOptOutToken(
	key: Buffer | OptOutKeyRing,
	input: Pick<Payload, "accountId" | "category" | "unsubscribeRevision" | "iat">,
): string {
	return seal(key, { ...input, purpose: "disable" }, (current, claim) =>
		createHmac("sha256", createHmac("sha256", current).update("everyfield/opt-out-siv").digest())
			.update(claim)
			.digest()
			.subarray(0, 12),
	);
}

function seal(
	key: Buffer | OptOutKeyRing,
	input: Omit<Payload, "v" | "iat" | "exp"> & { iat?: string; exp?: string },
	iv: (current: Buffer, claim: string) => Buffer,
): string {
	const ring = asRing(key);
	if (ring.current.length !== 32) throw new Error("opt_out_key");
	const iat = input.iat ?? new Date().toISOString();
	const exp = input.exp ?? new Date(Date.parse(iat) + boundMs(input.purpose)).toISOString();
	const claim = JSON.stringify({
		v: 1,
		purpose: input.purpose,
		accountId: input.accountId,
		category: input.category,
		iat,
		exp,
		unsubscribeRevision: input.unsubscribeRevision,
	});
	return sealClaim(ring.current, claim, iv(ring.current, claim));
}

/**
 * One AES-256-GCM token over a JSON claim: nonce, tag, then ciphertext, in base64url. The Messages opt-out
 * (communication/opt-out.ts) seals its own claims with this under its own subkey.
 */
export function sealClaim(key: Buffer, claim: string, nonce: Buffer): string {
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const body = Buffer.concat([cipher.update(claim), cipher.final()]);
	return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
}

/** The JSON claim a token sealed under `key` holds, or null when it does not open: forged, tampered or another key. */
export function openClaim(key: Buffer, token: string): unknown {
	try {
		const buf = Buffer.from(token, "base64url");
		if (buf.length < 29 || key.length !== 32) return null;
		const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
		decipher.setAuthTag(buf.subarray(12, 28));
		return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString());
	} catch {
		return null;
	}
}

/**
 * NOTIFICATION_OPT_OUT_KEYS: comma-separated base64 keys of 32 bytes, the current key first, then older keys that
 * still open tokens issued before a rotation. Anything else counts as not configured, so opt-out fails closed.
 */
export function parseKeyRing(raw: string | undefined): { current: Buffer; previous: Buffer[] } | null {
	const keys = (raw ?? "")
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean)
		.map((k) => Buffer.from(k, "base64"));
	const [current, ...previous] = keys;
	return current && keys.every((k) => k.length === 32) ? { current, previous } : null;
}

function openWith(key: Buffer, token: string): Payload | null {
	const parsed = payload.safeParse(openClaim(key, token));
	return parsed.success ? parsed.data : null;
}

function openToken(key: Buffer | OptOutKeyRing, token: string): Payload | null {
	const ring = asRing(key);
	for (const candidate of [ring.current, ...(ring.previous ?? [])]) {
		const claim = openWith(candidate, token);
		if (claim) return claim;
	}
	return null;
}

function windowTooLong(claim: Payload) {
	return Date.parse(claim.exp) - Date.parse(claim.iat) > boundMs(claim.purpose);
}

async function readState(db: Database, claim: Payload) {
	const result = await db.execute(sql`WITH locked AS (
			SELECT id FROM account WHERE id = ${claim.accountId}::uuid AND registration_state = 'active'
		)
		SELECT (SELECT id FROM locked) AS account_id,
			COALESCE((SELECT unsubscribe_revision::text FROM notification_preference
				WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'email'), '0') AS rev,
			COALESCE((SELECT enabled FROM notification_preference
				WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'email'), ${defaultChannelEnabled(claim.category, "email")}) AS email_enabled,
			COALESCE((SELECT enabled FROM notification_preference
				WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'in_app'), ${defaultChannelEnabled(claim.category, "in_app")}) AS in_app_enabled,
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
				COALESCE((SELECT enabled FROM email_pref), ${defaultChannelEnabled(claim.category, "email")}) AS email_enabled,
				COALESCE((SELECT enabled FROM notification_preference
					WHERE account_id = (SELECT id FROM locked) AND category = ${claim.category} AND channel = 'in_app'), ${defaultChannelEnabled(claim.category, "in_app")}) AS in_app_enabled
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
	key: Buffer | OptOutKeyRing,
	now: () => Date,
	raw: unknown,
	purpose: "disable" | "undo" | "describe",
): Promise<NotificationReply<z.infer<typeof emailOptOutResult>>> {
	return readReply(async () => {
		const input =
			purpose === "describe" ? { token: parse(emailOptOutRequest, raw).token } : parse(emailOptOutRequest, raw);
		const claim = openToken(key, input.token);
		if (!claim || (purpose !== "describe" && claim.purpose !== purpose)) deny("access_denied");
		if (!notificationChannels(claim.category).includes("email")) deny("invalid_input");
		if (windowTooLong(claim)) deny("access_denied");
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
						iat: now().toISOString(),
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
