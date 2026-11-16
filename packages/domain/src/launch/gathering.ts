import {
	calendarContext,
	timeZone,
	type Clock,
	type LocalDate,
	type RequestIdentity,
} from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/launch";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { auditTransaction } from "../operations/writes.ts";
import {
	deny,
	identityOf,
	parse,
	priorKey,
	priorRow,
	replay,
	scopeOf,
	settle,
	type Operation,
	type Scope,
} from "./core.ts";
import { auditCte } from "./outcome.ts";
import { offersTo, planAfter } from "./reads.ts";

const launchRow = z.object({
	status: c.launchStatus,
	revision: z.string(),
	gathering_path: z.enum(["launch_sunday", "milestone"]),
	gathering_organization_id: z.uuid().nullable(),
	gathering_reached_on: z.string().nullable(),
	gathering_reached_name: z.string().nullable(),
	gathering_note: z.string().nullable(),
});
const lockRow = z.object({
	ok: z.boolean(),
	prior: priorRow,
	timezone: timeZone.nullable(),
	launch: launchRow.nullable(),
	offer: z.object({ organizationId: z.uuid(), organizationName: z.string(), name: z.string() }).nullable(),
	current: z.object({ organizationName: z.string(), name: z.string().nullable() }).nullable(),
});
type Locked = Pick<z.infer<typeof lockRow>, "offer" | "current"> & { launch: z.infer<typeof launchRow> };

async function lock(tx: Transaction, scope: Scope, key: string, organization: string | null) {
	const p = sql`${scope.plantId}::uuid`;
	const { rows } = await tx.execute(sql`WITH gate AS (SELECT ${scope.admin} AS ok), ${priorKey(scope, key)},
 cur AS (INSERT INTO launch(plant_id,status) SELECT ${p},'planning'
	WHERE (SELECT ok FROM gate) AND NOT EXISTS(SELECT FROM prior)
	ON CONFLICT (plant_id) DO UPDATE SET status=launch.status
	RETURNING status,revision::text,gathering_path,gathering_organization_id,gathering_reached_on::text,
	gathering_reached_name,gathering_note)
 SELECT (SELECT ok FROM gate) AS ok,(SELECT to_jsonb(prior) FROM prior) AS prior,
	(SELECT timezone FROM plant WHERE id=${p}) AS timezone,(SELECT to_jsonb(cur) FROM cur) AS launch,
	(SELECT jsonb_build_object('organizationId',o.id,'organizationName',o.name,'name',o.gathering_milestone_name)
		FROM organization o WHERE o.id=coalesce(${organization}::uuid,(SELECT gathering_organization_id FROM cur))
		AND ${offersTo("o", p)} FOR SHARE OF o) AS offer,
	(SELECT jsonb_build_object('organizationName',o.name,'name',o.gathering_milestone_name) FROM organization o
		WHERE o.id=(SELECT gathering_organization_id FROM cur)) AS current`);
	return lockRow.parse(rows[0]);
}

export function gatheringCommands(clock: Clock) {
	async function command(
		db: Database,
		authority: RequestActor,
		operation: Operation,
		q: { requestKey: string; expectedRevision: string; input: unknown },
		organization: string | null,
		decide: (
			tx: Transaction,
			scope: Scope,
			l: Locked & { today: LocalDate },
			identity: RequestIdentity,
		) => Promise<"changed" | "noop">,
	) {
		const scope = scopeOf(authority);
		const identity = identityOf(scope, operation, q);
		return auditTransaction(db, async (tx) => {
			const l = await lock(tx, scope, q.requestKey, organization);
			if (l.prior) {
				const stored = z.object({ outcome: z.enum(["changed", "noop"]) }).parse(replay(l.prior, identity));
				return c.planResult.parse({ outcome: stored.outcome, plan: await planAfter(tx, scope, clock) });
			}
			if (!l.ok || !l.launch || !l.timezone) deny("access_denied");
			if (l.launch.revision !== q.expectedRevision) deny("conflict");
			const today = calendarContext(l.timezone, clock).localDate;
			const outcome = await decide(
				tx,
				scope,
				{ launch: l.launch, offer: l.offer, current: l.current, today },
				identity,
			);
			return c.planResult.parse({ outcome, plan: await planAfter(tx, scope, clock) });
		});
	}

	async function save(
		tx: Transaction,
		scope: Scope,
		identity: RequestIdentity,
		set: SQL,
		row: Omit<Parameters<typeof auditCte>[3], "subjectType" | "subjectId" | "from">,
	) {
		await tx.execute(sql`WITH up AS (UPDATE launch SET ${set},revision=revision+1 WHERE plant_id=${scope.plantId}::uuid
	RETURNING plant_id),
 ${auditCte(scope, identity, randomUUID(), { ...row, subjectType: "launch", subjectId: sql`up.plant_id`, from: "up" })}
 SELECT 1`);
		return "changed" as const;
	}

	function checked(input: { date: string; note: string | null }, today: LocalDate) {
		const r = c.checkGathering(input, today);
		if (!r.ok) deny("invalid_gathering", { problem: r.problem });
		return r.value;
	}
	function reasonOf(raw: string) {
		const r = c.checkNote(raw, true);
		if (!r.ok) deny("invalid_reason", { problem: r.problem });
		return r.note;
	}
	function reached(l: Locked) {
		if (l.launch.gathering_path !== "milestone" || !l.launch.gathering_reached_on || !l.launch.gathering_reached_name)
			deny("conflict");
		return { on: l.launch.gathering_reached_on, name: l.launch.gathering_reached_name, note: l.launch.gathering_note };
	}

	return {
		async choosePath(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.choosePathRequest, raw);
				const target = q.input.path === "milestone" ? q.input.organizationId : null;
				return command(db, authority, "launch.choosePath", q, target, async (tx, scope, l, identity) => {
					const was = l.launch;
					if (was.gathering_reached_on) deny("gathering_reached");
					if (was.gathering_path === q.input.path && was.gathering_organization_id === target) return "noop";
					if (was.status === "completed") deny("conflict");
					if (target && !l.offer) deny("gathering_unavailable");
					const before = {
						path: was.gathering_path,
						organizationId: was.gathering_organization_id,
						milestone: l.current?.name ?? null,
						organization: l.current?.organizationName ?? null,
					};
					const after =
						l.offer && target
							? {
									path: "milestone",
									organizationId: target,
									milestone: l.offer.name,
									organization: l.offer.organizationName,
								}
							: { path: "launch_sunday", organizationId: null, milestone: null, organization: null };
					return save(
						tx,
						scope,
						identity,
						sql`gathering_path=${q.input.path},gathering_organization_id=${target}::uuid`,
						{
							action: "launch.changed",
							kind: "edit",
							before,
							after,
							metadata: { event: "path_changed" },
						},
					);
				});
			});
		},
		async recordGathering(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.recordGatheringRequest, raw);
				return command(db, authority, "launch.recordGathering", q, null, async (tx, scope, l, identity) => {
					if (l.launch.gathering_path !== "milestone") deny("conflict");
					const v = checked(q.input, l.today);
					if (l.launch.gathering_reached_on) {
						if (l.launch.gathering_reached_on === v.date && l.launch.gathering_note === v.note) return "noop";
						deny("conflict");
					}
					if (!l.offer) deny("gathering_unavailable");
					return save(
						tx,
						scope,
						identity,
						sql`gathering_reached_on=${v.date}::date,gathering_reached_name=${l.offer.name},gathering_note=${v.note}`,
						{
							action: "launch.changed",
							kind: "create",
							after: { reachedOn: v.date, name: l.offer.name },
							metadata: { event: "gathering_recorded", noteChanged: v.note !== null },
						},
					);
				});
			});
		},
		async correctGathering(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.correctGatheringRequest, raw);
				return command(db, authority, "launch.correctGathering", q, null, async (tx, scope, l, identity) => {
					const was = reached(l);
					const v = checked(q.input, l.today);
					const noteChanged = was.note !== v.note;
					if (was.on === v.date && !noteChanged) return "noop";
					const reason = reasonOf(q.input.reason);
					return save(tx, scope, identity, sql`gathering_reached_on=${v.date}::date,gathering_note=${v.note}`, {
						action: "launch.corrected",
						kind: "correct",
						before: { reachedOn: was.on, name: was.name },
						after: { reachedOn: v.date, name: was.name },
						reason,
						metadata: { event: "gathering_corrected", noteChanged },
					});
				});
			});
		},
		async clearGathering(db: Database, authority: RequestActor, raw: unknown) {
			return settle(async () => {
				const q = parse(c.clearGatheringRequest, raw);
				return command(db, authority, "launch.clearGathering", q, null, async (tx, scope, l, identity) => {
					const was = reached(l);
					const reason = reasonOf(q.input.reason);
					return save(
						tx,
						scope,
						identity,
						sql`gathering_reached_on=NULL,gathering_reached_name=NULL,gathering_note=NULL`,
						{
							action: "launch.corrected",
							kind: "correct",
							before: { reachedOn: was.on, name: was.name },
							after: { reachedOn: null, name: was.name },
							reason,
							metadata: { event: "gathering_cleared", noteChanged: was.note !== null },
						},
					);
				});
			});
		},
	};
}
