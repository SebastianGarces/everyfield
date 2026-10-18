import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../platform/database.ts";
import {
	enqueueJob,
	finishClaim,
	lockClaim,
	checkpoint,
	claimSchema,
	DEFAULT_LEASE_SECONDS,
	type Claim,
} from "./queue.ts";

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
	tx: PoolClient,
	mail: MailAuthority,
	providerId: string,
) => Promise<RecoveryEvidence | null>;
export type AuthorizeMail = (tx: PoolClient, mail: MailAuthority) => Promise<boolean>;
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
	db: Pool;
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
	async function live(tx: PoolClient, m: z.infer<typeof stored>) {
		// Current deletion witnesses override restored or still-present intent rows.
		const barriers = await tx.query(
			`SELECT id FROM lifecycle_witness WHERE opaque_subject_id=ANY($1::uuid[])
      AND state IN ('pending_deletion','purging','purged','revoked') FOR SHARE`,
			[[m.tenant_id, m.recipient_account_id].filter(Boolean)],
		);
		if (barriers.rowCount) return false;
		if (m.notice_id) {
			const notice = await tx.query(
				`SELECT id,category,purpose FROM notice WHERE id=$1 AND tenant_id=$2 AND cancelled_at IS NULL FOR SHARE`,
				[m.notice_id, m.tenant_id],
			);
			if (notice.rowCount !== 1) return false;
			const row = z.object({ category: z.string(), purpose: z.string() }).parse(notice.rows[0]);
			if (row.category === "reference_update") return false;
			const preference = row.category === "digest" ? row.purpose : row.category === "launch" ? "phase" : row.category;
			const choice = await tx.query(
				"SELECT enabled FROM notification_preference WHERE account_id=$1 AND category=$2 AND channel='email'",
				[m.recipient_account_id, preference],
			);
			if (choice.rows[0]?.enabled === false) return false;
		}
		if (m.purpose === "planter_digest" || m.purpose === "oversight_digest") {
			const choice = await tx.query(
				"SELECT enabled FROM notification_preference WHERE account_id=$1 AND category=$2 AND channel='email'",
				[m.recipient_account_id, m.purpose],
			);
			if (choice.rows[0]?.enabled === false) return false;
		}
		return config.authorize(tx, authority(m));
	}
	async function audit(tx: PoolClient, m: z.infer<typeof stored>, key: string, action: string) {
		await tx.query(
			`INSERT INTO event(tenant_id,target_record_id,operation_id,kind,occurred_at,recorded_at,system_cause,event_key,action)
      VALUES($1,$2,$3,'outcome',clock_timestamp(),clock_timestamp(),'mail_transport',$4,$5)
      ON CONFLICT(target_record_id,event_key) DO NOTHING`,
			[m.tenant_id, m.id, m.operation_id, key, action],
		);
	}
	async function enqueue(tx: PoolClient, input: MailIntent): Promise<string> {
		const v = intentSchema.parse(input),
			id = randomUUID();
		const actual = await tx.query("SELECT kind FROM tenant WHERE id=$1", [v.owner.id]);
		if (actual.rows[0]?.kind !== v.owner.kind) throw Error("mail_owner_mismatch");
		if (v.owner.kind === "organization") {
			const org = await tx.query("SELECT kind FROM organization WHERE id=$1 FOR SHARE", [v.owner.id]);
			if (org.rows[0]?.kind !== v.owner.organizationKind) throw Error("mail_owner_mismatch");
		}
		const address = v.address.trim().toLowerCase();
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
		const prior = await tx.query("SELECT id,payload_hash FROM mail WHERE tenant_id=$1 AND logical_key=$2 FOR UPDATE", [
			v.owner.id,
			v.logicalKey,
		]);
		const a: MailAuthority = {
			id: prior.rows[0]?.id ?? id,
			tenant: v.owner.id,
			purpose: v.purpose,
			recipient: v.recipient,
			notice: v.notice,
			operation: v.operation,
			addressHash,
			logicalKey: v.logicalKey,
		};
		const barriers = await tx.query(
			`SELECT id FROM lifecycle_witness WHERE opaque_subject_id=ANY($1::uuid[])
      AND state IN ('pending_deletion','purging','purged','revoked') FOR SHARE`,
			[[v.owner.id, v.recipient].filter(Boolean)],
		);
		if (barriers.rowCount || !(await config.authorize(tx, a))) throw Error("mail_unavailable");
		if (prior.rows[0]) {
			if (prior.rows[0].payload_hash !== hash) throw Error("mail_identity_conflict");
			return z.uuid().parse(prior.rows[0].id);
		}
		const encrypted = seal(JSON.stringify({ ...v.content, from: config.from }), aad(id, v.owner.id, v.purpose));
		const inserted = await tx.query(
			`INSERT INTO mail(id,tenant_id,recipient_account_id,purpose,logical_key,operation_id,notice_id,
      payload_hash,audience_hash,frozen_payload,recipient_address_encrypted,address_hash,state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9,'pending',clock_timestamp())
      ON CONFLICT(tenant_id,logical_key) DO NOTHING RETURNING id`,
			[
				id,
				v.owner.id,
				v.recipient,
				v.purpose,
				v.logicalKey,
				v.operation,
				v.notice,
				hash,
				addressHash,
				{ v: 1, sealed: encrypted },
				seal(address, aad(id, v.owner.id, "address")),
			],
		);
		if (!inserted.rowCount) {
			const original = await tx.query("SELECT id,payload_hash FROM mail WHERE tenant_id=$1 AND logical_key=$2", [
				v.owner.id,
				v.logicalKey,
			]);
			if (original.rows[0]?.payload_hash !== hash) throw Error("mail_identity_conflict");
			return z.uuid().parse(original.rows[0].id);
		}
		// One immutable singleton request, including security/account mail. No regrouping on retry.
		const request = randomUUID();
		await tx.query("INSERT INTO mail_request(id,tenant_id,provider_key,request_hash) VALUES($1,$2,$3,$4)", [
			request,
			v.owner.id,
			`mail/${request}`,
			hash,
		]);
		await tx.query("INSERT INTO mail_request_member(request_id,tenant_id,mail_id,position) VALUES($1,$2,$3,0)", [
			request,
			v.owner.id,
			id,
		]);
		const job = await enqueueJob(tx, {
			tenant: v.owner.id,
			kind: "mail",
			subject: id,
			key: `${id}/1`,
			revision: "1",
			eligibleAt: v.eligibleAt,
			maxAttempts: 4,
		});
		await tx.query("UPDATE mail SET job_id=$2 WHERE id=$1", [id, job]);
		return id;
	}
	async function dispatch(claim: Claim) {
		const prepared = await transaction(config.db, async (tx) => {
			if (claim.kind !== "mail" || !(await lockClaim(tx, claim))) return null;
			const row = await tx.query("SELECT * FROM mail WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [
				claim.subject_record_id,
				claim.tenant_id,
			]);
			const m = stored.parse(row.rows[0]);
			if (!["pending", "refused", "unknown", "dispatched"].includes(m.state)) {
				await finishClaim(tx, claim, { state: m.state === "cancelled" ? "cancelled" : "succeeded" });
				return null;
			}
			if (m.revision !== claim.source_revision || !(await live(tx, m))) {
				if (["unknown", "dispatched"].includes(m.state)) {
					await finishClaim(tx, claim, { state: "reconcile", code: "authority_changed" });
					return null;
				}
				await tx.query("UPDATE mail SET state='cancelled' WHERE id=$1", [m.id]);
				await finishClaim(tx, claim, { state: "cancelled", code: "authority_changed" });
				return null;
			}
			await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,31))", [m.address_hash]);
			const suppressed = await tx.query("SELECT id FROM suppression WHERE address_hash=$1 AND cleared_at IS NULL", [
				m.address_hash,
			]);
			if (suppressed.rowCount) {
				const uncertain = ["unknown", "dispatched"].includes(m.state);
				if (!uncertain) await tx.query("UPDATE mail SET state='refused' WHERE id=$1", [m.id]);
				await finishClaim(tx, claim, { state: uncertain ? "reconcile" : "failed", code: "suppressed" });
				return null;
			}
			const request = await tx.query(
				`SELECT r.*,r.first_dispatched_at IS NOT NULL AND
        r.first_dispatched_at+interval '23 hours 55 minutes'<=clock_timestamp() AS expired
        FROM mail_request r JOIN mail_request_member mm ON mm.request_id=r.id WHERE mm.mail_id=$1 FOR UPDATE OF r`,
				[m.id],
			);
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
			await tx.query(
				"UPDATE mail_request SET first_dispatched_at=coalesce(first_dispatched_at,clock_timestamp()) WHERE id=$1",
				[r.id],
			);
			await tx.query(
				`INSERT INTO mail_attempt(id,tenant_id,request_id,attempt_number,claim_generation,started_at,outcome)
        VALUES($1,$2,$3,$4,$5,clock_timestamp(),'in_flight')`,
				[attempt, m.tenant_id, r.id, claim.attempt_count, claim.claim_generation],
			);
			await tx.query("UPDATE mail SET state='dispatched' WHERE id=$1", [m.id]);
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
			await tx.query(
				`UPDATE mail_attempt SET outcome=$2,completed_at=clock_timestamp(),retryable=$3,safe_error=$4
        WHERE id=$1`,
				[
					attempt,
					outcome.kind,
					outcome.kind === "refused" ? outcome.retryable : null,
					outcome.kind === "unknown" ? "provider_unknown" : null,
				],
			);
			if (outcome.kind === "accepted") {
				z.string().min(1).max(128).parse(outcome.id);
				await tx.query(
					"UPDATE mail SET state='accepted',provider_message_id=$2,accepted_at=coalesce(accepted_at,clock_timestamp()) WHERE id=$1",
					[m.id, outcome.id],
				);
				await audit(tx, m, attempt, "mail.accepted");
				await finishClaim(tx, claim, { state: "succeeded" });
			} else if (outcome.kind === "unknown") {
				await tx.query("UPDATE mail SET state='unknown' WHERE id=$1", [m.id]);
				await finishClaim(tx, claim, { state: "reconcile", code: "provider_unknown" });
			} else {
				await tx.query("UPDATE mail SET state='refused' WHERE id=$1", [m.id]);
				// Authoritative refusal makes this checkpoint safe for the bounded retry path.
				await checkpoint(tx, claim, "refused");
				await audit(tx, m, attempt, "mail.refused");
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
		const row = await config.db.query("SELECT * FROM mail WHERE id=$1", [mailId]);
		const m = stored.parse(row.rows[0]);
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
			const current = await tx.query("SELECT * FROM mail WHERE id=$1 AND state='unknown' FOR UPDATE", [mailId]);
			if (!current.rowCount) return { kind: "unknown" } as const;
			const actual = stored.parse(current.rows[0]);
			if (!(await live(tx, actual))) return { kind: "unknown" } as const;
			await tx.query(
				"UPDATE mail SET state='accepted',accepted_at=coalesce(accepted_at,clock_timestamp()) WHERE id=$1",
				[mailId],
			);
			await tx.query(
				"UPDATE job SET state='succeeded',error_code=NULL,finished_at=clock_timestamp(),revision=revision+1 WHERE id=$1 AND state='reconcile'",
				[actual.job_id],
			);
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
			const row = await tx.query("SELECT * FROM mail WHERE id=$1 AND state='unknown' FOR SHARE", [mailId]);
			if (!row.rowCount) return null;
			return authorize(tx, authority(stored.parse(row.rows[0])), providerId);
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
			const row = await tx.query("SELECT * FROM mail WHERE id=$1 AND state='unknown' FOR UPDATE", [mailId]);
			if (!row.rowCount) return { kind: "unknown" } as const;
			const m = stored.parse(row.rows[0]);
			const evidence = await authorize(tx, authority(m), providerId);
			if (!evidence) throw Error("recovery_unavailable");
			const e = z
				.strictObject({ actorId: z.uuid(), operationId: z.uuid(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/) })
				.parse(evidence);
			if (m.provider_message_id && m.provider_message_id !== providerId) throw Error("provider_receipt_conflict");
			await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,32))", [providerId]);
			const collision = await tx.query("SELECT id FROM mail WHERE provider_message_id=$1 AND id<>$2", [
				providerId,
				mailId,
			]);
			if (collision.rowCount) throw Error("provider_receipt_conflict");
			await tx.query(
				"UPDATE mail SET state='accepted',provider_message_id=$2,accepted_at=coalesce(accepted_at,clock_timestamp()) WHERE id=$1",
				[mailId, providerId],
			);
			await tx.query(
				"UPDATE job SET state='succeeded',error_code=NULL,finished_at=clock_timestamp(),revision=revision+1 WHERE id=$1 AND state='reconcile'",
				[m.job_id],
			);
			await tx.query(
				`INSERT INTO event(tenant_id,target_record_id,actor_id,operation_id,kind,occurred_at,recorded_at,event_key,action,reason)
        VALUES($1,$2,$3,$4,'reconcile',clock_timestamp(),clock_timestamp(),$5,'mail.reconciled',$6)
        ON CONFLICT(target_record_id,event_key) DO NOTHING`,
				[
					m.tenant_id,
					m.id,
					e.actorId,
					e.operationId,
					`provider-recovery/${e.operationId}`,
					`provider_receipt/${e.evidenceHash}`,
				],
			);
			return observed;
		});
	}
	return {
		enqueue,
		dispatch,
		reconcileUnknownOutcome,
		recordProviderReceipt,
		addressHash: (address: string) =>
			createHmac("sha256", addressKey).update(z.email().parse(address).trim().toLowerCase()).digest("hex"),
	};
}

// The only automatic replay of an unknown effect keeps its entire original request/key.
export async function claimUnknownMail(db: Pool, limit = 1): Promise<Claim[]> {
	z.number().int().min(1).max(100).parse(limit);
	const rows = await db.query(
		`WITH due AS (
    SELECT j.id FROM job j JOIN mail m ON m.id=j.subject_record_id
    JOIN mail_request_member mm ON mm.mail_id=m.id JOIN mail_request r ON r.id=mm.request_id
    WHERE j.kind='mail' AND j.state='reconcile' AND j.attempt_count<j.max_attempts AND m.state='unknown'
    AND r.first_dispatched_at+interval '23 hours 55 minutes'>clock_timestamp()
    AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=clock_timestamp())
    ORDER BY j.eligible_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT $1)
    UPDATE job j SET state='claimed',attempt_count=attempt_count+1,claim_generation=claim_generation+1,
    lease_owner=$2,lease_until=clock_timestamp()+make_interval(secs=>$3),revision=revision+1
    FROM due WHERE j.id=due.id RETURNING j.*`,
		[limit, randomUUID(), DEFAULT_LEASE_SECONDS],
	);
	return rows.rows.map((row) => claimSchema.parse(row));
}
