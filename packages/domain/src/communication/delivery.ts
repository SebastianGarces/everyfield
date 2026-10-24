import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { sql } from "@everyfield/db/query";
import type { Database } from "@everyfield/db/client";
import * as c from "@everyfield/contracts/communication";
import { renderTransactional, scheduleAccepted } from "@everyfield/contracts/communication";
import type { RequestActor } from "../access/session.ts";
import { audiencePeople, reviewedParts } from "./audience.ts";
import { z } from "zod";
import { administers, deny, hash, parse, readReply, readerOf } from "./core.ts";

const BATCH_LIMIT = 100;
const CALL_TIMEOUT_MS = 10_000;

export type DeliveryKeys = { encryptionKey: Uint8Array; addressKey: Uint8Array; from: string };
export type DeliveryMessage = { to: string; subject: string; html: string; text: string };
export type DeliveryBatch =
	{ outcome: "ids"; ids: readonly (string | null)[] } | { outcome: "unknown" } | { outcome: "refused" };
export type DeliveryTransport = {
	send(batch: { key: string; messages: readonly DeliveryMessage[] }, signal: AbortSignal): Promise<DeliveryBatch>;
	lookup(key: string, signal: AbortSignal): Promise<Exclude<DeliveryBatch, { outcome: "refused" }>>;
	cancel?(key: string, signal: AbortSignal): Promise<{ outcome: "cancelled" | "unknown" }>;
	reschedule?(key: string, at: string, signal: AbortSignal): Promise<{ outcome: "accepted" | "unknown" }>;
};

type Actor = ReturnType<typeof readerOf>;
type Member = { position: number; state: string; personId: string | null; provider: string | null };

const one = (result: { rows: unknown[] }) => result.rows[0];
const asJson = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);
const signal = () => AbortSignal.timeout(CALL_TIMEOUT_MS);

function keysOf(keys: DeliveryKeys) {
	const encryptionKey = Buffer.from(keys.encryptionKey);
	const addressKey = Buffer.from(keys.addressKey);
	if (encryptionKey.length !== 32 || addressKey.length !== 32 || encryptionKey.equals(addressKey))
		throw new Error("mail_keys_required");
	const from = z.email().parse(keys.from);
	return { encryptionKey, addressKey, from };
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
function adminGate(actor: Actor) {
	return sql`EXISTS (SELECT 1 FROM live_session(${actor.session}::uuid) i
		JOIN account a ON a.id = i.account_id AND a.id = ${actor.accountId}::uuid AND a.auth_user_id IS NOT NULL
		JOIN seat st ON st.account_id = a.id AND st.id = ${actor.seatId}::uuid AND st.plant_id = ${actor.plantId}::uuid
			AND st.ended_at IS NULL AND st.accepted_at <= clock_timestamp() AND st.role = ${actor.role}
			AND st.role <> 'member'
		WHERE i.registration_state = 'active' AND i.expires_at > clock_timestamp())`;
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
	const accepted = members.filter((row) => row.state === "accepted" || row.state === "sent");
	const rejected = members.filter(
		(row) => row.state === "refused" || row.state === "failed" || row.state === "cancelled",
	);
	const unknown = members.filter((row) => row.state === "unknown" || row.state === "dispatched");
	return {
		acceptedCount: accepted.length,
		rejectedCount: rejected.length,
		unknownCount: unknown.length,
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
});

async function loadAudience(db: Database, actor: Actor, communicationId: string): Promise<Loaded> {
	const gate = adminGate(actor);
	const raw = one(
		await db.execute(sql`SELECT g.allowed, c.id, c.revision::text AS revision, c.state, c.subject, c.body_html, c.body_text,
			c.audience, c.review_digest,
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
					'position', mem.position, 'state', m.state, 'personId', m.recipient_person_id, 'provider', m.provider_message_id
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
	const resolved = one(await db.execute(sql`SELECT ${audiencePeople(actor.plantId, audience)} AS people`)) as
		{ people?: unknown } | undefined;
	const people = resolved?.people ?? [];
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
	lookupOnly: boolean,
): Promise<Prepared> {
	const { found, parts } = loaded;
	if (found.request_id && found.provider_key && found.attempt_id) {
		return {
			kind: "resume",
			requestId: found.request_id,
			attemptId: found.attempt_id,
			providerKey: found.provider_key,
			members: membersOf(found.members),
		};
	}
	if (lookupOnly) deny("not_found");
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
		const payloadHash = hash({
			purpose: "communication",
			personId: person.id,
			address,
			subject: found.subject,
			body: found.body_text ?? found.body_html,
			from: keys.from,
		});
		return {
			id,
			person: person.id,
			logical_key: `communication/${found.id}/${person.id}`,
			payload_hash: payloadHash,
			address_hash: addressHash(keys.addressKey, address),
			payload: {
				v: 1,
				sealed: seal(
					keys.encryptionKey,
					JSON.stringify({ subject: found.subject, text: found.body_text, html: found.body_html, from: keys.from }),
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
	const stored = one(
		await db.execute(sql`WITH gate AS (SELECT ${adminGate(actor)} AS allowed),
			input AS (
				SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows.map(({ to: _to, ...row }) => row))}::jsonb) AS i(
					id uuid, person uuid, logical_key text, payload_hash text, address_hash text, payload jsonb, address text, position int
				)
			),
			ins_mail AS (
				INSERT INTO mail (id, tenant_id, recipient_person_id, purpose, logical_key, payload_hash, audience_hash,
					frozen_payload, recipient_address_encrypted, address_hash, state, created_at, scheduled_at)
				SELECT i.id, ${actor.plantId}::uuid, i.person, 'communication', i.logical_key, i.payload_hash, ${loaded.digest},
					i.payload, i.address, i.address_hash,
					CASE WHEN EXISTS (
						SELECT 1 FROM suppression s WHERE s.address_hash = i.address_hash AND s.cleared_at IS NULL
					) THEN 'refused' ELSE 'dispatched' END,
					clock_timestamp(), ${found.scheduled_at}::timestamptz
				FROM input i
				JOIN gate g ON g.allowed
				WHERE EXISTS (
					SELECT 1 FROM communication c
					WHERE c.id = ${found.id}::uuid AND c.plant_id = ${actor.plantId}::uuid AND c.state = 'scheduled'
					AND c.revision = ${found.revision}::bigint AND c.review_digest = ${loaded.digest}
				)
				RETURNING id, state
			),
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
					CASE WHEN bool_or(m.state = 'dispatched') THEN 'in_flight' ELSE 'refused' END,
					CASE WHEN bool_or(m.state = 'dispatched') THEN NULL ELSE clock_timestamp() END
				FROM ins_req r
				JOIN ins_mail m ON true
				GROUP BY r.id
				RETURNING outcome
			),
			ins_audit AS (
				INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
				SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'communication.send_intended', 'outcome', 'record',
					${found.id}::uuid, ${"dispatch/" + providerKey}, '{}'::jsonb,
					jsonb_build_object('recipients', (SELECT count(*) FROM ins_mail))
				WHERE EXISTS (SELECT 1 FROM ins_mail)
				ON CONFLICT (subject_id, event_key) DO NOTHING
				RETURNING id
			)
			SELECT (SELECT allowed FROM gate) AS allowed,
				(SELECT outcome FROM ins_attempt) AS outcome,
				coalesce((SELECT jsonb_agg(jsonb_build_object('position', i.position, 'state', m.state, 'personId', i.person, 'provider', NULL) ORDER BY i.position)
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
			html: found.body_html!,
			text: found.body_text ?? found.subject!,
		}));
	if (stored.outcome === "refused" || messages.length === 0) return { kind: "done", members };
	return { kind: "send", requestId, attemptId, providerKey, messages, members };
}

async function record(
	db: Database,
	actor: Actor,
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
		WHERE mem.request_id = ${requestId}::uuid AND mem.tenant_id = ${actor.plantId}::uuid
			AND mem.mail_id = m.id AND m.state IN ('dispatched', 'unknown')
			AND ${adminGate(actor)}
		RETURNING m.id
	), attempt AS (
		UPDATE mail_attempt SET outcome = ${outcome}, completed_at = clock_timestamp()
		WHERE id = ${attemptId}::uuid AND tenant_id = ${actor.plantId}::uuid AND ${adminGate(actor)}
		AND (EXISTS (SELECT 1 FROM updated) OR NOT EXISTS (SELECT 1 FROM input))
		RETURNING id
	)
	INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
	SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, ${action}, 'outcome', 'record', ${communicationId}::uuid,
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
	lookupOnly: boolean,
) {
	const input = parse(c.dispatchRequest, raw);
	const actor = requireActor(authority);
	const opened = await openLoaded(db, actor, input.input.communicationId, input.expectedRevision);
	const ready = keysOf(keys);
	const prepared = await prepare(db, actor, opened, ready, lookupOnly);
	if (prepared.kind === "done") return dispatchValue(input.input.communicationId, prepared.members, 0, "failed");
	const open = prepared.members.filter((row) => row.state === "dispatched" || row.state === "unknown");
	if (!open.length) return dispatchValue(input.input.communicationId, prepared.members, 0, "accepted");
	let batch: DeliveryBatch;
	let providerCalls = 0;
	try {
		if (prepared.kind === "send") {
			providerCalls = 1;
			batch = await transport.send({ key: prepared.providerKey, messages: prepared.messages }, signal());
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
		actor,
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

export function dispatchReviewed(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	return readReply(() => handoff(db, authority, raw, transport, keys, false));
}
export function reconcileReviewed(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	return readReply(() => handoff(db, authority, raw, transport, keys, true));
}

export function cancelScheduled(db: Database, authority: RequestActor, raw: unknown, transport: DeliveryTransport) {
	return readReply(async () => {
		const input = parse(c.cancelScheduledRequest, raw);
		const actor = requireActor(authority);
		const found = loadedSchema.parse(await loadAudience(db, actor, input.input.communicationId));
		if (found.allowed !== true) deny("access_denied");
		if (!found.id) deny("not_found");
		if (found.revision !== input.expectedRevision) deny("conflict");
		const before = membersOf(found.members);
		const sent = before.some((row) => row.state === "sent");
		await db.execute(sql`WITH updated AS (
				UPDATE mail SET cancel_requested_at = clock_timestamp()
				WHERE tenant_id = ${actor.plantId}::uuid AND logical_key LIKE ${prefix(found.id!)}
				AND sent_at IS NULL AND delivered_at IS NULL AND state <> 'cancelled' AND state <> 'sent'
				AND ${adminGate(actor)}
				RETURNING id
			)
			INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
			SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'mail.cancelled', 'outcome', 'record', ${found.id}::uuid,
				${"cancel/" + input.requestKey}, '{}'::jsonb, jsonb_build_object('sent_recalled', false)
			WHERE ${adminGate(actor)} AND (SELECT count(*) FROM updated) >= 0
			ON CONFLICT (subject_id, event_key) DO NOTHING`);
		let scheduledCancel: "reconcile" | "confirmed" | "none" = found.provider_key ? "reconcile" : "none";
		if (found.provider_key && transport.cancel) {
			try {
				const result = await transport.cancel(found.provider_key, signal());
				if (result.outcome === "cancelled") {
					scheduledCancel = "confirmed";
					await db.execute(sql`UPDATE mail SET state = 'cancelled', cancel_confirmed_at = clock_timestamp()
						WHERE tenant_id = ${actor.plantId}::uuid AND logical_key LIKE ${prefix(found.id!)}
						AND sent_at IS NULL AND delivered_at IS NULL AND state <> 'sent' AND ${adminGate(actor)}`);
				}
			} catch {
				scheduledCancel = "reconcile";
			}
		}
		return c.cancelScheduledResult.parse({
			newHandoffs: 0,
			scheduledCancel: sent && scheduledCancel === "none" ? "none" : scheduledCancel,
			sentRecalled: false,
			cancelRequested: true,
			recallGuaranteed: false,
			newSend: false,
			existingUrlMayWorkUntil: input.input.signedUrlExpires ?? null,
		});
	});
}

export function replaceScheduled(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(c.replaceScheduledRequest, raw);
		const actor = requireActor(authority);
		const found = loadedSchema.parse(await loadAudience(db, actor, input.input.communicationId));
		if (found.allowed !== true) deny("access_denied");
		if (!found.id) deny("not_found");
		const members = membersOf(found.members);
		const replacementAllowed = members.length > 0 && members.every((row) => row.state === "cancelled");
		return c.replaceScheduledResult.parse({ replacementAllowed, replacementIntents: 0, blindResends: 0 });
	});
}

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
		const found = loadedSchema.parse(await loadAudience(db, actor, input.input.communicationId));
		if (found.allowed !== true) deny("access_denied");
		if (!found.id || !found.body_html) deny("not_found");
		if (found.revision !== input.expectedRevision || found.state !== "scheduled") deny("conflict");
		await db.execute(sql`WITH updated AS (
				UPDATE communication SET scheduled_at = ${at.toISOString()}::timestamptz,
					revision = revision + 1, updated_at = clock_timestamp()
				WHERE id = ${found.id}::uuid AND plant_id = ${actor.plantId}::uuid AND state = 'scheduled'
				AND revision = ${found.revision}::bigint AND ${adminGate(actor)}
				RETURNING id
			)
			INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_type, subject_id, event_key, metadata, after_value)
			SELECT ${actor.plantId}::uuid, ${actor.accountId}::uuid, 'communication.rescheduled', 'edit', 'record', ${found.id}::uuid,
				${"reschedule/" + input.requestKey}, '{}'::jsonb, jsonb_build_object('scheduled_at', ${at.toISOString()}::text)
			FROM updated
			ON CONFLICT (subject_id, event_key) DO NOTHING`);
		let rescheduleStatus: "accepted" | "unknown" = "accepted";
		if (found.provider_key) {
			rescheduleStatus = "unknown";
			if (transport.reschedule) {
				try {
					const result = await transport.reschedule(found.provider_key, at.toISOString(), signal());
					if (result.outcome === "accepted") rescheduleStatus = "accepted";
				} catch {
					rescheduleStatus = "unknown";
				}
			}
		}
		return c.rescheduleDispatchedResult.parse({
			body: found.body_text ?? found.body_html,
			rescheduleStatus,
			newCommunications: 0,
			scheduledAt: at.toISOString(),
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
		const row = one(
			await db.execute(sql`SELECT id FROM suppression WHERE address_hash = ${hashValue} AND cleared_at IS NULL`),
		) as { id?: string } | undefined;
		return c.suppressionListResult.parse({
			address: email,
			active: Boolean(row?.id),
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
