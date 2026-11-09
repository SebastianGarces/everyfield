import { createHmac, randomBytes } from "node:crypto";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { z } from "zod";
import { openClaim, sealClaim, type OptOutKeyRing } from "../notifications/opt-out.ts";
import { deny, readReply } from "./core.ts";

// The Messages opt-out (REQ-NTF-016, D-284: "Per church and per person, staff can see it but can't clear it"). Every
// Messages email names one church and one CRM Person in its Unsubscribe link. The token is the only authority: opening
// the page only describes it, the button or the RFC 8058 one-click POST records the opt-out, and the undo it returns
// works for one hour. Nothing here reads an account, a session or an address.

const HOUR = 60 * 60 * 1000;
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const claim = z.discriminatedUnion("purpose", [
	z.strictObject({
		v: z.literal(1),
		kind: z.literal("messages"),
		purpose: z.literal("disable"),
		plantId: z.uuid(),
		personId: z.uuid(),
	}),
	z.strictObject({
		v: z.literal(1),
		kind: z.literal("messages"),
		purpose: z.literal("undo"),
		plantId: z.uuid(),
		personId: z.uuid(),
		optOutId: z.uuid(),
		exp: stamp,
	}),
]);
type Claim = z.infer<typeof claim>;
const tokenInput = z.strictObject({ token: z.string().min(1).max(2048) });

/**
 * The Messages subkey of one opt-out key. The account opt-out seals its tokens with the key itself, so a token of one
 * kind never opens as the other.
 */
const subkey = (key: Buffer, label: "token" | "siv") =>
	createHmac("sha256", key).update(`everyfield/messages-opt-out/${label}`).digest();

function ringOf(ring: OptOutKeyRing) {
	if (ring.current.length !== 32) throw new Error("opt_out_key");
	return [ring.current, ...(ring.previous ?? [])];
}

function seal(ring: OptOutKeyRing, value: Claim, nonce: (claimJson: string) => Buffer) {
	const json = JSON.stringify(value);
	return sealClaim(subkey(ringOf(ring)[0]!, "token"), json, nonce(json));
}

/**
 * The disable token of one church and one Person, as every Messages email to them carries it. It is the same on every
 * render (a synthetic IV from the claim), so a retried handoff keeps its body under its idempotency key.
 */
export function messagesOptOutToken(ring: OptOutKeyRing, input: { plantId: string; personId: string }): string {
	return seal(ring, { v: 1, kind: "messages", purpose: "disable", ...input }, (json) =>
		createHmac("sha256", subkey(ringOf(ring)[0]!, "siv"))
			.update(json)
			.digest()
			.subarray(0, 12),
	);
}

function open(ring: OptOutKeyRing, token: string): Claim | null {
	for (const key of ringOf(ring)) {
		const parsed = claim.safeParse(openClaim(subkey(key, "token"), token));
		if (parsed.success) return parsed.data;
	}
	return null;
}

/**
 * The SQL test that a Messages email to `personId` in `plantId` is refused: the Person, or a Person merged into them,
 * has a current opt-out from this church. It names the Person, never the address.
 */
export function optedOutSql(plantId: SQL, personId: SQL): SQL {
	return sql`EXISTS (SELECT 1 FROM person_email_opt_out o
		WHERE o.plant_id = ${plantId} AND o.undone_at IS NULL
			AND (o.person_id = ${personId} OR o.person_id IN (
				SELECT q.id FROM person q WHERE q.merged_into_person_id = ${personId} AND q.tenant_id = ${plantId})))`;
}

/** When `personId` (or a Person merged into them) opted out of this church's Messages email, as SQL text or null. */
export function optedOutAtSql(plantId: SQL, personId: SQL): SQL {
	return sql`(SELECT to_char(min(o.opted_out_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		FROM person_email_opt_out o
		WHERE o.plant_id = ${plantId} AND o.undone_at IS NULL
			AND (o.person_id = ${personId} OR o.person_id IN (
				SELECT q.id FROM person q WHERE q.merged_into_person_id = ${personId} AND q.tenant_id = ${plantId})))`;
}

const stateRow = z.object({
	church_name: z.string().nullable(),
	opt_out_id: z.uuid().nullable(),
	opted_out_at: z.string().nullable(),
	changed: z.boolean(),
});

/** The church and this Person's own current opt-out. A Person that is not in the church reads as no church. */
async function readState(db: Database, value: Claim) {
	const result = await db.execute(sql`SELECT
		(SELECT pl.name FROM plant pl JOIN person p ON p.id = ${value.personId}::uuid AND p.tenant_id = pl.id
			WHERE pl.id = ${value.plantId}::uuid) AS church_name,
		o.id AS opt_out_id,
		to_char(o.opted_out_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS opted_out_at,
		false AS changed
		FROM (SELECT 1) seed
		LEFT JOIN person_email_opt_out o ON o.person_id = ${value.personId}::uuid AND o.plant_id = ${value.plantId}::uuid
			AND o.undone_at IS NULL`);
	return stateRow.parse(result.rows[0]);
}

/** Record the opt-out once. A second unsubscribe while one is current changes nothing and returns that one. */
async function writeOptOut(db: Database, value: Claim) {
	const result = await db.execute(sql`WITH target AS (
			SELECT p.id, p.tenant_id, pl.name FROM person p JOIN plant pl ON pl.id = p.tenant_id
			WHERE p.id = ${value.personId}::uuid AND p.tenant_id = ${value.plantId}::uuid
			FOR SHARE OF p
		), inserted AS (
			INSERT INTO person_email_opt_out (plant_id, person_id)
			SELECT tenant_id, id FROM target
			ON CONFLICT (person_id) WHERE undone_at IS NULL DO NOTHING
			RETURNING id, opted_out_at
		), current AS (
			SELECT id, opted_out_at FROM inserted
			UNION ALL
			SELECT o.id, o.opted_out_at FROM person_email_opt_out o
			WHERE o.person_id = ${value.personId}::uuid AND o.plant_id = ${value.plantId}::uuid AND o.undone_at IS NULL
				AND NOT EXISTS (SELECT 1 FROM inserted)
		)
		SELECT (SELECT name FROM target) AS church_name,
			(SELECT id FROM current LIMIT 1) AS opt_out_id,
			(SELECT to_char(opted_out_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM current LIMIT 1) AS opted_out_at,
			EXISTS (SELECT 1 FROM inserted) AS changed`);
	return stateRow.parse(result.rows[0]);
}

export type MessagesOptOutView = { churchName: string; unsubscribed: boolean };
export type MessagesOptOutResult = { churchName: string; changed: boolean; undoToken: string | null };
export type MessagesOptInResult = { churchName: string; changed: boolean; expired: boolean };

function openDisable(ring: OptOutKeyRing, raw: unknown) {
	const input = tokenInput.safeParse(raw);
	if (!input.success) deny("invalid_input");
	const value = open(ring, input.data.token);
	if (!value || value.purpose !== "disable") deny("access_denied");
	return value;
}

/** What the Unsubscribe page shows. It changes nothing, so a mail scanner that follows the link stops nothing. */
export function describeMessagesOptOut(db: Database, ring: OptOutKeyRing, raw: unknown) {
	return readReply<MessagesOptOutView>(async () => {
		const value = openDisable(ring, raw);
		const row = await readState(db, value);
		if (row.church_name === null) deny("access_denied");
		return { churchName: row.church_name, unsubscribed: row.opt_out_id !== null };
	});
}

/**
 * Unsubscribe from the button or the one-click POST. The undo token it returns names this opt-out and expires one hour
 * after the person unsubscribed.
 */
export function applyMessagesOptOut(db: Database, ring: OptOutKeyRing, now: () => Date, raw: unknown) {
	return readReply<MessagesOptOutResult>(async () => {
		const value = openDisable(ring, raw);
		const row = await writeOptOut(db, value);
		if (row.church_name === null || row.opt_out_id === null || row.opted_out_at === null) deny("access_denied");
		const exp = new Date(Date.parse(row.opted_out_at) + HOUR);
		const undoToken =
			exp.getTime() > now().getTime()
				? seal(
						ring,
						{
							v: 1,
							kind: "messages",
							purpose: "undo",
							plantId: value.plantId,
							personId: value.personId,
							optOutId: row.opt_out_id,
							exp: exp.toISOString(),
						},
						() => randomBytes(12),
					)
				: null;
		return { churchName: row.church_name, changed: row.changed, undoToken };
	});
}

/** The person's own undo, for one hour after they unsubscribed. After that it is refused and nothing changes. */
export function undoMessagesOptOut(db: Database, ring: OptOutKeyRing, now: () => Date, raw: unknown) {
	return readReply<MessagesOptInResult>(async () => {
		const input = tokenInput.safeParse(raw);
		if (!input.success) deny("invalid_input");
		const value = open(ring, input.data.token);
		if (!value || value.purpose !== "undo") deny("access_denied");
		const expired = Date.parse(value.exp) <= now().getTime();
		const result = await db.execute(sql`WITH target AS (
				SELECT pl.name FROM plant pl JOIN person p ON p.id = ${value.personId}::uuid AND p.tenant_id = pl.id
				WHERE pl.id = ${value.plantId}::uuid
			), undone AS (
				UPDATE person_email_opt_out SET undone_at = clock_timestamp()
				WHERE id = ${value.optOutId}::uuid AND person_id = ${value.personId}::uuid AND plant_id = ${value.plantId}::uuid
					AND undone_at IS NULL AND NOT ${expired}::boolean AND EXISTS (SELECT 1 FROM target)
				RETURNING id
			)
			SELECT (SELECT name FROM target) AS church_name, EXISTS (SELECT 1 FROM undone) AS changed`);
		const row = z.object({ church_name: z.string().nullable(), changed: z.boolean() }).parse(result.rows[0]);
		if (row.church_name === null) deny("access_denied");
		return { churchName: row.church_name, changed: row.changed, expired };
	});
}
