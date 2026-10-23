import { and, eq, inArray, isNull, sql, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { notificationCategory } from "@everyfield/contracts/settings";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { executeWrites } from "@everyfield/domain/operations";
import { transaction } from "../platform/database.ts";
import { finishClaim, lockClaim, checkpoint, claimSchema, DEFAULT_LEASE_SECONDS, type Claim } from "./queue.ts";

const owner = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("account"), id: z.uuid() }),
	z.strictObject({ kind: z.literal("plant"), id: z.uuid() }),
	z.strictObject({
		kind: z.literal("organization"),
		id: z.uuid(),
		organizationKind: z.enum(["sending_church", "sending_network"]),
	}),
]);
export const mailPurpose = z.enum([
	"communication",
	"discovery_receipt",
	"email_change",
	"email_verification",
	"notification",
	"oversight_digest",
	"password_reset",
	"planter_digest",
	"relationship_invitation",
	"relationship_receipt",
	"seat_invitation",
]);
const contentSchema = z.strictObject({ subject: z.string().min(1).max(500), text: z.string().min(1).max(100_000) });
const storedContentSchema = contentSchema.extend({ from: z.email() });
const intentSchema = z.strictObject({
	owner,
	purpose: mailPurpose,
	logicalKey: z.string().min(1).max(512),
	recipient: z.uuid().nullable(),
	address: z.email().max(320),
	content: contentSchema,
	operation: z.uuid().nullable(),
	notice: z.uuid().nullable(),
	eligibleAt: z.iso.datetime(),
});
export type MailIntent = z.infer<typeof intentSchema>;
export type MailAuthority = Readonly<{
	id: string;
	tenant: string;
	purpose: z.infer<typeof mailPurpose>;
	recipient: string | null;
	notice: string | null;
	operation: string | null;
	addressHash: string;
	logicalKey: string;
}>;
export type RecoveryEvidence = { actorId: string; operationId: string; evidenceHash: string };
export type AuthorizeRecovery = (
	tx: Transaction,
	mail: MailAuthority,
	providerId: string,
) => Promise<RecoveryEvidence | null>;
export type AuthorizeMail = (tx: Transaction, mail: readonly MailAuthority[]) => Promise<ReadonlySet<string>>;
export type TransportOutcome =
	| { kind: "accepted"; id: string }
	| { kind: "refused"; retryable: boolean; retryAfterSeconds?: number }
	| { kind: "unknown" };
export interface MailTransport {
	send(
		payload: Readonly<{ from: string; to: string; subject: string; text: string; html: string }>,
		key: string,
		signal: AbortSignal,
	): Promise<TransportOutcome>;
	lookup(id: string, signal: AbortSignal): Promise<TransportOutcome>;
}
const stored = z.object({
	id: z.uuid(),
	tenant_id: z.uuid(),
	purpose: mailPurpose,
	recipient_account_id: z.uuid().nullable(),
	notice_id: z.uuid().nullable(),
	operation_id: z.uuid().nullable(),
	logical_key: z.string(),
	state: z.string(),
	payload_hash: z.string(),
	address_hash: z.string().nullable(),
	frozen_payload: z.object({ v: z.literal(1), sealed: z.string() }).nullable(),
	recipient_address_encrypted: z.string().nullable(),
	provider_message_id: z.string().nullable(),
	revision: z.string(),
	job_id: z.uuid().nullable(),
});
export const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function createMailService(config: {
	db: Database;
	encryptionKey: Uint8Array;
	addressKey: Uint8Array;
	from: string;
	authorize: AuthorizeMail;
	transport: MailTransport;
	authorizeRecovery?: AuthorizeRecovery;
}) {
	const encryptionKey = Buffer.from(config.encryptionKey),
		addressKey = Buffer.from(config.addressKey);
	if (encryptionKey.length !== 32 || addressKey.length !== 32 || encryptionKey.equals(addressKey))
		throw Error("mail_keys_required");
	z.email().parse(config.from);
	const seal = (value: string, aad: string) => {
		const iv = randomBytes(12),
			cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
		cipher.setAAD(Buffer.from(aad));
		const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
	};
	const open = (value: string, aad: string) => {
		const bytes = Buffer.from(value, "base64url"),
			cipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
		cipher.setAAD(Buffer.from(aad));
		cipher.setAuthTag(bytes.subarray(12, 28));
		return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
	};
	const authority = (m: z.infer<typeof stored>): MailAuthority => ({
		id: m.id,
		tenant: m.tenant_id,
		purpose: m.purpose,
		recipient: m.recipient_account_id,
		notice: m.notice_id,
		operation: m.operation_id,
		addressHash: m.address_hash ?? "",
		logicalKey: m.logical_key,
	});
	const aad = (id: string, tenant: string, purpose: string) => `${tenant}/${id}/${purpose}`;
	async function live(tx: Transaction, m: z.infer<typeof stored>) {
		// Current deletion witnesses override restored or still-present intent rows.
		const barriers = await tx
			.select({ id: tables.lifecycle_witness.id })
			.from(tables.lifecycle_witness)
			.where(
				and(
					inArray(
						tables.lifecycle_witness.opaque_subject_id,
						[m.tenant_id, m.recipient_account_id].filter((value): value is string => value !== null),
					),
					sql<boolean>`(${tables.lifecycle_witness.state} IN ('pending_deletion', 'purging', 'purged', 'revoked'))`,
				),
			)
			.for("share");
		if (barriers.length) return false;
		if (m.notice_id) {
			const notice = await tx
				.select({
					id: tables.notice.id,
					category: tables.notice.category,
					purpose: tables.notice.purpose,
					logical_key: tables.notice.logical_key,
				})
				.from(tables.notice)
				.where(
					and(
						and(eq(tables.notice.id, m.notice_id), eq(tables.notice.tenant_id, m.tenant_id)),
						isNull(tables.notice.cancelled_at),
					),
				)
				.for("share");
			if (notice.length !== 1) return false;
			const row = z.object({ category: z.string(), purpose: z.string(), logical_key: z.string() }).parse(notice[0]);
			if (row.category === "reference_update") return false;
			const parsedPreference = notificationCategory.safeParse(row.logical_key.split("/")[1]);
			if (!parsedPreference.success) return false;
			const preference = parsedPreference.data;
			const choice = await tx
				.select({ enabled: tables.notification_preference.enabled })
				.from(tables.notification_preference)
				.where(
					and(
						and(
							eq(tables.notification_preference.account_id, sql`${m.recipient_account_id}`),
							eq(tables.notification_preference.category, sql`${preference}`),
						),
						eq(tables.notification_preference.channel, "email"),
					),
				);
			if (choice[0]?.enabled === false) return false;
		}
		if (m.purpose === "planter_digest" || m.purpose === "oversight_digest") {
			const choice = await tx
				.select({ enabled: tables.notification_preference.enabled })
				.from(tables.notification_preference)
				.where(
					and(
						and(
							eq(tables.notification_preference.account_id, sql`${m.recipient_account_id}`),
							eq(tables.notification_preference.category, m.purpose),
						),
						eq(tables.notification_preference.channel, "email"),
					),
				);
			if (choice[0]?.enabled === false) return false;
		}
		return (await config.authorize(tx, [authority(m)])).has(m.id);
	}
	function audit(tx: Transaction, m: z.infer<typeof stored>, key: string, action: string) {
		return tx
			.insert(tables.audit_event)
			.values({
				tenant_id: m.tenant_id,
				subject_id: m.id,
				command_id: m.operation_id,
				kind: "outcome",
				occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				system_cause: "mail_transport",
				event_key: key,
				action: sql`${action}`,
			})
			.onConflictDoNothing({ target: [tables.audit_event.subject_id, tables.audit_event.event_key] });
	}
	/** The verified producer queues a required intent with its facts and audit. Dispatch rechecks its live source. */
	async function append(tx: Pick<Transaction, "insert">, input: MailIntent, writes: SQLWrapper[]): Promise<string> {
		const v = intentSchema.parse(input),
			id = randomUUID(),
			job = randomUUID(),
			request = randomUUID(),
			address = v.address.trim().toLowerCase();
		const addressHash = createHmac("sha256", addressKey).update(address).digest("hex");
		const hash = digest(
			JSON.stringify({
				purpose: v.purpose,
				recipient: v.recipient,
				address,
				content: v.content,
				from: config.from,
				notice: v.notice,
				operation: v.operation,
			}),
		);
		writes.push(
			tx.insert(tables.mail).values({
				id,
				tenant_id: v.owner.id,
				recipient_account_id: v.recipient,
				purpose: v.purpose,
				logical_key: v.logicalKey,
				operation_id: v.operation,
				notice_id: v.notice,
				payload_hash: hash,
				audience_hash: addressHash,
				frozen_payload: {
					v: 1,
					sealed: seal(JSON.stringify({ ...v.content, from: config.from }), aad(id, v.owner.id, v.purpose)),
				},
				recipient_address_encrypted: seal(address, aad(id, v.owner.id, "address")),
				address_hash: addressHash,
				state: "pending",
				created_at: new Date(),
				job_id: job,
			}),
			tx
				.insert(tables.mail_request)
				.values({ id: request, tenant_id: v.owner.id, provider_key: "mail/" + request, request_hash: hash }),
			tx
				.insert(tables.mail_request_member)
				.values({ request_id: request, tenant_id: v.owner.id, mail_id: id, position: 0 }),
			tx.insert(tables.job).values({
				id: job,
				tenant_id: v.owner.id,
				kind: "mail",
				subject_record_id: id,
				producer_key: id + "/1",
				source_revision: "1",
				state: "ready",
				eligible_at: new Date(v.eligibleAt),
				attempt_count: 0,
				max_attempts: 4,
				claim_generation: "0",
			}),
		);
		return id;
	}
	/** Validate, hash and seal mail intents into the rows `mailInsert` writes. Pure: no statement. */
	function sealIntents(inputs: readonly MailIntent[]) {
		return inputs.map((input) => {
			const v = intentSchema.parse(input),
				id = randomUUID(),
				address = v.address.trim().toLowerCase();
			const addressHash = createHmac("sha256", addressKey).update(address).digest("hex");
			const hash = digest(
				JSON.stringify({
					purpose: v.purpose,
					recipient: v.recipient,
					address,
					content: v.content,
					from: config.from,
					notice: v.notice,
					operation: v.operation,
				}),
			);
			return {
				v,
				id,
				addressHash,
				hash,
				row: {
					id,
					tenant: v.owner.id,
					recipient: v.recipient,
					purpose: v.purpose,
					key: v.logicalKey,
					operation: v.operation,
					notice: v.notice,
					hash,
					addressHash,
					payload: {
						v: 1,
						sealed: seal(JSON.stringify({ ...v.content, from: config.from }), aad(id, v.owner.id, v.purpose)),
					},
					address: seal(address, aad(id, v.owner.id, "address")),
					job: randomUUID(),
					request: randomUUID(),
					eligible: v.eligibleAt,
				},
			};
		});
	}
	/**
	 * The CTEs that insert sealed mail with its request, member and job rows, for the end of one write statement.
	 * `mail_input` holds the sealed rows and `mail_inserted` the stored mail (the existing row for a known key).
	 * `queued` gives a producer these CTEs for intents it has already authorized and checked for deletion barriers
	 * under its own locks; it sends no statement.
	 */
	function mailInsert(rows: readonly ReturnType<typeof sealIntents>[number]["row"][]) {
		return sql`mail_input AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) i(id uuid,tenant uuid,recipient uuid,purpose text,key text,operation uuid,notice uuid,hash text,"addressHash" text,payload jsonb,address text,job uuid,request uuid,eligible timestamptz)),
   mail_inserted AS (
    INSERT INTO mail(id,tenant_id,recipient_account_id,purpose,logical_key,operation_id,notice_id,payload_hash,audience_hash,frozen_payload,recipient_address_encrypted,address_hash,state,created_at,job_id)
    SELECT id,tenant,recipient,purpose,key,operation,notice,hash,"addressHash",payload,address,"addressHash",'pending',clock_timestamp(),job FROM mail_input
    ON CONFLICT(tenant_id,logical_key) DO UPDATE SET logical_key=excluded.logical_key RETURNING id,tenant_id,logical_key,payload_hash
   ), mail_requests AS (
    INSERT INTO mail_request(id,tenant_id,provider_key,request_hash) SELECT i.request,i.tenant,'mail/'||i.request::text,i.hash FROM mail_input i JOIN mail_inserted m ON m.id=i.id RETURNING id,tenant_id
   ), mail_members AS (
    INSERT INTO mail_request_member(request_id,tenant_id,mail_id,position) SELECT r.id,i.tenant,i.id,0 FROM mail_input i JOIN mail_requests r ON r.id=i.request RETURNING mail_id
   ), mail_jobs AS (
    INSERT INTO job(id,tenant_id,kind,subject_record_id,producer_key,source_revision,state,eligible_at,attempt_count,max_attempts,claim_generation)
    SELECT i.job,i.tenant,'mail',i.id,i.id::text||'/1',1,'ready',i.eligible,0,4,0 FROM mail_input i JOIN mail_members m ON m.mail_id=i.id RETURNING id
   )`;
	}
	async function enqueueMany(tx: Transaction, inputs: readonly MailIntent[]): Promise<string[]> {
		const intents = sealIntents(inputs);
		if (!intents.length) return [];
		const input = intents.map((i, n) => ({ n, tenant: i.v.owner.id, recipient: i.v.recipient, key: i.v.logicalKey }));
		const raw =
			await tx.execute(sql`WITH input AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(n int,tenant uuid,recipient uuid,key text)),
   account_roots AS MATERIALIZED (SELECT a.id FROM account a WHERE a.id IN (SELECT tenant FROM input UNION SELECT recipient FROM input) ORDER BY a.id FOR SHARE),
   plant_roots AS MATERIALIZED (SELECT p.id FROM plant p WHERE p.id IN (SELECT tenant FROM input) AND (SELECT count(*) FROM account_roots)>=0 ORDER BY p.id FOR SHARE),
   organization_roots AS MATERIALIZED (SELECT o.id,o.kind FROM organization o WHERE o.id IN (SELECT tenant FROM input) AND (SELECT count(*) FROM plant_roots)>=0 ORDER BY o.id FOR SHARE),
   prior AS MATERIALIZED (SELECT m.id,m.tenant_id,m.logical_key,m.payload_hash FROM mail m JOIN input i ON i.tenant=m.tenant_id AND i.key=m.logical_key WHERE (SELECT count(*) FROM organization_roots)>=0 ORDER BY m.id FOR UPDATE OF m),
   barriers AS MATERIALIZED (SELECT w.opaque_subject_id FROM lifecycle_witness w WHERE w.opaque_subject_id IN (SELECT tenant FROM input UNION SELECT recipient FROM input) AND w.state IN ('pending_deletion','purging','purged','revoked') AND (SELECT count(*) FROM organization_roots)>=0 FOR SHARE)
   SELECT i.n,t.kind,o.kind AS organization_kind,p.id AS prior_id,p.payload_hash AS prior_hash,
    EXISTS(SELECT FROM barriers b WHERE b.opaque_subject_id IN (i.tenant,i.recipient)) AS blocked
   FROM input i LEFT JOIN tenant t ON t.id=i.tenant LEFT JOIN organization_roots o ON o.id=i.tenant
   LEFT JOIN prior p ON p.tenant_id=i.tenant AND p.logical_key=i.key ORDER BY i.n`);
		const observations = z
			.array(
				z.object({
					n: z.number().int(),
					kind: z.string().nullable(),
					organization_kind: z.string().nullable(),
					prior_id: z.uuid().nullable(),
					prior_hash: z.string().nullable(),
					blocked: z.boolean(),
				}),
			)
			.parse(raw.rows);
		const authorities: MailAuthority[] = intents.map((i, n) => ({
			id: observations[n]?.prior_id ?? i.id,
			tenant: i.v.owner.id,
			purpose: i.v.purpose,
			recipient: i.v.recipient,
			notice: i.v.notice,
			operation: i.v.operation,
			addressHash: i.addressHash,
			logicalKey: i.v.logicalKey,
		}));
		for (const [n, i] of intents.entries()) {
			const r = observations[n];
			if (
				!r ||
				r.kind !== i.v.owner.kind ||
				(i.v.owner.kind === "organization" && r.organization_kind !== i.v.owner.organizationKind)
			)
				throw Error("mail_owner_mismatch");
			if (r.blocked) throw Error("mail_unavailable");
		}
		const authorized = await config.authorize(tx, authorities);
		if (authorities.some((a) => !authorized.has(a.id))) throw Error("mail_unavailable");
		for (const [n, i] of intents.entries())
			if (observations[n]?.prior_id && observations[n]?.prior_hash !== i.hash) throw Error("mail_identity_conflict");
		const result = await tx.execute(
			sql`WITH ${mailInsert(intents.map((i) => i.row))} SELECT m.id,m.payload_hash,i.hash,i.id AS input_id FROM mail_inserted m JOIN mail_input i ON m.tenant_id=i.tenant AND m.logical_key=i.key`,
		);
		const rows = z
			.array(z.object({ id: z.uuid(), input_id: z.uuid(), payload_hash: z.string(), hash: z.string() }))
			.parse(result.rows);
		if (rows.length !== intents.length || rows.some((r) => r.payload_hash !== r.hash))
			throw Error("mail_identity_conflict");
		const byKey = new Map(rows.map((r) => [r.input_id, r.id]));
		return intents.map((i) => {
			const id = byKey.get(i.id);
			if (!id) throw Error("mail_identity_conflict");
			return id;
		});
	}
	async function enqueue(tx: Transaction, input: MailIntent): Promise<string> {
		const [id] = await enqueueMany(tx, [input]);
		if (!id) throw Error("mail_identity_conflict");
		return id;
	}

	async function dispatch(claim: Claim) {
		const prepared = await transaction(config.db, async (tx) => {
			if (claim.kind !== "mail" || !(await lockClaim(tx, claim))) return null;
			const row = await tx
				.select()
				.from(tables.mail)
				.where(and(eq(tables.mail.id, sql`${claim.subject_record_id}`), eq(tables.mail.tenant_id, claim.tenant_id)))
				.for("update");
			const m = stored.parse(row[0]);
			if (!["pending", "refused", "unknown", "dispatched"].includes(m.state)) {
				await finishClaim(tx, claim, { state: m.state === "cancelled" ? "cancelled" : "succeeded" });
				return null;
			}
			if (m.revision !== claim.source_revision || !(await live(tx, m))) {
				if (["unknown", "dispatched"].includes(m.state)) {
					await finishClaim(tx, claim, { state: "reconcile", code: "authority_changed" });
					return null;
				}
				await tx.update(tables.mail).set({ state: "cancelled" }).where(eq(tables.mail.id, m.id));
				await finishClaim(tx, claim, { state: "cancelled", code: "authority_changed" });
				return null;
			}
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${m.address_hash},31))`);
			const suppressed = await tx
				.select({ id: tables.suppression.id })
				.from(tables.suppression)
				.where(and(eq(tables.suppression.address_hash, sql`${m.address_hash}`), isNull(tables.suppression.cleared_at)));
			if (suppressed.length) {
				const uncertain = ["unknown", "dispatched"].includes(m.state);
				if (!uncertain) await tx.update(tables.mail).set({ state: "refused" }).where(eq(tables.mail.id, m.id));
				await finishClaim(tx, claim, { state: uncertain ? "reconcile" : "failed", code: "suppressed" });
				return null;
			}
			const request = await tx.execute(sql`SELECT r.*,r.first_dispatched_at IS NOT NULL AND
        r.first_dispatched_at+interval '23 hours 55 minutes'<=clock_timestamp() AS expired
        FROM mail_request r JOIN mail_request_member mm ON mm.request_id=r.id WHERE mm.mail_id=${m.id} FOR UPDATE OF r`);
			const r = z
				.object({ id: z.uuid(), provider_key: z.string(), request_hash: z.string(), expired: z.boolean() })
				.parse(request.rows[0]);
			if (r.request_hash !== m.payload_hash) throw Error("mail_manifest_changed");
			if (r.expired) {
				await finishClaim(tx, claim, { state: "reconcile", code: "idempotency_expired" });
				return null;
			}
			if (!m.frozen_payload || !m.recipient_address_encrypted) throw Error("mail_payload_unavailable");
			const content = storedContentSchema.parse(
				JSON.parse(open(m.frozen_payload.sealed, aad(m.id, m.tenant_id, m.purpose))),
			);
			const to = z.email().parse(open(m.recipient_address_encrypted, aad(m.id, m.tenant_id, "address")));
			const attempt = randomUUID();
			// The request's first send time, the in-flight attempt and the dispatched state: one statement.
			await executeWrites(tx, [
				tx
					.update(tables.mail_request)
					.set({
						first_dispatched_at:
							sql<Date>`coalesce(${tables.mail_request.first_dispatched_at}, clock_timestamp())`.mapWith(
								(value: string) => new Date(value),
							),
					})
					.where(eq(tables.mail_request.id, r.id)),
				tx.insert(tables.mail_attempt).values({
					id: attempt,
					tenant_id: m.tenant_id,
					request_id: r.id,
					attempt_number: claim.attempt_count,
					claim_generation: sql`${claim.claim_generation}`,
					started_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					outcome: "in_flight",
				}),
				tx.update(tables.mail).set({ state: "dispatched" }).where(eq(tables.mail.id, m.id)),
			]);
			await checkpoint(tx, claim, "external");
			return {
				m,
				attempt,
				key: r.provider_key,
				payload: { to, ...content, html: `<p>${escapeHtml(content.text).replaceAll("\n", "<br>")}</p>` },
			};
		});
		if (!prepared) return { kind: "not_dispatched" } as const;
		let outcome: TransportOutcome;
		try {
			outcome = await config.transport.send(prepared.payload, prepared.key, AbortSignal.timeout(10_000));
		} catch {
			outcome = { kind: "unknown" };
		}
		const recorded = await transaction(config.db, async (tx) => {
			if (!(await lockClaim(tx, claim))) return false;
			const { m, attempt } = prepared;
			// The attempt's outcome, the mail's state and its outcome audit row: one statement.
			const completed = tx
				.update(tables.mail_attempt)
				.set({
					outcome: outcome.kind,
					completed_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					retryable: outcome.kind === "refused" ? outcome.retryable : null,
					safe_error: outcome.kind === "unknown" ? "provider_unknown" : null,
				})
				.where(eq(tables.mail_attempt.id, attempt));
			if (outcome.kind === "accepted") {
				z.string().min(1).max(128).parse(outcome.id);
				await executeWrites(tx, [
					completed,
					tx
						.update(tables.mail)
						.set({
							state: "accepted",
							provider_message_id: outcome.id,
							accepted_at: sql<Date>`coalesce(${tables.mail.accepted_at}, clock_timestamp())`.mapWith(
								(value: string) => new Date(value),
							),
						})
						.where(eq(tables.mail.id, m.id)),
					audit(tx, m, attempt, "mail.accepted"),
				]);
				await finishClaim(tx, claim, { state: "succeeded" });
			} else if (outcome.kind === "unknown") {
				await executeWrites(tx, [
					completed,
					tx.update(tables.mail).set({ state: "unknown" }).where(eq(tables.mail.id, m.id)),
				]);
				await finishClaim(tx, claim, { state: "reconcile", code: "provider_unknown" });
			} else {
				await executeWrites(tx, [
					completed,
					tx.update(tables.mail).set({ state: "refused" }).where(eq(tables.mail.id, m.id)),
					audit(tx, m, attempt, "mail.refused"),
				]);
				// Authoritative refusal makes this checkpoint safe for the bounded retry path.
				await checkpoint(tx, claim, "refused");
				await finishClaim(
					tx,
					claim,
					outcome.retryable
						? { state: "retry_wait", code: "provider_refused", retryAfterSeconds: outcome.retryAfterSeconds }
						: { state: "failed", code: "provider_refused" },
				);
			}
			return true;
		});
		return recorded ? outcome : ({ kind: "unknown" } as const);
	}
	async function reconcileUnknownOutcome(mailId: string) {
		z.uuid().parse(mailId);
		const row = await config.db.select().from(tables.mail).where(eq(tables.mail.id, mailId));
		const m = stored.parse(row[0]);
		if (m.state !== "unknown" || !m.provider_message_id) return { kind: "unknown" } as const;
		// Provider observations, never caller-supplied result strings, establish truth.
		let observed: TransportOutcome;
		try {
			observed = await config.transport.lookup(m.provider_message_id, AbortSignal.timeout(10_000));
		} catch {
			return { kind: "unknown" } as const;
		}
		if (observed.kind !== "accepted") return { kind: "unknown" } as const;
		return transaction(config.db, async (tx) => {
			const current = await tx
				.select()
				.from(tables.mail)
				.where(and(eq(tables.mail.id, mailId), eq(tables.mail.state, "unknown")))
				.for("update");
			if (!current.length) return { kind: "unknown" } as const;
			const actual = stored.parse(current[0]);
			if (!(await live(tx, actual))) return { kind: "unknown" } as const;
			await tx
				.update(tables.mail)
				.set({
					state: "accepted",
					accepted_at: sql<Date>`coalesce(${tables.mail.accepted_at}, clock_timestamp())`.mapWith(
						(value: string) => new Date(value),
					),
				})
				.where(eq(tables.mail.id, mailId));
			await tx
				.update(tables.job)
				.set({
					state: "succeeded",
					error_code: null,
					finished_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					revision: sql<unknown>`(${tables.job.revision} + 1)`,
				})
				.where(and(eq(tables.job.id, sql`${actual.job_id}`), eq(tables.job.state, "reconcile")));
			await audit(tx, actual, `reconcile/${observed.id}`, "mail.reconciled");
			return observed;
		});
	}
	async function recordProviderReceipt(mailId: string, providerId: string) {
		z.uuid().parse(mailId);
		z.string().min(1).max(128).parse(providerId);
		const authorize = config.authorizeRecovery;
		if (!authorize) throw Error("recovery_unavailable");
		const initial = await transaction(config.db, async (tx) => {
			const row = await tx
				.select()
				.from(tables.mail)
				.where(and(eq(tables.mail.id, mailId), eq(tables.mail.state, "unknown")))
				.for("share");
			if (!row.length) return null;
			return authorize(tx, authority(stored.parse(row[0])), providerId);
		});
		if (!initial) throw Error("recovery_unavailable");
		let observed: TransportOutcome;
		try {
			observed = await config.transport.lookup(providerId, AbortSignal.timeout(10_000));
		} catch {
			return { kind: "unknown" } as const;
		}
		if (observed.kind !== "accepted" || observed.id !== providerId) return { kind: "unknown" } as const;
		return transaction(config.db, async (tx) => {
			const row = await tx
				.select()
				.from(tables.mail)
				.where(and(eq(tables.mail.id, mailId), eq(tables.mail.state, "unknown")))
				.for("update");
			if (!row.length) return { kind: "unknown" } as const;
			const m = stored.parse(row[0]);
			const evidence = await authorize(tx, authority(m), providerId);
			if (!evidence) throw Error("recovery_unavailable");
			const e = z
				.strictObject({ actorId: z.uuid(), operationId: z.uuid(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/) })
				.parse(evidence);
			if (m.provider_message_id && m.provider_message_id !== providerId) throw Error("provider_receipt_conflict");
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${providerId},32))`);
			const collision = await tx
				.select({ id: tables.mail.id })
				.from(tables.mail)
				.where(and(eq(tables.mail.provider_message_id, providerId), sql<unknown>`(${tables.mail.id} != ${mailId})`));
			if (collision.length) throw Error("provider_receipt_conflict");
			await tx
				.update(tables.mail)
				.set({
					state: "accepted",
					provider_message_id: providerId,
					accepted_at: sql<Date>`coalesce(${tables.mail.accepted_at}, clock_timestamp())`.mapWith(
						(value: string) => new Date(value),
					),
				})
				.where(eq(tables.mail.id, mailId));
			await tx
				.update(tables.job)
				.set({
					state: "succeeded",
					error_code: null,
					finished_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					revision: sql<unknown>`(${tables.job.revision} + 1)`,
				})
				.where(and(eq(tables.job.id, sql`${m.job_id}`), eq(tables.job.state, "reconcile")));
			await tx
				.insert(tables.audit_event)
				.values({
					tenant_id: m.tenant_id,
					subject_id: m.id,
					actor_id: e.actorId,
					command_id: e.operationId,
					kind: "reconcile",
					occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
					event_key: `provider-recovery/${e.operationId}`,
					action: "mail.reconciled",
					reason: `provider_receipt/${e.evidenceHash}`,
				})
				.onConflictDoNothing({ target: [tables.audit_event.subject_id, tables.audit_event.event_key] });
			return observed;
		});
	}
	return {
		append,
		enqueue,
		enqueueMany,
		queued: (inputs: readonly MailIntent[]) => {
			const sealed = sealIntents(inputs);
			return { ids: sealed.map((m) => m.id), ctes: mailInsert(sealed.map((m) => m.row)) };
		},
		dispatch,
		reconcileUnknownOutcome,
		recordProviderReceipt,
		addressHash: (address: string) =>
			createHmac("sha256", addressKey).update(z.email().parse(address).trim().toLowerCase()).digest("hex"),
	};
}

// The only automatic replay of an unknown effect keeps its entire original request/key.
export async function claimUnknownMail(db: Database, limit = 1): Promise<Claim[]> {
	z.number().int().min(1).max(100).parse(limit);
	const rows = await db.execute(sql`WITH due AS (
    SELECT j.id FROM job j JOIN mail m ON m.id=j.subject_record_id
    JOIN mail_request_member mm ON mm.mail_id=m.id JOIN mail_request r ON r.id=mm.request_id
    WHERE j.kind='mail' AND j.state='reconcile' AND j.attempt_count<j.max_attempts AND m.state='unknown'
    AND r.first_dispatched_at+interval '23 hours 55 minutes'>clock_timestamp()
    AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=clock_timestamp())
    ORDER BY j.eligible_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT ${limit})
    UPDATE job j SET state='claimed',attempt_count=attempt_count+1,claim_generation=claim_generation+1,
    lease_owner=${randomUUID()},lease_until=clock_timestamp()+make_interval(secs=>${DEFAULT_LEASE_SECONDS}),revision=revision+1
    FROM due WHERE j.id=due.id RETURNING j.*`);
	return rows.rows.map((row) => claimSchema.parse(row));
}
