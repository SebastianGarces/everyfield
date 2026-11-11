import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "@everyfield/db/query";
import type { Database } from "@everyfield/db/client";
import * as c from "@everyfield/contracts/communication";
import {
	plainText,
	renderBody,
	renderEmailHtml,
	renderTransactional,
	scheduleAccepted,
	usesRsvpLink,
	type MergeKey,
} from "@everyfield/contracts/communication";
import type { RequestActor } from "../access/session.ts";
import { communicationAccess } from "./access.ts";
import { audiencePeople, reviewedParts } from "./audience.ts";
import { z } from "zod";
import { administers, deny, hash, parse, readReply, readerOf } from "./core.ts";
import { meetingOpenSql, newRsvpToken, rsvpTokenDigest, rsvpTokenUpdate } from "../meetings/tokens.ts";
import type { OptOutKeyRing } from "../notifications/opt-out.ts";
import { messagesOptOutToken, optedOutSql } from "./opt-out.ts";

const BATCH_LIMIT = 100;
const CALL_TIMEOUT_MS = 10_000;

/**
 * `origin` is the deployment's app origin (the one Better Auth uses). RSVP and Unsubscribe links start with it.
 * `optOutKeys` is the NOTIFICATION_OPT_OUT_KEYS ring; without it a Messages email carries no Unsubscribe link, and an
 * unsubscribed person is still refused.
 */
export type DeliveryKeys = {
	encryptionKey: Uint8Array;
	addressKey: Uint8Array;
	from: string;
	origin: string;
	optOutKeys?: OptOutKeyRing | null;
};
/** `headers` holds the RFC 8058 List-Unsubscribe pair, with the same token as the visible Unsubscribe link. */
export type DeliveryMessage = {
	to: string;
	subject: string;
	html: string;
	text: string;
	headers?: Readonly<Record<string, string>>;
};
export type DeliveryBatch =
	{ outcome: "ids"; ids: readonly (string | null)[] } | { outcome: "unknown" } | { outcome: "refused" };
/**
 * One answer to a cancel or time change. `done`: the email service confirmed it. `sent`: the email already went out,
 * so it can no longer be cancelled or moved.
 */
export type ProviderAnswer = { outcome: "done" | "sent" | "unknown" };
export type DeliveryTransport = {
	/** One call for the whole batch. `scheduledAt` asks the email service to hold every message until then. */
	send(
		batch: { key: string; messages: readonly DeliveryMessage[]; scheduledAt: string | null },
		signal: AbortSignal,
	): Promise<DeliveryBatch>;
	lookup(key: string, signal: AbortSignal): Promise<Exclude<DeliveryBatch, { outcome: "refused" }>>;
	/**
	 * Cancel each held email by the id the email service gave it at handoff, never by the idempotency key. One answer
	 * per id, in the same order.
	 */
	cancel(providerIds: readonly string[], signal: AbortSignal): Promise<ProviderAnswer[]>;
	/** Move each held email to `at` by the id the email service gave it at handoff. One answer per id, in order. */
	reschedule(providerIds: readonly string[], at: string, signal: AbortSignal): Promise<ProviderAnswer[]>;
};

type Actor = ReturnType<typeof readerOf>;
type Member = {
	position: number;
	state: string;
	personId: string | null;
	provider: string | null;
	/** The send time the email service holds for this recipient; null for a send-now handoff. */
	scheduledAt: string | null;
	cancelRequested: boolean;
	/** Refused before any handoff because the person unsubscribed from this church's email. */
	unsubscribed: boolean;
};
type Mode = "now" | "scheduled" | "lookup";
/** Recipients the email service may still hold: a cancel or time change has an answer to wait for. */
const holding = (row: Member) => row.state === "accepted" || row.state === "unknown" || row.state === "dispatched";
/** Recipients Everyfield still holds for the send time: a cancel or time change needs no provider call. */
const waiting = (row: Member) => row.state === "scheduled";

const one = (result: { rows: unknown[] }) => result.rows[0];
const asJson = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);
const signal = () => AbortSignal.timeout(CALL_TIMEOUT_MS);

function keysOf(keys: DeliveryKeys) {
	const encryptionKey = Buffer.from(keys.encryptionKey);
	const addressKey = Buffer.from(keys.addressKey);
	if (encryptionKey.length !== 32 || addressKey.length !== 32 || encryptionKey.equals(addressKey))
		throw new Error("mail_keys_required");
	const from = z.email().parse(keys.from);
	const origin = new URL(keys.origin).origin;
	return { encryptionKey, addressKey, from, origin, optOutKeys: keys.optOutKeys ?? null };
}
function seal(key: Buffer, value: string, aad: string) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad));
	const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
function addressHash(addressKey: Buffer, address: string) {
	return createHmac("sha256", addressKey).update(address).digest("hex");
}
/** The address seal binds the ciphertext to this plant and this mail row. */
export function addressAad(plantId: string, mailId: string) {
	return `${plantId}/${mailId}/address`;
}
export function sealText(key: Uint8Array, value: string, aad: string) {
	const buf = Buffer.from(key);
	if (buf.length !== 32) throw new Error("mail_keys_required");
	return seal(buf, value, aad);
}
export function openText(key: Uint8Array, sealed: string, aad: string): string | null {
	try {
		const buf = Buffer.from(key);
		if (buf.length !== 32) return null;
		const raw = Buffer.from(sealed, "base64url");
		const iv = raw.subarray(0, 12);
		const tag = raw.subarray(12, 28);
		const data = raw.subarray(28);
		const decipher = createDecipheriv("aes-256-gcm", buf, iv);
		decipher.setAAD(Buffer.from(aad));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
	} catch {
		return null;
	}
}
export function mailAddressHash(key: Uint8Array, address: string) {
	const addressKey = Buffer.from(key);
	if (addressKey.length !== 32) throw new Error("mail_keys_required");
	return addressHash(addressKey, address);
}
/** C13: the Owner or Admin check of every delivery statement, the same one communication reads make. */
function adminGate(actor: Actor) {
	return communicationAccess(actor, actor.session, true);
}
function requireActor(authority: RequestActor) {
	const actor = readerOf(authority);
	if (!administers(actor)) deny("access_denied");
	return actor;
}
function prefix(id: string) {
	return `communication/${id}/%`;
}
function counts(members: readonly Member[]) {
	// A recipient waiting in Everyfield for its send time counts as accepted: it goes out then unless they opt out.
	const accepted = members.filter(
		(row) => row.state === "accepted" || row.state === "sent" || row.state === "scheduled",
	);
	const rejected = members.filter(
		(row) => !row.unsubscribed && (row.state === "refused" || row.state === "failed" || row.state === "cancelled"),
	);
	const unknown = members.filter((row) => row.state === "unknown" || row.state === "dispatched");
	return {
		acceptedCount: accepted.length,
		rejectedCount: rejected.length,
		unknownCount: unknown.length,
		unsubscribedCount: members.filter((row) => row.unsubscribed).length,
		confirmedRecipientIds: accepted.map((row) => row.personId).filter((id): id is string => id !== null),
	};
}
function dispatchValue(
	communicationId: string,
	members: readonly Member[],
	providerCalls: number,
	status: "accepted" | "partial" | "uncertain" | "failed" | "accepted_unknown",
) {
	const tally = counts(members);
	const failed = tally.acceptedCount === 0 && tally.unknownCount === 0;
	const uncertain = status !== "accepted_unknown" && tally.acceptedCount === 0 && tally.unknownCount > 0;
	const resolved =
		status === "accepted_unknown"
			? "accepted_unknown"
			: failed
				? "failed"
				: uncertain
					? "uncertain"
					: tally.unknownCount > 0 || tally.rejectedCount > 0
						? "partial"
						: "accepted";
	return c.dispatchResult.parse({
		communicationId,
		sentAt: null,
		...tally,
		uncertain,
		failed,
		providerCalls,
		replayedWithNewKeys: 0,
		automaticReplayAllowed: false,
		negativeEvidenceRequired: tally.unknownCount > 0 || status === "accepted_unknown",
		firstDispatchClockReset: false,
		crossScopeBatchAllowed: false,
		status: resolved,
		confirmedRecipientIds: tally.confirmedRecipientIds,
	});
}

type Loaded = {
	allowed: boolean;
	id: string | null;
	revision: string | null;
	state: string | null;
	subject: string | null;
	body_html: string | null;
	body_text: string | null;
	audience: unknown;
	review_digest: string | null;
	scheduled_at: string | null;
	people: unknown;
	foreign_people: number | null;
	request_id: string | null;
	provider_key: string | null;
	attempt_id: string | null;
	attempt_outcome: string | null;
	first_at: string | null;
	members: unknown;
	meeting_id: string | null;
	meeting_open: boolean | null;
	guests: unknown;
	church_name: string | null;
};

const loadedSchema = z.object({
	allowed: z.boolean(),
	id: z.uuid().nullable(),
	revision: z.string().nullable(),
	state: z.string().nullable(),
	subject: z.string().nullable(),
	body_html: z.string().nullable(),
	body_text: z.string().nullable(),
	audience: z.unknown().nullable(),
	review_digest: z.string().nullable(),
	scheduled_at: z.string().nullable(),
	people: z.unknown().nullable(),
	foreign_people: z.coerce.number().int().nullable(),
	request_id: z.uuid().nullable(),
	provider_key: z.string().nullable(),
	attempt_id: z.uuid().nullable(),
	attempt_outcome: z.string().nullable(),
	first_at: z.string().nullable(),
	members: z.unknown().nullable(),
	meeting_id: z.uuid().nullable(),
	meeting_open: z.boolean().nullable(),
	guests: z.unknown().nullable(),
	church_name: z.string().nullable(),
});

async function loadAudience(db: Database, actor: Actor, communicationId: string): Promise<Loaded> {
	const gate = adminGate(actor);
	const raw = one(
		await db.execute(sql`SELECT g.allowed, c.id, c.revision::text AS revision, c.state, c.subject, c.body_html, c.body_text,
			c.audience, c.review_digest, c.meeting_id,
			(SELECT pl.name FROM plant pl WHERE pl.id = c.plant_id) AS church_name,
			CASE WHEN c.meeting_id IS NULL THEN false ELSE EXISTS (
				SELECT 1 FROM meeting mt WHERE mt.id = c.meeting_id AND mt.plant_id = c.plant_id AND ${meetingOpenSql("mt")}
			) END AS meeting_open,
			CASE WHEN c.meeting_id IS NULL THEN '[]'::jsonb ELSE (
				SELECT coalesce(jsonb_agg(pt.person_id), '[]'::jsonb) FROM participation pt
				WHERE pt.meeting_id = c.meeting_id AND pt.plant_id = c.plant_id AND pt.removed_at IS NULL
			) END AS guests,
			to_char(c.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_at,
			'[]'::jsonb AS people,
			CASE WHEN c.id IS NULL THEN 0 ELSE (
				SELECT count(*)::int FROM jsonb_array_elements_text(coalesce(c.audience->'personIds', '[]'::jsonb)) e(value)
				WHERE NOT EXISTS (
					SELECT 1 FROM person p
					WHERE p.id = e.value::uuid AND p.plant_id = c.plant_id AND p.tenant_id = c.plant_id AND p.state = 'live'
				)
			) END AS foreign_people,
			r.id AS request_id, r.provider_key, a.id AS attempt_id, a.outcome AS attempt_outcome,
			to_char(r.first_dispatched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_at,
			CASE WHEN r.id IS NULL THEN '[]'::jsonb ELSE (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'position', mem.position, 'state', m.state, 'personId', m.recipient_person_id, 'provider', m.provider_message_id,
					'scheduledAt', to_char(m.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
					'cancelRequested', m.cancel_requested_at IS NOT NULL, 'unsubscribed', m.refusal IS NOT DISTINCT FROM 'unsubscribed'
				) ORDER BY mem.position), '[]'::jsonb)
				FROM mail_request_member mem
				JOIN mail m ON m.id = mem.mail_id
				WHERE mem.request_id = r.id
			) END AS members
		FROM (SELECT ${gate} AS allowed) g
		LEFT JOIN LATERAL (
			SELECT * FROM communication c
			WHERE g.allowed AND c.id = ${communicationId}::uuid AND c.plant_id = ${actor.plantId}::uuid
		) c ON true
		LEFT JOIN LATERAL (
			SELECT r.id, r.provider_key, r.first_dispatched_at
			FROM mail m
			JOIN mail_request_member mem ON mem.mail_id = m.id AND mem.tenant_id = m.tenant_id
			JOIN mail_request r ON r.id = mem.request_id
			WHERE c.id IS NOT NULL AND m.tenant_id = c.plant_id AND m.logical_key LIKE ${prefix(communicationId)}
			ORDER BY r.first_dispatched_at NULLS LAST, r.id
			LIMIT 1
		) r ON true
		LEFT JOIN mail_attempt a ON a.request_id = r.id AND a.attempt_number = 1`),
	);
	return loadedSchema.parse(raw ?? { allowed: false });
}

function membersOf(raw: unknown): Member[] {
	return z
		.array(
			z.object({
				position: z.number().int(),
				state: z.string(),
				personId: z.uuid().nullable(),
				provider: z.string().nullable(),
				scheduledAt: z.string().nullable(),
				cancelRequested: z.boolean(),
				unsubscribed: z.boolean(),
			}),
		)
		.parse(asJson(raw) ?? []);
}

async function openLoaded(db: Database, actor: Actor, communicationId: string, expectedRevision: string) {
	const found = loadedSchema.parse(await loadAudience(db, actor, communicationId));
	if (found.allowed !== true) deny("access_denied");
	if (!found.id) deny("not_found");
	if (found.revision !== expectedRevision || found.state !== "scheduled") deny("conflict");
	if (!found.subject || !found.body_html) deny("invalid_input");
	if ((found.foreign_people ?? 0) > 0) deny("access_denied");
	const audience = c.audienceInput.parse(asJson(found.audience) ?? { groups: [], teamIds: [], personIds: [] });
	// The audience resolves under the same gate, so a seat or lifecycle that changed since the load reads no one.
	const resolved = one(
		await db.execute(sql`SELECT g.allowed, q.people FROM (SELECT ${adminGate(actor)} AS allowed) g
			LEFT JOIN LATERAL (SELECT ${audiencePeople(actor.plantId, audience)} AS people) q ON g.allowed`),
	) as { allowed?: boolean; people?: unknown } | undefined;
	if (resolved?.allowed !== true) deny("access_denied");
	const people = resolved.people ?? [];
	const parts = reviewedParts(people);
	if (!parts.people.length) deny("invalid_input");
	if (parts.people.length > BATCH_LIMIT) deny("invalid_input");
	const digest = hash({ subject: found.subject, body: found.body_html, people: parts.people, emails: parts.emails });
	if (found.review_digest !== digest)
		deny("stale_review", { previewBody: found.body_html, scriptExecution: false, providerCalls: 0 });
	return { found: { ...found, people }, audience, parts, digest };
}

type Prepared =
	| { kind: "resume"; requestId: string; attemptId: string; providerKey: string; members: Member[] }
	| {
			kind: "send";
			requestId: string;
			attemptId: string;
			providerKey: string;
			messages: DeliveryMessage[];
			members: Member[];
	  }
	| { kind: "done"; members: Member[] };

async function prepare(
	db: Database,
	actor: Actor,
	loaded: Awaited<ReturnType<typeof openLoaded>>,
	keys: ReturnType<typeof keysOf>,
	mode: Mode,
	/** The send time the email service holds for a scheduled handoff; null for send now. */
	heldUntil: string | null,
): Promise<Prepared> {
	const { found } = loaded;
	if (found.request_id && found.provider_key && found.attempt_id) {
		return {
			kind: "resume",
			requestId: found.request_id,
			attemptId: found.attempt_id,
			providerKey: found.provider_key,
			members: membersOf(found.members),
		};
	}
	if (mode === "lookup") deny("not_found");
	// A message with an RSVP link needs an open meeting whose guest list the links come from.
	const linked = usesRsvpLink(found.body_html);
	// A link needs an https origin; without one the field renders nothing and no token is minted.
	const canLink = linked && new URL(keys.origin).protocol === "https:";
	if (linked && (!found.meeting_id || !found.meeting_open)) deny("rsvp_needs_meeting");
	const guests = new Set(z.array(z.uuid()).parse(asJson(found.guests) ?? []));
	const people = z
		.array(z.object({ id: z.uuid(), email: z.string().nullable(), displayName: z.string(), n: z.number() }))
		.parse(asJson(found.people) ?? [])
		.filter((row) => row.email?.trim())
		.sort((a, b) => a.id.localeCompare(b.id));
	const seen = new Set<string>();
	const unique = people.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
	const rows = unique.map((person, position) => {
		const address = person.email!.trim().toLowerCase();
		const id = randomUUID();
		// Each recipient gets their own message. The raw token lives only in this message and the provider call.
		const token = canLink && guests.has(person.id) ? newRsvpToken() : null;
		const merge: Record<MergeKey, string> = {
			name: person.displayName,
			rsvp_link: token ? `${keys.origin}/rsvp/${token}` : "",
		};
		// The Unsubscribe link names this church and this Person. Its token is the same on every render.
		const unsubscribe = keys.optOutKeys
			? `${keys.origin}/unsubscribe/${messagesOptOutToken(keys.optOutKeys, { plantId: actor.plantId, personId: person.id })}`
			: null;
		const html = renderEmailHtml(found.body_html!, merge, {
			churchName: found.church_name ?? "",
			...(unsubscribe ? { unsubscribeUrl: unsubscribe } : {}),
		});
		const body = plainText(renderBody(found.body_html!, merge)) || found.subject!;
		const text = unsubscribe ? `${body}\n\n--\nUnsubscribe: ${unsubscribe}` : body;
		const headers = unsubscribe
			? { "List-Unsubscribe": `<${unsubscribe}/one-click>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
			: undefined;
		const payloadHash = hash({
			purpose: "communication",
			personId: person.id,
			address,
			subject: found.subject,
			body: html,
			from: keys.from,
			...(headers ? { headers } : {}),
		});
		return {
			id,
			person: person.id,
			logical_key: `communication/${found.id}/${person.id}`,
			payload_hash: payloadHash,
			token_hash: token ? rsvpTokenDigest(token) : null,
			html,
			text,
			headers,
			address_hash: addressHash(keys.addressKey, address),
			payload: {
				v: 1,
				sealed: seal(
					keys.encryptionKey,
					JSON.stringify({ subject: found.subject, text, html, from: keys.from, ...(headers ? { headers } : {}) }),
					`${actor.plantId}/${id}/communication`,
				),
			},
			address: seal(keys.encryptionKey, address, `${actor.plantId}/${id}/address`),
			position,
			to: address,
		};
	});
	const requestHash = hash(rows.map((row) => row.payload_hash));
	const providerKey = `communication/${found.id}/${requestHash}`;
	const requestId = randomUUID();
	const attemptId = randomUUID();
	// One set-based token write in the same statement as the mail rows, for the guests whose message carries a link.
	const minted = found.meeting_id !== null && rows.some((row) => row.token_hash !== null);
	// A scheduled handoff waits in Everyfield: the minute runner hands it to the email service at its send time
	// (runDueScheduled), so an opt-out until then always wins (T-241).
	const waiting = mode === "scheduled" ? "scheduled" : "dispatched";
	const tokens = minted
		? sql`,
			ins_tok AS (${rsvpTokenUpdate(
				actor.plantId,
				found.meeting_id!,
				sql`(SELECT i.person AS person_id, i.token_hash FROM input i JOIN ins_mail m ON m.id = i.id AND m.state IN ('dispatched', 'scheduled')
					WHERE i.token_hash IS NOT NULL)`,
			)})`
		: sql``;
	const issued = minted ? sql`(SELECT count(*) FROM ins_tok)` : sql`0`;
	const stored = one(
		await db.execute(sql`WITH gate AS (SELECT ${adminGate(actor)} AS allowed),
			input AS (
				SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows.map(({ id, person, logical_key, payload_hash, token_hash, address_hash, payload, address, position }) => ({ id, person, logical_key, payload_hash, token_hash, address_hash, payload, address, position })))}::jsonb) AS i(
					id uuid, person uuid, logical_key text, payload_hash text, token_hash text, address_hash text, payload jsonb, address text, position int
				)
			),
			ins_mail AS (
				INSERT INTO mail (id, tenant_id, recipient_person_id, purpose, logical_key, payload_hash, audience_hash,
					frozen_payload, recipient_address_encrypted, address_hash, state, created_at, scheduled_at, refusal)
				SELECT i.id, ${actor.plantId}::uuid, i.person, 'communication', i.logical_key, i.payload_hash, ${loaded.digest},
					i.payload, i.address, i.address_hash,
					CASE WHEN i.unsubscribed OR EXISTS (
						SELECT 1 FROM suppression s WHERE s.address_hash = i.address_hash AND s.cleared_at IS NULL
					) THEN 'refused' ELSE ${waiting} END,
					clock_timestamp(), ${heldUntil}::timestamptz,
					-- The person's own opt-out from this church, not the address, decides this refusal (D-284).
					CASE WHEN i.unsubscribed THEN 'unsubscribed' END
				FROM (SELECT i.*, ${optedOutSql(sql`${actor.plantId}::uuid`, sql`i.person`)} AS unsubscribed FROM input i) i
				JOIN gate g ON g.allowed
				WHERE EXISTS (
					SELECT 1 FROM communication c
					WHERE c.id = ${found.id}::uuid AND c.plant_id = ${actor.plantId}::uuid AND c.state = 'scheduled'
					AND c.revision = ${found.revision}::bigint AND c.review_digest = ${loaded.digest}
				)
				RETURNING id, state, refusal
			)${tokens},
			ins_req AS (
				INSERT INTO mail_request (id, tenant_id, provider_key, request_hash, first_dispatched_at)
				SELECT ${requestId}::uuid, ${actor.plantId}::uuid, ${providerKey}, ${requestHash}, clock_timestamp()
				FROM gate g
				WHERE g.allowed AND EXISTS (SELECT 1 FROM ins_mail)
				RETURNING id
			),
			ins_mem AS (
				INSERT INTO mail_request_member (request_id, tenant_id, mail_id, position)
				SELECT r.id, ${actor.plantId}::uuid, m.id, i.position
				FROM ins_req r
				JOIN ins_mail m ON true
				JOIN input i ON i.id = m.id
				RETURNING mail_id
			),
			ins_attempt AS (
				INSERT INTO mail_attempt (id, tenant_id, request_id, attempt_number, claim_generation, started_at, outcome, completed_at)
				SELECT ${attemptId}::uuid, ${actor.plantId}::uuid, r.id, 1, 1, clock_timestamp(),
					CASE WHEN bool_or(m.state IN ('dispatched', 'scheduled')) THEN 'in_flight' ELSE 'refused' END,
					CASE WHEN bool_or(m.state IN ('dispatched', 'scheduled')) THEN NULL ELSE clock_timestamp() END
				FROM ins_req r
				JOIN ins_mail m ON true
				GROUP BY r.id
				RETURNING outcome
			),
			ins_audit AS (
				INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
				SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'communication.send_intended', 'outcome', 'record',
					${found.id}::uuid, ${"dispatch/" + providerKey}, '{}'::jsonb,
					jsonb_build_object('recipients', (SELECT count(*) FROM ins_mail), 'rsvpLinks', ${issued})
				WHERE EXISTS (SELECT 1 FROM ins_mail)
				ON CONFLICT (subject_id, event_key) DO NOTHING
				RETURNING id
			)
			SELECT (SELECT allowed FROM gate) AS allowed,
				(SELECT outcome FROM ins_attempt) AS outcome,
				coalesce((SELECT jsonb_agg(jsonb_build_object('position', i.position, 'state', m.state, 'personId', i.person, 'provider', NULL,
					'scheduledAt', ${heldUntil}::text, 'cancelRequested', false, 'unsubscribed', m.refusal IS NOT NULL) ORDER BY i.position)
					FROM ins_mail m JOIN input i ON i.id = m.id), '[]'::jsonb) AS members,
				(SELECT count(*) FROM ins_mem) AS members_written,
				(SELECT count(*) FROM ins_audit) AS audits`),
	) as { allowed: boolean; outcome: string | null; members: unknown };
	if (stored?.allowed !== true) deny("access_denied");
	const members = membersOf(stored.members);
	if (!members.length || !stored.outcome) deny("conflict");
	const messages = rows
		.filter((row) => members.find((member) => member.position === row.position)?.state === "dispatched")
		.map((row) => ({
			to: row.to,
			subject: found.subject!,
			html: row.html,
			text: row.text,
			...(row.headers ? { headers: row.headers } : {}),
		}));
	if (stored.outcome === "refused" || messages.length === 0) return { kind: "done", members };
	return { kind: "send", requestId, attemptId, providerKey, messages, members };
}

/**
 * Who records an outcome: a staff member's live seat for a handoff they asked for, or the minute runner for a scheduled
 * email at its send time. The runner has no session; its gate is that the church is not being deleted.
 */
type Recorder = { plantId: string; gate: SQL; actorId: string | null };
const staff = (actor: Actor): Recorder => ({
	plantId: actor.plantId,
	gate: adminGate(actor),
	actorId: actor.accountId,
});

async function record(
	db: Database,
	who: Recorder,
	communicationId: string,
	requestId: string,
	attemptId: string,
	updates: readonly { position: number; outcome: "accepted" | "refused" | "unknown"; providerId: string | null }[],
	base: readonly Member[],
) {
	const outcome = combined(base, updates);
	const action = outcome === "accepted" ? "mail.accepted" : outcome === "refused" ? "mail.refused" : "mail.reconciled";
	const recorded = updates.map((row) => ({
		position: row.position,
		outcome: row.outcome,
		provider_id: row.providerId,
	}));
	await db.execute(sql`WITH input AS (
		SELECT * FROM jsonb_to_recordset(${JSON.stringify(recorded)}::jsonb) AS x(position int, outcome text, provider_id text)
	), updated AS (
		UPDATE mail m SET
			state = CASE x.outcome WHEN 'accepted' THEN 'accepted' WHEN 'refused' THEN 'refused' ELSE 'unknown' END,
			provider_message_id = CASE WHEN x.outcome = 'accepted' THEN x.provider_id ELSE m.provider_message_id END,
			accepted_at = CASE WHEN x.outcome = 'accepted' AND m.accepted_at IS NULL THEN clock_timestamp() ELSE m.accepted_at END
		FROM mail_request_member mem
		JOIN input x ON x.position = mem.position
		WHERE mem.request_id = ${requestId}::uuid AND mem.tenant_id = ${who.plantId}::uuid
			AND mem.mail_id = m.id AND m.state IN ('dispatched', 'unknown')
			AND ${who.gate}
		RETURNING m.id
	), attempt AS (
		UPDATE mail_attempt SET outcome = ${outcome}, completed_at = clock_timestamp()
		WHERE id = ${attemptId}::uuid AND tenant_id = ${who.plantId}::uuid AND ${who.gate}
		AND (EXISTS (SELECT 1 FROM updated) OR NOT EXISTS (SELECT 1 FROM input))
		RETURNING id
	)
	INSERT INTO audit_event (tenant_id, actor_id, system_cause, action, kind, subject_type, subject_id, event_key, metadata, after_value)
	SELECT ${who.plantId}::uuid, ${who.actorId}::uuid, CASE WHEN ${who.actorId}::uuid IS NULL THEN 'mail_transport' END, ${action}, 'outcome', 'record', ${communicationId}::uuid,
		${"outcome/" + requestId + "/" + outcome}, '{}'::jsonb, jsonb_build_object('outcome', ${outcome}::text)
	WHERE EXISTS (SELECT 1 FROM attempt)
	ON CONFLICT (subject_id, event_key) DO NOTHING`);
}

function combined(
	base: readonly Member[],
	updates: readonly { position: number; outcome: "accepted" | "refused" | "unknown" }[],
) {
	const next = new Map(updates.map((row) => [row.position, row.outcome]));
	const states = base.map((row) => next.get(row.position) ?? row.state);
	if (states.length && states.every((state) => state === "accepted" || state === "sent")) return "accepted";
	if (states.length && states.every((state) => state === "refused" || state === "failed" || state === "cancelled"))
		return "refused";
	if (states.some((state) => state === "accepted" || state === "sent")) return "partial";
	return "unknown";
}

function applyIds(batch: DeliveryBatch, positions: readonly number[], align: "compressed" | "absolute") {
	if (batch.outcome === "unknown")
		return positions.map((position) => ({ position, outcome: "unknown" as const, providerId: null }));
	if (batch.outcome === "refused")
		return positions.map((position) => ({ position, outcome: "refused" as const, providerId: null }));
	return positions.map((position, index) => {
		// A send list is only the dispatched rows. A lookup list keeps the original member position.
		const id = batch.ids[align === "absolute" ? position : index];
		return id
			? { position, outcome: "accepted" as const, providerId: id }
			: { position, outcome: "unknown" as const, providerId: null };
	});
}

async function handoff(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
	mode: Mode,
) {
	const input = parse(c.dispatchRequest, raw);
	const actor = requireActor(authority);
	const opened = await openLoaded(db, actor, input.input.communicationId, input.expectedRevision);
	const ready = keysOf(keys);
	// The email service holds a scheduled email for at most 30 days and sends a past time at once. A scheduled
	// handoff stores the held time on each recipient row; a send-now handoff stores none.
	const heldUntil = mode === "scheduled" ? opened.found.scheduled_at : null;
	if (mode === "scheduled" && (!heldUntil || !scheduleAccepted(new Date(), new Date(heldUntil))))
		deny("schedule_window_exceeded", { providerHandoffs: 0 });
	const prepared = await prepare(db, actor, opened, ready, mode, heldUntil);
	if (prepared.kind === "done") return dispatchValue(input.input.communicationId, prepared.members, 0, "failed");
	const open = prepared.members.filter((row) => row.state === "dispatched" || row.state === "unknown");
	if (!open.length) return dispatchValue(input.input.communicationId, prepared.members, 0, "accepted");
	let batch: DeliveryBatch;
	let providerCalls = 0;
	try {
		if (prepared.kind === "send") {
			providerCalls = 1;
			batch = await transport.send(
				{ key: prepared.providerKey, messages: prepared.messages, scheduledAt: heldUntil },
				signal(),
			);
		} else {
			batch = await transport.lookup(prepared.providerKey, signal());
		}
	} catch {
		return dispatchValue(input.input.communicationId, prepared.members, providerCalls, "accepted_unknown");
	}
	const positions =
		prepared.kind === "send"
			? prepared.members.filter((row) => row.state === "dispatched").map((row) => row.position)
			: open.map((row) => row.position);
	const updates = applyIds(batch, positions, prepared.kind === "resume" ? "absolute" : "compressed");
	await record(
		db,
		staff(actor),
		input.input.communicationId,
		prepared.requestId,
		prepared.attemptId,
		updates,
		prepared.members,
	);
	const next = prepared.members.map((row) => {
		const update = updates.find((item) => item.position === row.position);
		return update
			? { ...row, state: update.outcome === "accepted" ? "accepted" : update.outcome, provider: update.providerId }
			: row;
	});
	return dispatchValue(input.input.communicationId, next, providerCalls, "accepted");
}

/** Hand a scheduled message to the email service now: it goes out at once. */
export function dispatchReviewed(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	return readReply(() => handoff(db, authority, raw, transport, keys, "now"));
}
/** Hand a scheduled message to the email service with its send time; the email service holds it until then. */
export function handOffScheduled(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	return readReply(() => handoff(db, authority, raw, transport, keys, "scheduled"));
}
export function reconcileReviewed(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	return readReply(() => handoff(db, authority, raw, transport, keys, "lookup"));
}

type Answer = { position: number; outcome: Exclude<ProviderAnswer["outcome"], "unknown"> };

async function loadHandoff(db: Database, actor: Actor, communicationId: string, expectedRevision: string) {
	const found = await loadAudience(db, actor, communicationId);
	if (found.allowed !== true) deny("access_denied");
	if (!found.id) deny("not_found");
	if (found.revision !== expectedRevision) deny("conflict");
	return { found, members: membersOf(found.members) };
}

/**
 * Ask about every open recipient that has its own email-service id, in one transport call. A failed or missing
 * answer leaves the recipient open.
 */
async function askEach(
	open: readonly Member[],
	ask: (providerIds: readonly string[]) => Promise<readonly ProviderAnswer[]>,
): Promise<Answer[]> {
	const asked = open.filter((row) => row.provider !== null);
	if (!asked.length) return [];
	let replies: readonly ProviderAnswer[];
	try {
		replies = await ask(asked.map((row) => row.provider!));
	} catch {
		return [];
	}
	return asked.flatMap((row, index): Answer[] => {
		const outcome = replies[index]?.outcome ?? "unknown";
		return outcome === "unknown" ? [] : [{ position: row.position, outcome }];
	});
}

/**
 * The confirmed answers and their audit row in one statement. `done` is a confirmed cancel, or the new send time when
 * `movedTo` is set; `sent` means the email already went out. A second run over the same answers changes no row and so
 * writes no audit row.
 */
async function recordAnswers(
	db: Database,
	actor: Actor,
	communicationId: string,
	requestId: string,
	answers: readonly Answer[],
	movedTo: string | null,
	audit: { eventKey: string; after: Record<string, number | string> },
) {
	const cancel = movedTo === null;
	await db.execute(sql`WITH input AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(answers)}::jsonb) AS x(position int, outcome text)
		), updated AS (
			UPDATE mail m SET
				state = CASE WHEN x.outcome = 'sent' THEN 'sent' WHEN ${cancel}::boolean THEN 'cancelled' ELSE m.state END,
				cancel_confirmed_at = CASE WHEN x.outcome = 'done' AND ${cancel}::boolean
					THEN coalesce(m.cancel_confirmed_at, clock_timestamp()) ELSE m.cancel_confirmed_at END,
				scheduled_at = CASE WHEN x.outcome = 'done' AND NOT ${cancel}::boolean
					THEN ${movedTo}::timestamptz ELSE m.scheduled_at END,
				sent_at = CASE WHEN x.outcome = 'sent' THEN coalesce(m.sent_at, clock_timestamp()) ELSE m.sent_at END
			FROM mail_request_member mem
			JOIN input x ON x.position = mem.position
			WHERE mem.request_id = ${requestId}::uuid AND mem.tenant_id = ${actor.plantId}::uuid AND mem.mail_id = m.id
				AND m.state IN ('accepted', 'unknown', 'dispatched') AND ${adminGate(actor)}
			RETURNING m.id
		)
		INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
		SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'mail.reconciled', 'outcome', 'record', ${communicationId}::uuid,
			${audit.eventKey}, '{}'::jsonb, ${JSON.stringify(audit.after)}::jsonb
		WHERE EXISTS (SELECT 1 FROM updated)
		ON CONFLICT (subject_id, event_key) DO NOTHING`);
}

function answered(members: readonly Member[], answers: readonly Answer[], done: (row: Member) => Member) {
	const byPosition = new Map(answers.map((answer) => [answer.position, answer.outcome]));
	return members.map((row) => {
		const outcome = byPosition.get(row.position);
		if (!outcome) return row;
		return outcome === "sent" ? { ...row, state: "sent" } : done(row);
	});
}

/**
 * Cancel a scheduled message. Recipients still waiting in Everyfield are cancelled at once. An email the email
 * service already holds is cancelled there, one recipient at a time by its own id. The message counts as
 * cancelled only when no recipient is open. A run asks only about open recipients, so a check after the cancel is
 * confirmed sends nothing and writes nothing.
 */
export function cancelScheduled(db: Database, authority: RequestActor, raw: unknown, transport: DeliveryTransport) {
	return readReply(async () => {
		const input = parse(c.cancelScheduledRequest, raw);
		const actor = requireActor(authority);
		const { found, members } = await loadHandoff(db, actor, input.input.communicationId, input.expectedRevision);
		const open = members.filter(holding);
		let next = members;
		// Recipients still waiting in Everyfield are cancelled at once: the email service never had them.
		const local = members.filter(waiting);
		if (found.request_id && local.length) {
			await db.execute(sql`WITH updated AS (
					UPDATE mail m SET state = 'cancelled', cancel_requested_at = coalesce(m.cancel_requested_at, clock_timestamp()),
						cancel_confirmed_at = clock_timestamp()
					FROM mail_request_member mem
					WHERE mem.request_id = ${found.request_id}::uuid AND mem.tenant_id = ${actor.plantId}::uuid
						AND mem.mail_id = m.id AND m.state = 'scheduled' AND ${adminGate(actor)}
					RETURNING m.id
				)
				INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
				SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'mail.cancelled', 'outcome', 'record', ${found.id}::uuid,
					${"cancel-waiting/" + found.id}, '{}'::jsonb, jsonb_build_object('cancelled', (SELECT count(*) FROM updated))
				WHERE EXISTS (SELECT 1 FROM updated)
				ON CONFLICT (subject_id, event_key) DO NOTHING`);
			next = next.map((row) => (waiting(row) ? { ...row, state: "cancelled" } : row));
		}
		if (found.request_id && open.length) {
			// The request is stored before the calls, so a lost answer still shows as a cancel not confirmed.
			if (open.some((row) => !row.cancelRequested))
				await db.execute(sql`WITH updated AS (
						UPDATE mail m SET cancel_requested_at = clock_timestamp()
						FROM mail_request_member mem
						WHERE mem.request_id = ${found.request_id}::uuid AND mem.tenant_id = ${actor.plantId}::uuid
							AND mem.mail_id = m.id AND m.state IN ('accepted', 'unknown', 'dispatched')
							AND m.cancel_requested_at IS NULL AND ${adminGate(actor)}
						RETURNING m.id
					)
					INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
					SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'mail.cancelled', 'outcome', 'record', ${found.id}::uuid,
						${"cancel-request/" + found.id}, '{}'::jsonb, jsonb_build_object('requested', (SELECT count(*) FROM updated))
					WHERE EXISTS (SELECT 1 FROM updated)
					ON CONFLICT (subject_id, event_key) DO NOTHING`);
			const answers = await askEach(open, (providerIds) => transport.cancel(providerIds, signal()));
			next = answered(next, answers, (row) => ({ ...row, state: "cancelled" }));
			if (answers.length) {
				const openCount = next.filter(holding).length;
				await recordAnswers(db, actor, found.id!, found.request_id, answers, null, {
					eventKey: openCount === 0 ? `cancel-confirmed/${found.id}` : `cancel-check/${input.requestKey}`,
					after: {
						cancelled: answers.filter((answer) => answer.outcome === "done").length,
						sent: answers.filter((answer) => answer.outcome === "sent").length,
						open: openCount,
					},
				});
			}
		}
		const held = local.length > 0 || next.some((row) => row.provider !== null || holding(row));
		const openCount = next.filter(holding).length;
		return c.cancelScheduledResult.parse({
			newHandoffs: 0,
			scheduledCancel: !held ? "none" : openCount > 0 ? "reconcile" : "confirmed",
			sentRecalled: false,
			cancelRequested: open.length + local.length > 0,
			recallGuaranteed: false,
			newSend: false,
			existingUrlMayWorkUntil: input.input.signedUrlExpires ?? null,
			confirmedCount: next.filter((row) => row.state === "cancelled").length,
			sentCount: next.filter((row) => row.state === "sent").length,
			openCount,
		});
	});
}

/** A replacement may start only when the email service holds no recipient of the earlier message. */
export function replaceScheduled(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(c.replaceScheduledRequest, raw);
		const actor = requireActor(authority);
		const found = await loadAudience(db, actor, input.input.communicationId);
		if (found.allowed !== true) deny("access_denied");
		if (!found.id) deny("not_found");
		const members = membersOf(found.members);
		const replacementAllowed =
			members.some((row) => row.state === "cancelled") &&
			members.every((row) => row.state === "cancelled" || row.state === "refused" || row.state === "failed");
		return c.replaceScheduledResult.parse({ replacementAllowed, replacementIntents: 0, blindResends: 0 });
	});
}

/**
 * Change the send time. Before a scheduled handoff, and for recipients still waiting in Everyfield, only the saved
 * time changes. For an email the email service already holds (handed off before T-241), each accepted recipient
 * moves by its own email-service id; history shows the new time only when every one of them holds it. Running it
 * again with the same time asks only about recipients that still hold the old time.
 */
export function rescheduleDispatched(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
) {
	return readReply(async () => {
		const input = parse(c.scheduleRequest, raw);
		const actor = requireActor(authority);
		const at = new Date(input.input.scheduledAt);
		if (!scheduleAccepted(new Date(), at)) deny("schedule_window_exceeded", { providerHandoffs: 0 });
		const { found, members } = await loadHandoff(db, actor, input.input.communicationId, input.expectedRevision);
		if (!found.body_html) deny("not_found");
		if (found.state !== "scheduled") deny("conflict");
		const requested = at.toISOString();
		if (found.scheduled_at !== requested)
			await db.execute(sql`WITH updated AS (
					UPDATE communication SET scheduled_at = ${requested}::timestamptz,
						revision = revision + 1, updated_at = clock_timestamp()
					WHERE id = ${found.id}::uuid AND plant_id = ${actor.plantId}::uuid AND state = 'scheduled'
					AND revision = ${found.revision}::bigint AND ${adminGate(actor)}
					RETURNING id
				), waiting AS (
					-- Recipients Everyfield still holds move with the saved time; the email service never had them.
					UPDATE mail m SET scheduled_at = ${requested}::timestamptz
					FROM mail_request_member mem
					WHERE mem.request_id = ${found.request_id}::uuid AND mem.tenant_id = ${actor.plantId}::uuid
						AND mem.mail_id = m.id AND m.state = 'scheduled' AND EXISTS (SELECT 1 FROM updated)
					RETURNING m.id
				)
				INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, before_value, after_value)
				SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'communication.rescheduled', 'edit', 'record', ${found.id}::uuid,
					${"reschedule/" + input.requestKey}, '{}'::jsonb, jsonb_build_object('scheduled_at', ${found.scheduled_at}::text),
					jsonb_build_object('scheduled_at', ${requested}::text)
				FROM updated
				ON CONFLICT (subject_id, event_key) DO NOTHING`);
		// Accepted recipients the email service still holds at another time.
		const holdsOther = (row: Member) =>
			row.state === "accepted" && row.scheduledAt !== null && row.scheduledAt !== requested;
		const open = members.filter(holdsOther);
		let next = members;
		if (found.request_id && open.length) {
			const answers = await askEach(open, (providerIds) => transport.reschedule(providerIds, requested, signal()));
			next = answered(members, answers, (row) => ({ ...row, scheduledAt: requested }));
			if (answers.length) {
				const left = open.length - answers.length;
				await recordAnswers(db, actor, found.id!, found.request_id, answers, requested, {
					eventKey: left === 0 ? `time-confirmed/${found.id}/${requested}` : `time-check/${input.requestKey}`,
					after: {
						scheduled_at: requested,
						moved: answers.filter((answer) => answer.outcome === "done").length,
						sent: answers.filter((answer) => answer.outcome === "sent").length,
						open: left,
					},
				});
			}
		}
		const still = next.filter(holdsOther);
		return c.rescheduleDispatchedResult.parse({
			body: found.body_text ?? found.body_html,
			rescheduleStatus: still.length ? "unknown" : "accepted",
			newCommunications: 0,
			scheduledAt: requested,
			heldAt: still.map((row) => row.scheduledAt!).sort()[0] ?? null,
			confirmedCount: next.filter((row) => waiting(row) || (row.state === "accepted" && row.scheduledAt === requested))
				.length,
			sentCount: next.filter((row) => row.state === "sent").length,
			openCount: still.length,
		});
	});
}

async function accountEmail(db: Database, actor: Actor) {
	const row = one(
		await db.execute(sql`SELECT g.allowed, u.email
			FROM (SELECT ${adminGate(actor)} AS allowed) g
			LEFT JOIN LATERAL (
				SELECT c.email FROM access_account_contact(${actor.accountId}::uuid) c
				WHERE g.allowed AND c.verified
			) u ON true`),
	) as { allowed?: boolean; email?: string | null };
	if (row?.allowed !== true || !row.email) deny("access_denied");
	return row.email.trim().toLowerCase();
}

export function listOwnSuppression(db: Database, authority: RequestActor, raw: unknown, keys: DeliveryKeys) {
	return readReply(async () => {
		const input = parse(c.listSuppressionRequest, raw);
		const actor = requireActor(authority);
		const ready = keysOf(keys);
		const email = await accountEmail(db, actor);
		if (input.address.trim().toLowerCase() !== email) deny("access_denied");
		const hashValue = addressHash(ready.addressKey, email);
		// The block and every earlier restore of this one address in one statement, at any number of restores. The
		// restorer's name is the Person their account links to in the church where they restored it.
		const row = one(
			await db.execute(sql`SELECT s.id IS NOT NULL AND s.cleared_at IS NULL AS active,
				coalesce((
					SELECT jsonb_agg(jsonb_build_object(
						'at', to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
						'actorName', (SELECT p.display_name FROM person p
							WHERE p.linked_account_id = a.actor_id AND p.tenant_id = a.tenant_id AND p.state = 'live'
							ORDER BY p.id LIMIT 1),
						'reason', a.reason
					) ORDER BY a.occurred_at DESC, a.id DESC)
					FROM audit_event a WHERE a.subject_id = s.id AND a.kind = 'suppression_clear' AND a.reason IS NOT NULL
				), '[]'::jsonb) AS restores
				FROM (SELECT 1) seed LEFT JOIN suppression s ON s.address_hash = ${hashValue}`),
		) as { active: boolean; restores: unknown };
		return c.suppressionListResult.parse({
			address: email,
			active: row.active,
			restores: asJson(row.restores),
			suppressionClears: 0,
			newSends: 0,
		});
	});
}

export function restoreOwnSuppression(db: Database, authority: RequestActor, raw: unknown, keys: DeliveryKeys) {
	return readReply(async () => {
		const input = parse(c.restoreSuppressionRequest, raw);
		const actor = requireActor(authority);
		const ready = keysOf(keys);
		const email = await accountEmail(db, actor);
		const address = input.input.address.trim().toLowerCase();
		if (address !== email) deny("access_denied");
		const hashValue = addressHash(ready.addressKey, address);
		const auditId = randomUUID();
		const updated = one(
			await db.execute(sql`WITH updated AS (
					UPDATE suppression SET cleared_at = clock_timestamp(), clear_operation_id = ${auditId}::uuid, revision = revision + 1
					WHERE address_hash = ${hashValue} AND cleared_at IS NULL
					AND ${adminGate(actor)}
					RETURNING id
				), audited AS (
					INSERT INTO audit_event (id, tenant_id, actor_id, action, kind, subject_type, subject_id, reason, event_key, metadata)
					SELECT ${auditId}::uuid, ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'mail.reconciled', 'suppression_clear', 'record',
						updated.id, ${input.input.reason}, ${"suppress/" + input.requestKey}, '{}'::jsonb
					FROM updated
					ON CONFLICT (subject_id, event_key) DO NOTHING
					RETURNING id
				)
				SELECT count(*)::int AS clears FROM updated`),
		) as { clears?: number };
		return c.restoreSuppressionResult.parse({ suppressionClears: updated?.clears ?? 0, newSends: 0 });
	});
}

export function sendTransactionalMail(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	return readReply(async () => {
		const input = parse(c.sendTransactionalRequest, raw);
		const actor = requireActor(authority);
		const ready = keysOf(keys);
		const rendered = renderTransactional(input.input.purpose, input.input.token);
		const address = input.input.address.trim().toLowerCase();
		const id = randomUUID();
		const requestId = randomUUID();
		const attemptId = randomUUID();
		const logical = `password_reset/${actor.accountId}/${input.requestKey}`;
		const payloadHash = hash({ purpose: "password_reset", accountId: actor.accountId, address, from: ready.from });
		const providerKey = `password_reset/${payloadHash}/${input.requestKey}`;
		const sealed = seal(
			ready.encryptionKey,
			JSON.stringify({ subject: rendered.subject, text: rendered.text, html: rendered.html, from: ready.from }),
			`${actor.plantId}/${id}/password_reset`,
		);
		const sealedAddress = seal(ready.encryptionKey, address, `${actor.plantId}/${id}/address`);
		const hashValue = addressHash(ready.addressKey, address);
		const stored = one(
			await db.execute(sql`WITH gate AS (SELECT ${adminGate(actor)} AS allowed),
				ins AS (
					INSERT INTO mail (id, tenant_id, recipient_account_id, purpose, logical_key, payload_hash, audience_hash,
						frozen_payload, recipient_address_encrypted, address_hash, state, created_at)
					SELECT ${id}::uuid, ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'password_reset', ${logical}, ${payloadHash}, ${hashValue},
						${JSON.stringify({ v: 1, sealed })}::jsonb, ${sealedAddress}, ${hashValue}, 'dispatched', clock_timestamp()
					FROM gate g WHERE g.allowed
					ON CONFLICT (tenant_id, logical_key) DO NOTHING
					RETURNING id
				), req AS (
					INSERT INTO mail_request (id, tenant_id, provider_key, request_hash, first_dispatched_at)
					SELECT ${requestId}::uuid, ${actor.plantId}::uuid, ${providerKey}, ${payloadHash}, clock_timestamp()
					FROM ins RETURNING id
				), mem AS (
					INSERT INTO mail_request_member (request_id, tenant_id, mail_id, position)
					SELECT r.id, ${actor.plantId}::uuid, i.id, 0 FROM req r JOIN ins i ON true RETURNING mail_id
				), attempt AS (
					INSERT INTO mail_attempt (id, tenant_id, request_id, attempt_number, claim_generation, started_at, outcome)
					SELECT ${attemptId}::uuid, ${actor.plantId}::uuid, r.id, 1, 1, clock_timestamp(), 'in_flight'
					FROM req r RETURNING id
				), audited AS (
					INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
					SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'communication.send_intended', 'outcome', 'record', i.id,
						${"transactional/" + input.requestKey}, '{}'::jsonb, jsonb_build_object('purpose', 'password_reset')
					FROM ins i
					ON CONFLICT (subject_id, event_key) DO NOTHING
					RETURNING id
				)
				SELECT (SELECT allowed FROM gate) AS allowed, (SELECT count(*)::int FROM ins) AS inserted`),
		) as { allowed?: boolean; inserted?: number };
		if (stored?.allowed !== true) deny("access_denied");
		let deliveryStatus: "unknown" | "accepted" | "refused" = "unknown";
		if ((stored.inserted ?? 0) > 0) {
			try {
				const batch = await transport.send(
					{
						key: providerKey,
						messages: [{ to: address, subject: rendered.subject, html: rendered.html, text: rendered.text }],
						scheduledAt: null,
					},
					signal(),
				);
				deliveryStatus =
					batch.outcome === "ids" && batch.ids[0] ? "accepted" : batch.outcome === "refused" ? "refused" : "unknown";
			} catch {
				deliveryStatus = "unknown";
			}
			const mailState =
				deliveryStatus === "accepted" ? "accepted" : deliveryStatus === "refused" ? "refused" : "unknown";
			await db.execute(sql`UPDATE mail SET state = ${mailState},
				accepted_at = CASE WHEN ${mailState} = 'accepted' THEN clock_timestamp() ELSE accepted_at END
				WHERE id = ${id}::uuid AND tenant_id = ${actor.plantId}::uuid`);
			await db.execute(sql`UPDATE mail_attempt SET outcome = ${deliveryStatus === "accepted" ? "accepted" : deliveryStatus === "refused" ? "refused" : "unknown"},
				completed_at = clock_timestamp() WHERE id = ${attemptId}::uuid`);
		}
		return c.transactionalResult.parse({ purposeMailAttempted: true, deliveryStatus, sentAt: null });
	});
}

/** The church is being deleted: the runner hands off nothing for it and cancels nothing in its name. */
const churchClosing = (tenant: SQL) => sql`EXISTS (SELECT 1 FROM lifecycle_witness w
	WHERE w.opaque_subject_id = ${tenant} AND w.state IN ('pending_deletion', 'purging', 'purged', 'revoked'))`;

const claimedSchema = z.object({
	request_id: z.uuid(),
	tenant_id: z.uuid(),
	provider_key: z.string(),
	attempt_id: z.uuid(),
	communication_id: z.uuid(),
	members: z.array(
		z.object({
			position: z.number().int(),
			id: z.uuid(),
			state: z.string(),
			personId: z.uuid().nullable(),
			unsubscribed: z.boolean(),
			payload: z.object({ v: z.literal(1), sealed: z.string() }).nullable(),
			address: z.string().nullable(),
		}),
	),
});
const sealedMessage = z.object({
	subject: z.string(),
	text: z.string(),
	html: z.string(),
	headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Claim one due scheduled email (every recipient of one handoff, so its batch goes under its own idempotency key) and
 * decide each recipient at the send time, in one statement: a person who unsubscribed from this church, or a blocked
 * address, is refused and never handed off; everyone else is marked sending. Two runners never claim the same email.
 */
async function claimDue(db: Database) {
	const raw = one(
		await db.execute(sql`WITH pick AS MATERIALIZED (
				SELECT mem.request_id FROM mail m
				JOIN mail_request_member mem ON mem.mail_id = m.id AND mem.tenant_id = m.tenant_id
				WHERE m.purpose = 'communication' AND m.state = 'scheduled' AND m.scheduled_at IS NOT NULL
					AND m.scheduled_at <= clock_timestamp() AND NOT ${churchClosing(sql`m.tenant_id`)}
				ORDER BY m.scheduled_at, mem.request_id
				LIMIT 1
			), locked AS MATERIALIZED (
				SELECT r.id, r.tenant_id, r.provider_key FROM mail_request r
				WHERE r.id IN (SELECT request_id FROM pick)
				FOR UPDATE SKIP LOCKED
			), decided AS MATERIALIZED (
				SELECT m.id, mem.position,
					${optedOutSql(sql`m.tenant_id`, sql`m.recipient_person_id`)} AS unsubscribed,
					EXISTS (SELECT 1 FROM suppression s WHERE s.address_hash = m.address_hash AND s.cleared_at IS NULL) AS blocked
				FROM locked r
				JOIN mail_request_member mem ON mem.request_id = r.id AND mem.tenant_id = r.tenant_id
				JOIN mail m ON m.id = mem.mail_id AND m.tenant_id = mem.tenant_id
				WHERE m.state = 'scheduled'
			), flipped AS (
				-- The held time is cleared: the email now goes out at once, like a send now.
				UPDATE mail m SET
					state = CASE WHEN d.unsubscribed OR d.blocked THEN 'refused' ELSE 'dispatched' END,
					refusal = CASE WHEN d.unsubscribed THEN 'unsubscribed' END,
					scheduled_at = NULL
				FROM decided d
				WHERE m.id = d.id AND m.state = 'scheduled'
				RETURNING m.id, m.state, m.refusal, m.recipient_person_id, m.frozen_payload, m.recipient_address_encrypted,
					m.logical_key, d.position
			)
			SELECT r.id AS request_id, r.tenant_id, r.provider_key,
				(SELECT a.id FROM mail_attempt a WHERE a.request_id = r.id AND a.attempt_number = 1) AS attempt_id,
				(SELECT split_part(f.logical_key, '/', 2) FROM flipped f LIMIT 1) AS communication_id,
				coalesce((SELECT jsonb_agg(jsonb_build_object('position', f.position, 'id', f.id, 'state', f.state,
					'personId', f.recipient_person_id, 'unsubscribed', f.refusal IS NOT NULL,
					'payload', f.frozen_payload, 'address', f.recipient_address_encrypted) ORDER BY f.position)
					FROM flipped f), '[]'::jsonb) AS members
			FROM locked r
			WHERE EXISTS (SELECT 1 FROM flipped)`),
	);
	return raw
		? claimedSchema.parse({ ...(raw as object), members: asJson((raw as { members: unknown }).members) })
		: null;
}

/**
 * Hand due scheduled Messages email to the email service: the minute runner's job (T-241). A scheduled email waits in
 * Everyfield until its send time, so a person who unsubscribes before then gets nothing, whether or not the email service
 * can be reached, and everyone else on the email still gets it. It returns how many emails it handed off or settled.
 */
export async function runDueScheduled(
	db: Database,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
	limit: number,
	until: number,
): Promise<number> {
	const ready = keysOf(keys);
	let handled = 0;
	while (handled < limit && Date.now() < until) {
		const claimed = await claimDue(db);
		if (!claimed) break;
		handled += 1;
		const who: Recorder = {
			plantId: claimed.tenant_id,
			gate: sql`NOT ${churchClosing(sql`${claimed.tenant_id}::uuid`)}`,
			actorId: null,
		};
		const base: Member[] = claimed.members.map((row) => ({
			position: row.position,
			state: row.state,
			personId: row.personId,
			provider: null,
			scheduledAt: null,
			cancelRequested: false,
			unsubscribed: row.unsubscribed,
		}));
		const sending = claimed.members.filter((row) => row.state === "dispatched");
		const opened = sending.map((row) => {
			const json =
				row.payload &&
				openText(ready.encryptionKey, row.payload.sealed, `${claimed.tenant_id}/${row.id}/communication`);
			const to = row.address && openText(ready.encryptionKey, row.address, addressAad(claimed.tenant_id, row.id));
			const message = json ? sealedMessage.safeParse(JSON.parse(json)) : null;
			return { position: row.position, message: message?.success && to ? { ...message.data, to } : null };
		});
		// A recipient whose sealed email no longer opens is refused, never sent blank.
		const updates: { position: number; outcome: "accepted" | "refused" | "unknown"; providerId: string | null }[] =
			opened
				.filter((row) => !row.message)
				.map((row) => ({ position: row.position, outcome: "refused", providerId: null }));
		const messages = opened.filter((row) => row.message);
		if (messages.length) {
			let batch: DeliveryBatch;
			try {
				batch = await transport.send(
					{ key: claimed.provider_key, messages: messages.map((row) => row.message!), scheduledAt: null },
					signal(),
				);
			} catch {
				batch = { outcome: "unknown" };
			}
			updates.push(
				...applyIds(
					batch,
					messages.map((row) => row.position),
					"compressed",
				),
			);
		}
		await record(db, who, claimed.communication_id, claimed.request_id, claimed.attempt_id, updates, base);
	}
	return handled;
}

const heldSchema = z.array(
	z.object({ id: z.uuid(), tenant_id: z.uuid(), provider_message_id: z.string(), communication_id: z.uuid() }),
);

/**
 * Cancel at the email service the emails it already holds (handed off with a send time before T-241) for a person who
 * has since unsubscribed from that church. A cancel the email service does not confirm stays open and the next minute
 * asks again, until the send time passes. A confirmed cancel shows as unsubscribed; an email that already went out
 * shows as sent.
 */
export async function cancelUnsubscribedHeld(db: Database, transport: DeliveryTransport, limit: number) {
	const held = heldSchema.parse(
		(
			await db.execute(sql`SELECT m.id, m.tenant_id, m.provider_message_id, split_part(m.logical_key, '/', 2) AS communication_id
				FROM mail m
				WHERE m.purpose = 'communication' AND m.state = 'accepted' AND m.provider_message_id IS NOT NULL
					AND m.scheduled_at IS NOT NULL AND m.scheduled_at > clock_timestamp()
					AND m.sent_at IS NULL AND m.delivered_at IS NULL
					AND ${optedOutSql(sql`m.tenant_id`, sql`m.recipient_person_id`)}
					AND NOT ${churchClosing(sql`m.tenant_id`)}
				ORDER BY m.scheduled_at, m.id
				LIMIT ${limit}`)
		).rows,
	);
	if (!held.length) return 0;
	let replies: readonly ProviderAnswer[];
	try {
		replies = await transport.cancel(
			held.map((row) => row.provider_message_id),
			signal(),
		);
	} catch {
		return 0;
	}
	const answers = held.flatMap((row, index) => {
		const outcome = replies[index]?.outcome ?? "unknown";
		return outcome === "unknown"
			? []
			: [{ id: row.id, tenant: row.tenant_id, communication: row.communication_id, outcome }];
	});
	if (!answers.length) return 0;
	await db.execute(sql`WITH input AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(answers)}::jsonb) AS x(id uuid, tenant uuid, communication uuid, outcome text)
		), updated AS (
			UPDATE mail m SET
				state = CASE WHEN x.outcome = 'sent' THEN 'sent' ELSE 'refused' END,
				refusal = CASE WHEN x.outcome = 'sent' THEN NULL ELSE 'unsubscribed' END,
				cancel_confirmed_at = CASE WHEN x.outcome = 'done' THEN clock_timestamp() ELSE m.cancel_confirmed_at END,
				sent_at = CASE WHEN x.outcome = 'sent' THEN coalesce(m.sent_at, clock_timestamp()) ELSE m.sent_at END
			FROM input x
			WHERE m.id = x.id AND m.tenant_id = x.tenant AND m.state = 'accepted'
			RETURNING m.id, m.tenant_id, x.communication, x.outcome
		)
		INSERT INTO audit_event (tenant_id, system_cause, action, kind, subject_type, subject_id, event_key, metadata, after_value)
		SELECT u.tenant_id, 'mail_transport', 'mail.cancelled', 'outcome', 'record', u.communication,
			'unsubscribed-cancel/' || u.id::text, '{}'::jsonb, jsonb_build_object('outcome', u.outcome)
		FROM updated u
		ON CONFLICT (subject_id, event_key) DO NOTHING`);
	return answers.length;
}
