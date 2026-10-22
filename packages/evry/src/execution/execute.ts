import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { RequestActor } from "@everyfield/domain/access";
import { Refusal } from "@everyfield/domain/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { owner, sessionId } from "@everyfield/contracts/common";
import { z } from "zod";
import { EvryRefusal } from "../context/errors.ts";
import { REVIEWED_WRITES } from "../proposals/store.ts";
import type { ReviewedWrite } from "../proposals/types.ts";

/** The executor's claim on one evry_effect job, as the WP-031 queue issued it. Only the current claim may publish. */
export type EffectLease = { jobId: string; tenantId: string; leaseOwner: string; generation: string };

/**
 * completed, refused or failed: the outcome saved with this attempt. expired: the approval lapsed before the effect
 * started, so nothing ran. closed: the review was cancelled or revised first. lost: this claim is no longer current.
 */
export type EffectOutcome = "completed" | "refused" | "failed" | "expired" | "closed" | "lost";

/** This exact claim is still current. */
const fence = (lease: EffectLease) =>
	sql`EXISTS(SELECT FROM job j WHERE j.id=${lease.jobId}::uuid AND j.tenant_id=${lease.tenantId}::uuid AND j.state='claimed'
		AND j.lease_owner=${lease.leaseOwner} AND j.claim_generation=${lease.generation}::bigint AND j.lease_until>clock_timestamp())`;

/**
 * Takes the publication locks before any time is read: the proposal row, then a share lock on the job row, so lease
 * recovery cannot replace the claim before this transaction ends. A predicate inside a locking statement is evaluated
 * before its lock wait and not again for an unchanged row, so the lease and approval expiry are read only by the next
 * statement, after every lock is held.
 */
async function holdPublicationLocks(tx: Transaction, lease: EffectLease, proposal = true) {
	if (proposal)
		await tx.execute(
			sql`SELECT 1 FROM proposal WHERE job_id=${lease.jobId}::uuid AND tenant_id=${lease.tenantId}::uuid FOR UPDATE`,
		);
	await tx.execute(
		sql`SELECT 1 FROM job WHERE id=${lease.jobId}::uuid AND tenant_id=${lease.tenantId}::uuid FOR SHARE`,
	);
}

const locked = z.object({
	id: z.uuid(),
	account_id: z.uuid(),
	tenant_id: z.uuid(),
	context_kind: z.enum(["account", "plant", "sending_church", "sending_network"]),
	operation: z.enum(Object.keys(REVIEWED_WRITES) as [keyof typeof REVIEWED_WRITES]),
	revision: z.number().int(),
	input: z.unknown(),
	state: z.string(),
	outcome: z.string().nullable(),
	approved_session_id: z.uuid().nullable(),
	expired: z.boolean(),
	fenced: z.boolean(),
});

/** The refusal code a person sees for a domain refusal; a changed target asks for a new review. */
const refusalCode = (code: string) =>
	code === "conflict" ? "revision_conflict" : code === "unavailable" ? "access_denied" : code;

/** The approval lapsed or the claim stopped being current, possibly during a wait; the whole transaction rolls back. */
class Unpublished extends Error {}

class Refused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

/**
 * evry.executeProposal and evry.expireProposal: runs one approved proposal revision once. One transaction locks the
 * proposal under the current job claim, refuses an approval that lapsed (expiresAt itself is too late), runs the
 * owning native command for the approving session (which checks its live seat and role) with the effect key as its
 * request key and saves the outcome only if the approval is unexpired and the claim still current once the publication
 * locks are held. The native command writes its own audit row with the change, so the effect, its audit record and the
 * saved outcome commit together or not at all. A refusal rolls everything back and then saves the refusal under the
 * same claim. `reminders` is the task reminder port for a command that hands tasks to someone else.
 */
export async function executeProposal(
	db: Database,
	lease: EffectLease,
	reminders: TaskReminders,
): Promise<EffectOutcome> {
	try {
		return await db.transaction(async (tx) => {
			const r = await tx.execute(sql`
				SELECT p.id,p.account_id,p.tenant_id,c.context_kind,p.operation,p.revision,p.input,p.state,p.outcome,p.approved_session_id,
					p.expires_at<=clock_timestamp() AS expired,${fence(lease)} AS fenced
				FROM proposal p JOIN conversation c ON c.id=p.conversation_id
				WHERE p.job_id=${lease.jobId}::uuid AND p.tenant_id=${lease.tenantId}::uuid FOR UPDATE OF p`);
			if (!r.rows.length) return "lost";
			const p = locked.parse(r.rows[0]);
			if (!p.fenced) return "lost";
			if (p.state !== "approved" || p.outcome !== null) return "closed";
			if (p.expired) throw new Unpublished();
			// The approving session in the proposal's exact context: its live seat and lifecycle are locked and checked now,
			// and the native command checks the role on that same lock. A signed-out session has no authority.
			const session = sessionId.safeParse(p.approved_session_id);
			if (!session.success) throw new Refused("access_denied");
			const selected = owner.parse(
				p.context_kind === "account" || p.context_kind === "plant"
					? { kind: p.context_kind, id: p.tenant_id }
					: { kind: "organization", id: p.tenant_id, organizationKind: p.context_kind },
			);
			if (!(await RequestActor.claimWrite(tx, session.data, selected))) throw new Refused("access_denied");
			const write = REVIEWED_WRITES[p.operation] as ReviewedWrite<unknown>;
			const result = await write.execute(
				tx,
				{ session: session.data, selected },
				p.input,
				`evry:${p.id}:${p.revision}`,
				reminders,
			);
			if ("refused" in result) throw new Refused(refusalCode(result.refused));
			// Publish only if the approval is still unexpired and this claim still current once every lock is held;
			// otherwise the change and its audit row roll back with the transaction.
			await holdPublicationLocks(tx, lease, false);
			const published = await tx.execute(
				sql`UPDATE proposal SET outcome='completed',receipt=${JSON.stringify(result)}::jsonb,updated_at=clock_timestamp()
					WHERE id=${p.id}::uuid AND expires_at>clock_timestamp() AND ${fence(lease)}`,
			);
			if (!published.rowCount) throw new Unpublished();
			return "completed";
		});
	} catch (error) {
		// evry.expireProposal: an approval that lapsed before the effect committed expires under the same claim.
		if (error instanceof Unpublished) {
			const expired = await db.transaction(async (tx) => {
				await holdPublicationLocks(tx, lease);
				return tx.execute(sql`
					UPDATE proposal SET state='expired',approved_at=NULL,approved_session_id=NULL,updated_at=clock_timestamp()
					WHERE job_id=${lease.jobId}::uuid AND tenant_id=${lease.tenantId}::uuid AND state='approved' AND outcome IS NULL
						AND expires_at<=clock_timestamp() AND ${fence(lease)}`);
			});
			return expired.rowCount ? "expired" : "lost";
		}
		const refused =
			error instanceof Refused
				? error.code
				: error instanceof Refusal
					? refusalCode(error.code)
					: error instanceof EvryRefusal
						? error.code
						: error instanceof Error && error.message === "unavailable"
							? "access_denied"
							: null;
		const outcome = refused ? "refused" : "failed";
		const saved = await db.transaction(async (tx) => {
			await holdPublicationLocks(tx, lease);
			return tx.execute(sql`
				UPDATE proposal SET outcome=${outcome},receipt=jsonb_build_object('code',${refused ?? "unknown"}::text),updated_at=clock_timestamp()
				WHERE job_id=${lease.jobId}::uuid AND tenant_id=${lease.tenantId}::uuid AND state='approved' AND outcome IS NULL AND ${fence(lease)}`);
		});
		return saved.rowCount ? outcome : "lost";
	}
}
