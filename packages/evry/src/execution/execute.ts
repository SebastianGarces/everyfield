import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { RequestActor } from "@everyfield/domain/access";
import { CommunicationRefusal } from "@everyfield/domain/communication";
import { Refusal } from "@everyfield/domain/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { owner, sessionId } from "@everyfield/contracts/common";
import { z } from "zod";
import { EvryRefusal } from "../context/errors.ts";
import { REVIEWED_WRITES } from "../proposals/store.ts";
import type { EffectResult, MailPort, ReviewedWrite } from "../proposals/types.ts";

/** The executor's claim on one evry_effect job, as the WP-031 queue issued it. Only the current claim may publish. */
export type EffectLease = { jobId: string; tenantId: string; leaseOwner: string; generation: string };

/**
 * completed or refused: the outcome saved with this attempt. failed: the attempt ended with an error that is not a
 * domain refusal, so nothing is saved and the review reads as unknown (the change may have committed). expired: the
 * approval lapsed before the effect started, so nothing ran. closed: the review was cancelled or revised first. lost:
 * this claim is no longer current.
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
 * statement, after every lock is held. The run itself takes both locks in its first read (executeProposal); a
 * refusal or an expiry, which saves under a new transaction, takes them here.
 */
async function holdPublicationLocks(tx: Transaction, lease: EffectLease) {
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

type Done = Extract<EffectResult, { receiptId: string }>;
/** The first step committed; the email service step is next. */
type Reach = {
	write: ReviewedWrite<unknown>;
	authority: RequestActor;
	input: unknown;
	effectKey: string;
	result: Done;
	id: string;
};

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
 * same claim. Any other error saves nothing: only a server answer may say that nothing was changed (C58). `reminders`
 * is the task reminder port for a command that hands tasks to someone else.
 */
export async function executeProposal(
	db: Database,
	lease: EffectLease,
	reminders: TaskReminders,
	mail: MailPort | null = null,
): Promise<EffectOutcome> {
	try {
		const first = await db.transaction(async (tx): Promise<EffectOutcome | Reach> => {
			const r = await tx.execute(sql`
				SELECT p.id,p.account_id,p.tenant_id,c.context_kind,p.operation,p.revision,p.input,p.state,p.outcome,p.approved_session_id,
					p.expires_at<=clock_timestamp() AS expired,${fence(lease)} AS fenced
				FROM proposal p JOIN conversation c ON c.id=p.conversation_id JOIN job j ON j.id=p.job_id AND j.tenant_id=p.tenant_id
				WHERE p.job_id=${lease.jobId}::uuid AND p.tenant_id=${lease.tenantId}::uuid FOR UPDATE OF p FOR SHARE OF j`);
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
			const claimed = await RequestActor.claimWrite(tx, session.data, selected);
			if (!claimed) throw new Refused("access_denied");
			const write = REVIEWED_WRITES[p.operation] as ReviewedWrite<unknown>;
			// A write that reaches the email service cannot run without it; nothing has changed yet.
			if (write.reach && !mail) throw new Refused("mail_unavailable");
			const effectKey = `evry:${p.id}:${p.revision}`;
			const result = await write.execute(tx, { session: session.data, selected }, p.input, effectKey, reminders);
			if ("refused" in result) throw new Refused(refusalCode(result.refused));
			// The email service is called after this transaction commits, never inside it.
			if (write.reach) return { write, authority: claimed.authority, input: p.input, effectKey, result, id: p.id };
			// Publish only if the approval is still unexpired and this claim still current; the first read already holds
			// the proposal and job locks. Otherwise the change and its audit row roll back with the transaction.
			const published = await tx.execute(
				sql`UPDATE proposal SET outcome='completed',receipt=${JSON.stringify(result)}::jsonb,updated_at=clock_timestamp()
					WHERE id=${p.id}::uuid AND expires_at>clock_timestamp() AND ${fence(lease)}`,
			);
			if (!published.rowCount) throw new Unpublished();
			return "completed";
		});
		if (typeof first === "string") return first;
		// The email service step, outside any transaction. The change above is committed and its domain command replays,
		// so a retry after a crash asks again with the same keys. The outcome is saved even when the approval lapsed in
		// between: the change already happened, and only a lost claim stops the save.
		const reached = await first.write.reach!(db, first.authority, first.input, first.effectKey, first.result, mail!);
		if ("refused" in reached) throw new Refused(refusalCode(reached.refused));
		const saved = await db.transaction(async (tx) => {
			await holdPublicationLocks(tx, lease);
			return tx.execute(
				sql`UPDATE proposal SET outcome='completed',receipt=${JSON.stringify(reached)}::jsonb,updated_at=clock_timestamp()
					WHERE id=${first.id}::uuid AND state='approved' AND outcome IS NULL AND ${fence(lease)}`,
			);
		});
		return saved.rowCount ? "completed" : "lost";
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
				: error instanceof Refusal || error instanceof CommunicationRefusal
					? refusalCode(error.code)
					: error instanceof EvryRefusal
						? error.code
						: null;
		if (!refused) return "failed";
		const saved = await db.transaction(async (tx) => {
			await holdPublicationLocks(tx, lease);
			return tx.execute(sql`
				UPDATE proposal SET outcome='refused',receipt=jsonb_build_object('code',${refused}::text),updated_at=clock_timestamp()
				WHERE job_id=${lease.jobId}::uuid AND tenant_id=${lease.tenantId}::uuid AND state='approved' AND outcome IS NULL AND ${fence(lease)}`);
		});
		return saved.rowCount ? "refused" : "lost";
	}
}
