import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { RequestActor } from "@everyfield/domain/access";
import { CommunicationRefusal } from "@everyfield/domain/communication";
import { MeetingsRefusal } from "@everyfield/domain/meetings";
import { Refusal } from "@everyfield/domain/people";
import { TeamsRefusal } from "@everyfield/domain/teams";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { owner, sessionId } from "@everyfield/contracts/common";
import { fromStates, proposalMachine, type ProposalSubject } from "@everyfield/contracts/machines";
import { z } from "zod";
import { EvryRefusal } from "../context/errors.ts";
import { REVIEWED_WRITES, staleMessage } from "../proposals/store.ts";
import { refusalCode } from "../proposals/review.ts";
import type { EffectResult, MailPort, NativePorts, ReviewedWrite } from "../proposals/types.ts";

export type EffectLease = { jobId: string; tenantId: string; leaseOwner: string; generation: string };

export type EffectOutcome = "completed" | "refused" | "failed" | "expired" | "closed" | "lost";

const queued: ProposalSubject = { now: false, lapsed: false, jobLive: false };
const lapsed: ProposalSubject = { ...queued, lapsed: true };

const fence = (lease: EffectLease) =>
	sql`EXISTS(SELECT FROM job j WHERE j.id=${lease.jobId}::uuid AND j.tenant_id=${lease.tenantId}::uuid AND j.state='claimed'
		AND j.lease_owner=${lease.leaseOwner} AND j.claim_generation=${lease.generation}::bigint AND j.lease_until>clock_timestamp())`;

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
	stale: z.boolean(),
	reached: z.boolean(),
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

const currentState = (() => {
	const writes = (Object.values(REVIEWED_WRITES) as ReviewedWrite<unknown>[]).filter((w) => w.current);
	if (!writes.length) return sql`NULL::jsonb`;
	return sql`CASE proposal.operation ${sql.join(
		writes.map((w) => sql`WHEN ${w.operation} THEN ${w.current!(sql`proposal`)}`),
		sql` `,
	)} END`;
})();

type Reach = { id: string; reach(): Promise<EffectResult> };

class Unpublished extends Error {}

class Refused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export async function executeProposal(
	db: Database,
	lease: EffectLease,
	reminders: TaskReminders,
	mail: MailPort | null = null,
	native: NativePorts | null = null,
): Promise<EffectOutcome> {
	try {
		const first = await db.transaction(async (tx): Promise<EffectOutcome | Reach> => {
			const r = await tx.execute(sql`
				SELECT p.id,p.account_id,p.tenant_id,c.context_kind,p.operation,p.revision,p.input,p.state,p.outcome,p.approved_session_id,
					p.expires_at<=clock_timestamp() AS expired,${fence(lease)} AS fenced,
					${sql.raw(staleMessage("p"))} AS stale,coalesce((p.receipt->>'reached')::boolean,false) AS reached
				FROM proposal p JOIN conversation c ON c.id=p.conversation_id JOIN job j ON j.id=p.job_id AND j.tenant_id=p.tenant_id
				WHERE p.job_id=${lease.jobId}::uuid AND p.tenant_id=${lease.tenantId}::uuid FOR UPDATE OF p FOR SHARE OF j`);
			if (!r.rows.length) return "lost";
			const p = locked.parse(r.rows[0]);
			if (!p.fenced) return "lost";
			if (p.state !== "approved" || p.outcome !== null) return "closed";
			if (p.expired && !p.reached) throw new Unpublished();
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
			const { reach } = write;
			if (reach && !mail) throw new Refused("mail_unavailable");
			const effectKey = `evry:${p.id}:${p.revision}`;
			const context = { session: session.data, selected };
			if (!p.reached) {
				if (p.stale) throw new Refused("revision_conflict");
				const changed = await write.recheck?.(tx, context, p.input);
				if (changed) throw new Refused(changed);
			}
			const result = await write.execute(tx, context, p.input, effectKey, reminders, {
				authority: claimed.authority,
				ports: native,
			});
			if ("refused" in result) throw new Refused(refusalCode(result.refused));
			if (reach && mail && "receiptId" in result) {
				await tx.execute(sql`UPDATE proposal SET receipt='{"reached":true}'::jsonb WHERE id=${p.id}::uuid`);
				return { id: p.id, reach: () => reach(db, claimed.authority, p.input, effectKey, result, mail) };
			}
			const published = await tx.execute(
				sql`UPDATE proposal SET outcome='completed',receipt=${JSON.stringify(result)}::jsonb,updated_at=clock_timestamp()
					WHERE id=${p.id}::uuid AND expires_at>clock_timestamp() AND ${fence(lease)}
						AND concat_ws('_',state,outcome) = ANY(${sql.param(fromStates(proposalMachine, "evry.executeProposal", "approved_completed", queued))}::text[])`,
			);
			if (!published.rowCount) throw new Unpublished();
			return "completed";
		});
		if (typeof first === "string") return first;
		const reached = await first.reach();
		if ("refused" in reached) throw new Refused(refusalCode(reached.refused));
		const saved = await db.transaction(async (tx) => {
			await holdPublicationLocks(tx, lease);
			return tx.execute(
				sql`UPDATE proposal SET outcome='completed',receipt=${JSON.stringify(reached)}::jsonb,updated_at=clock_timestamp()
					WHERE id=${first.id}::uuid AND ${fence(lease)}
						AND concat_ws('_',state,outcome) = ANY(${sql.param(fromStates(proposalMachine, "evry.executeProposal", "approved_completed", queued))}::text[])`,
			);
		});
		return saved.rowCount ? "completed" : "lost";
	} catch (error) {
		if (error instanceof Unpublished) {
			const expired = await db.transaction(async (tx) => {
				await holdPublicationLocks(tx, lease);
				return tx.execute(sql`
					UPDATE proposal SET state='expired',approved_at=NULL,approved_session_id=NULL,updated_at=clock_timestamp()
					WHERE job_id=${lease.jobId}::uuid AND tenant_id=${lease.tenantId}::uuid
						AND concat_ws('_',state,outcome) = ANY(${sql.param(fromStates(proposalMachine, "evry.executeProposal", "expired", lapsed))}::text[])
						AND expires_at<=clock_timestamp() AND ${fence(lease)}`);
			});
			return expired.rowCount ? "expired" : "lost";
		}
		const refused =
			error instanceof Refused
				? error.code
				: error instanceof Refusal ||
					  error instanceof CommunicationRefusal ||
					  error instanceof TeamsRefusal ||
					  error instanceof MeetingsRefusal
					? refusalCode(error.code)
					: error instanceof EvryRefusal
						? error.code
						: null;
		if (!refused) return "failed";
		const saved = await db.transaction(async (tx) => {
			await holdPublicationLocks(tx, lease);
			return tx.execute(sql`
				UPDATE proposal SET outcome='refused',receipt=jsonb_strip_nulls(jsonb_build_object('code',${refused}::text,
					'current',CASE WHEN ${refused}::text IN ('revision_conflict','stale_review') THEN ${currentState} END)),updated_at=clock_timestamp()
				WHERE job_id=${lease.jobId}::uuid AND tenant_id=${lease.tenantId}::uuid AND ${fence(lease)}
					AND concat_ws('_',state,outcome) = ANY(${sql.param(fromStates(proposalMachine, "evry.executeProposal", "approved_refused", queued))}::text[])`);
		});
		return saved.rowCount ? "refused" : "lost";
	}
}
