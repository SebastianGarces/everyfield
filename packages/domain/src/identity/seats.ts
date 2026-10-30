import { sameOwner, sessionId, type Owner } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/identity";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, asc, eq, getTableColumns, inArray, isNull, notInArray, or, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import "server-only";
import { z } from "zod";
import { type RequestActor } from "../access/session.ts";
import { reminderChange, syncAll, type TaskReminders } from "../tasks/writes.ts";
import { transaction } from "./budget.ts";
import * as d from "./invitation-core.ts";
const seatListRow = z.object({
	id: z.uuid(),
	account_id: z.uuid(),
	role: z.string(),
	revision: z.string(),
	ended_at: z.coerce.date().nullable(),
	display_name: z.string(),
	created_at: z.coerce.date(),
	invitation_id: z.uuid().nullable(),
	acted_at: z.coerce.date().nullable(),
});
const inWorkspace = (selected: Owner) =>
	selected.kind === "plant" ? eq(t.seat.plant_id, selected.id) : eq(t.seat.organization_id, selected.id);
export function createSeatService(db: Database) {
	/** The roster in one statement without a transaction: seats with their account name and accepted invitation. */
	async function list(authority: RequestActor, raw: unknown) {
		const v = c.listSeatsRequest.parse(raw),
			a = authority.actor,
			seat = a.context;
		if (seat.kind !== "seat" || !sameOwner(seat.owner, v.workspace)) d.refuse();
		const column = v.workspace.kind === "plant" ? sql`s.plant_id` : sql`s.organization_id`;
		const rows = z.array(seatListRow).parse(
			(
				await db.execute(sql`SELECT s.id, s.account_id, s.role, s.revision::text AS revision, s.ended_at,
					i.display_name, i.created_at, inv.id AS invitation_id, inv.acted_at
				FROM seat s CROSS JOIN LATERAL seat_identity(s.account_id) i
				LEFT JOIN invitation inv ON inv.id=s.invitation_id AND inv.tenant_id=${v.workspace.id}
					AND inv.state='accepted' AND inv.accepted_account_id=s.account_id
				WHERE ${column}=${v.workspace.id} ${v.after ? sql`AND s.id>${v.after}` : sql``}
				ORDER BY s.id LIMIT 101`)
			).rows,
		);
		const items = rows.slice(0, 100).map((s) => ({
			seatId: s.id,
			displayName: s.display_name,
			role: s.role,
			revision: s.revision,
			status: s.ended_at ? "removed" : "active",
			isSelf: s.account_id === a.accountId,
			joined: s.acted_at
				? { source: "accepted_invitation", invitationId: s.invitation_id, at: s.acted_at.toISOString() }
				: { source: "original_account_fallback", at: s.created_at.toISOString() },
			allowedActions:
				seat.role !== "member" && s.role !== "owner" && !s.ended_at
					? s.role === "admin"
						? ["demote", "remove"]
						: ["appoint_admin", "remove"]
					: [],
		}));
		return c.seatListResult.parse({
			workspace: v.workspace,
			items,
			next: rows.length > 100 ? items.at(-1)!.seatId : null,
			completeness: rows.length > 100 ? "partial" : "complete",
		});
	}
	async function membership(session: string) {
		return transaction(db, async (tx) => {
			// Membership needs a current session, not the exclusive account claim used by acceptance.
			const proof = await tx.execute(sql`SELECT * FROM access_session(${sessionId.parse(session)}::uuid)`);
			if (!proof.rows[0]) d.refuse();
			const a = z
				.object({ account_id: z.uuid(), registration_state: z.enum(["active", "pending_domain"]) })
				.parse(proof.rows[0]);
			if (a.registration_state !== "active") return c.currentMembershipResult.parse({ status: "unavailable" });
			const seats = await tx
				.select()
				.from(t.seat)
				.where(and(eq(t.seat.account_id, a.account_id), isNull(t.seat.ended_at)));
			if (!seats.length) return c.currentMembershipResult.parse({ status: "seatless" });
			if (seats.length !== 1) d.refuse();
			const s = seats[0]!,
				w = await d.workspace(tx, s.plant_id ?? s.organization_id!),
				actor = await d.currentActor(tx, sessionId.parse(session), w.selected);
			return c.currentMembershipResult.parse(
				actor.status === "active"
					? { status: "active", workspace: w.selected, seatId: s.id, role: s.role, revision: s.revision }
					: { status: "unavailable" },
			);
		});
	}
	async function eligible(tx: Transaction, selected: Owner, account: string) {
		const [s] = await tx
			.select({ id: t.seat.id })
			.from(t.seat)
			.innerJoin(t.account, eq(t.account.id, t.seat.account_id))
			.where(
				and(
					inWorkspace(selected),
					eq(t.seat.account_id, account),
					isNull(t.seat.ended_at),
					eq(t.account.registration_state, "active"),
					sql`${t.seat.accepted_at}<=clock_timestamp()`,
				),
			)
			.for("share", { of: [t.seat, t.account] });
		if (!s) return null;
		const blocked = await tx
			.select({ id: t.lifecycle_witness.id })
			.from(t.lifecycle_witness)
			.where(
				and(
					or(eq(t.lifecycle_witness.opaque_subject_id, account), eq(t.lifecycle_witness.seat_id, s.id)),
					notInArray(t.lifecycle_witness.state, ["active", "cancelled"]),
				),
			)
			.for("share");
		return blocked.length ? null : s;
	}
	/**
	 * The open duties a removal must hand off (REQ-IDN-019), in one place for remove and its review (ruling D52).
	 * Remove holds every duty until it commits; the review reads without locks, so it never changes lock order.
	 */
	async function openDuties(tx: Transaction, selected: Owner, s: { id: string; account_id: string }, lock: boolean) {
		const locked = <T>(q: PromiseLike<T> & { for(strength: "update"): PromiseLike<T> }) => (lock ? q.for("update") : q);
		const plant = selected.kind === "plant";
		// Only the task table: a moved task's reminders need its own columns and the plant's zone. The task domain's full
		// row query costs about 700 ms for 250 tasks, and remove would hold the account and seat locks meanwhile (BUG-127).
		const tasks = plant
			? await locked(
					tx
						.select({
							...getTableColumns(t.task),
							plant_zone: sql<string>`(SELECT p.timezone FROM plant p WHERE p.id=${selected.id}::uuid)`,
							// Every assignee of the task: a handoff replaces only this account, and the others keep their reminders.
							assignee_ids: sql<
								string[]
							>`(SELECT coalesce(array_agg(ta.account_id),'{}') FROM task_assignee ta WHERE ta.task_id=task.id)`,
						})
						.from(t.task)
						.where(
							and(
								eq(t.task.plant_id, selected.id),
								sql`EXISTS(SELECT FROM task_assignee ta WHERE ta.task_id=${t.task.id} AND ta.account_id=${s.account_id}::uuid)`,
								isNull(t.task.deleted_at),
								notInArray(t.task.status, ["complete", "no_longer_needed"]),
							),
						)
						.orderBy(asc(t.task.id)),
				)
			: [];
		const organization = selected.kind === "organization";
		const pipeline = organization
			? await locked(
					tx
						.select()
						.from(t.pipeline_person)
						.where(
							and(eq(t.pipeline_person.organization_id, selected.id), eq(t.pipeline_person.responsible_seat_id, s.id)),
						)
						.orderBy(asc(t.pipeline_person.id)),
				)
			: [];
		const programs = organization
			? await locked(
					tx
						.select()
						.from(t.development_program)
						.where(
							and(
								eq(t.development_program.organization_id, selected.id),
								eq(t.development_program.director_seat_id, s.id),
							),
						)
						.orderBy(asc(t.development_program.id)),
				)
			: [];
		return { tasks, pipeline, programs };
	}
	/**
	 * What removing this seat will need (ruling D52): the seat's revision and role, each open duty with its revision,
	 * and the seats that may receive a duty. The same Owner or Admin check and the same duty selection as remove.
	 */
	async function readRemoval(session: string, selected: Owner, raw: unknown) {
		const v = c.readRemovalRequest.parse(raw);
		return transaction(db, async (tx) => {
			await d.readAdministrator(tx, session, selected);
			const [s] = await tx
				.select()
				.from(t.seat)
				.where(and(eq(t.seat.id, v.seatId), inWorkspace(selected)));
			if (!s || s.ended_at) d.refuse();
			if (s.role === "owner") d.refuse("protected_owner");
			const { tasks, pipeline, programs } = await openDuties(tx, selected, s, false);
			const personIds = pipeline.map((p) => p.person_id).filter((id): id is string => typeof id === "string");
			const people = personIds.length
				? await tx
						.select({ id: t.person.id, name: t.person.display_name })
						.from(t.person)
						.where(and(inArray(t.person.id, personIds), eq(t.person.tenant_id, selected.id)))
				: [];
			const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
			const duties = [
				...tasks.map((x) => ({ dutyId: x.id, expectedRevision: x.revision, kind: "task", label: x.title })),
				...pipeline.map((p) => ({
					dutyId: p.id,
					expectedRevision: p.revision,
					kind: "pipeline_person",
					label: nameOf(p.person_id) ?? "A person in your pipeline",
				})),
				...programs.map((p) => ({ dutyId: p.id, expectedRevision: p.revision, kind: "program", label: p.name })),
			].map((x) => ({ ...x, needsRecipient: x.kind === "program" }));
			const others = await tx
				.select({ account_id: t.seat.account_id })
				.from(t.seat)
				.where(and(inWorkspace(selected), isNull(t.seat.ended_at)))
				.orderBy(asc(t.seat.id));
			// Every active seat is checked with the same eligibility rule remove uses, so no eligible person is hidden.
			const able: string[] = [];
			for (const o of others)
				if (o.account_id !== s.account_id && (await eligible(tx, selected, o.account_id))) able.push(o.account_id);
			if (duties.length > c.MAX_REMOVAL_ITEMS || able.length > c.MAX_REMOVAL_ITEMS) d.refuse("removal_too_large");
			const recipients = [];
			for (const id of able) {
				const info = await tx.execute(sql`SELECT * FROM seat_identity(${id}::uuid)`);
				const name = z.object({ display_name: z.string() }).parse(info.rows[0]).display_name;
				recipients.push({ accountId: id, displayName: name });
			}
			return c.removalReviewResult.parse({
				seatId: s.id,
				expectedRevision: s.revision,
				expectedRole: s.role,
				duties,
				recipients,
			});
		});
	}
	async function mutation(
		session: RequestActor,
		selected: Owner,
		raw: unknown,
		mode: "role" | "remove" | "appoint" | "demote",
		reminders?: TaskReminders,
	) {
		const v = (
			mode === "remove"
				? c.removeSeatRequest
				: mode === "appoint"
					? c.appointAdminRequest
					: mode === "demote"
						? c.demoteSeatRequest
						: c.changeOrdinaryRoleRequest
		).parse(raw);
		return d.writeAsAdministrator(db, session, selected, async (tx, bound) => {
			const a = bound.actor;
			const cmd = await d.begin(
				tx,
				selected,
				a.accountId,
				mode === "remove"
					? "seats.remove"
					: mode === "appoint"
						? "seats.appointAdmin"
						: mode === "demote"
							? "seats.demote"
							: "seats.changeOrdinaryRole",
				v,
			);
			if (cmd.kind === "replay") return c.seatMutationResult.parse(cmd.result);
			// The seat's account is locked before the seat, in one statement that finds it.
			const [target] = await tx
				.select({ id: t.account.id })
				.from(t.account)
				.where(
					eq(
						t.account.id,
						tx
							.select({ account_id: t.seat.account_id })
							.from(t.seat)
							.where(and(eq(t.seat.id, v.input.seatId), inWorkspace(selected))),
					),
				)
				.for("update");
			if (!target) d.refuse();
			const [s] = await tx
				.select()
				.from(t.seat)
				.where(and(eq(t.seat.id, v.input.seatId), inWorkspace(selected)))
				.for("update");
			if (!s) d.refuse();
			if (s.role === "owner") d.refuse("protected_owner");
			if (s.ended_at) d.refuse();
			if (s.revision !== v.expectedRevision || s.role !== v.input.expectedRole) d.refuse("conflict");
			const changed = mode === "remove" || ("to" in v.input && s.role !== v.input.to),
				after = changed ? d.bump(s.revision) : s.revision;
			const duties: Array<
					{ status: "moved"; dutyId: string; recipientAccountId: string } | { status: "needs_owner"; dutyId: string }
				> = [],
				events: string[] = [];
			// Each moved task's owed reminders follow it: the new assignee's are planned, the removed member's withdrawn.
			const replan: Array<ReturnType<typeof reminderChange>> = [];
			if (mode === "remove" && "handoffs" in v.input) {
				const handoffs = v.input.handoffs;
				const { tasks, pipeline, programs } = await openDuties(tx, selected, s, true);
				const all = [...tasks, ...pipeline, ...programs];
				if (all.length > c.MAX_REMOVAL_ITEMS) d.refuse("removal_too_large");
				const named = new Map<string, string>(handoffs.map((h) => [h.dutyId, h.expectedRevision]));
				if (all.length !== handoffs.length || all.some((x) => named.get(x.id) !== x.revision)) d.refuse("conflict");
				const assigned = handoffs.flatMap((h) => (h.kind === "assign" ? [h.recipientAccountId] : []));
				const eligibleRows = assigned.length
					? await tx
							.select({ id: t.seat.id, account: t.seat.account_id })
							.from(t.seat)
							.innerJoin(t.account, eq(t.account.id, t.seat.account_id))
							.where(
								and(
									inWorkspace(selected),
									inArray(t.seat.account_id, assigned),
									isNull(t.seat.ended_at),
									eq(t.account.registration_state, "active"),
									sql`${t.seat.accepted_at}<=clock_timestamp()`,
									sql`NOT EXISTS(SELECT FROM lifecycle_witness w WHERE (w.opaque_subject_id=${t.seat.account_id} OR w.seat_id=${t.seat.id}) AND w.state NOT IN ('active','cancelled'))`,
								),
							)
							.orderBy(asc(t.seat.id))
							.for("share", { of: [t.seat, t.account] })
					: [];
				const recipients = new Map(eligibleRows.map((r) => [r.account, r.id]));
				const taskMoves = new Map<string, string | null>(),
					personMoves = new Map<string, string | null>(),
					programMoves = new Map<string, string | null>();
				const dutyEvents: Array<ReturnType<typeof d.eventRow>> = [];
				for (const h of handoffs) {
					let recipient: string | null = null,
						recipientSeat: string | null = null;
					if (h.kind === "assign") {
						if (h.recipientAccountId === s.account_id) d.refuse();
						if (!recipients.has(h.recipientAccountId)) d.refuse();
						recipient = h.recipientAccountId;
						recipientSeat = recipients.get(recipient)!;
						duties.push({ status: "moved", dutyId: h.dutyId, recipientAccountId: recipient });
					} else duties.push({ status: "needs_owner", dutyId: h.dutyId });
					const task = tasks.find((x) => x.id === h.dutyId),
						person = pipeline.find((x) => x.id === h.dutyId),
						program = programs.find((x) => x.id === h.dutyId);
					if (task) {
						taskMoves.set(task.id, recipient);
						// D-d: the recipient takes this account's place; when it already holds the task, this account only leaves.
						const named = (ids: string[]) => ids.map((accountId) => ({ accountId, displayName: "", seated: true }));
						replan.push(
							reminderChange(
								selected.id,
								{ ...task, assignees: named(task.assignee_ids) },
								{
									...task,
									assignees: named([
										...task.assignee_ids.filter((a) => a !== s.account_id && a !== recipient),
										...(recipient ? [recipient] : []),
									]),
									revision: d.bump(task.revision),
								},
							),
						);
						dutyEvents.push(d.eventRow(cmd, task.id, "assign", "tasks.changed", task.revision, d.bump(task.revision)));
					} else if (person) {
						personMoves.set(person.id, recipientSeat);
						dutyEvents.push(
							d.eventRow(cmd, person.id, "assign", "people.updated", person.revision, d.bump(person.revision)),
						);
					} else if (program) {
						if (!recipientSeat) d.refuse("conflict");
						programMoves.set(program.id, recipientSeat);
						dutyEvents.push(
							d.eventRow(cmd, program.id, "assign", "roles.changed", program.revision, d.bump(program.revision)),
						);
					}
				}
				// All duties are already locked and revision-checked. One update per kind and
				// one audit insert keep lock duration independent of per-duty network latency.
				const assignment = (moves: Map<string, string | null>, id: ReturnType<typeof sql>) =>
					sql`CASE ${id} ${sql.join(
						[...moves].map(([key, recipient]) => sql`WHEN ${key}::uuid THEN ${recipient}::uuid`),
						sql` `,
					)} END`;
				if (taskMoves.size) {
					const ids = [...taskMoves.keys()];
					const moves = [...taskMoves].flatMap(([id, account]) => (account ? [{ id, account }] : []));
					cmd.writes.push(
						tx
							.update(t.task)
							.set({ revision: sql`${t.task.revision}+1` })
							.where(inArray(t.task.id, ids)),
						sql`DELETE FROM task_assignee WHERE account_id=${s.account_id}::uuid AND task_id=ANY(${sql.param(ids)}::uuid[])`,
						...(moves.length
							? [
									sql`INSERT INTO task_assignee (plant_id, task_id, account_id)
										SELECT ${selected.id}::uuid, m.id, m.account FROM jsonb_to_recordset(${JSON.stringify(moves)}::jsonb)
										AS m(id uuid, account uuid) ON CONFLICT DO NOTHING`,
								]
							: []),
					);
				}
				if (personMoves.size)
					cmd.writes.push(
						tx
							.update(t.pipeline_person)
							.set({
								responsible_seat_id: assignment(personMoves, sql`${t.pipeline_person.id}`),
								revision: sql`${t.pipeline_person.revision}+1`,
							})
							.where(inArray(t.pipeline_person.id, [...personMoves.keys()])),
					);
				if (programMoves.size)
					cmd.writes.push(
						tx
							.update(t.development_program)
							.set({
								director_seat_id: assignment(programMoves, sql`${t.development_program.id}`),
								revision: sql`${t.development_program.revision}+1`,
							})
							.where(inArray(t.development_program.id, [...programMoves.keys()])),
					);
				if (dutyEvents.length) {
					cmd.events.push(...dutyEvents);
					events.push(...dutyEvents.map((e) => e.id));
				}
				if (selected.kind === "plant") {
					const teams = await tx
						.select()
						.from(t.team)
						.where(
							and(
								eq(t.team.plant_id, selected.id),
								sql`${t.team.leader_person_id} IN (SELECT id FROM person WHERE plant_id=${selected.id}::uuid AND linked_account_id=${s.account_id}::uuid)`,
							),
						)
						.orderBy(asc(t.team.id))
						.for("update");
					if (teams.length)
						cmd.writes.push(
							tx
								.update(t.team)
								.set({
									leader_person_id: null,
									leader_source: null,
									leader_role_id: null,
									revision: sql`${t.team.revision}+1`,
								})
								.where(
									inArray(
										t.team.id,
										teams.map((team) => team.id),
									),
								),
						);
					for (const team of teams)
						events.push(
							await d.event(tx, cmd, team.id, "leader_change", "teams.changed", team.revision, d.bump(team.revision)),
						);
				}
				await tx
					.update(t.seat)
					.set({ ended_at: sql`clock_timestamp()`, revision: after })
					.where(eq(t.seat.id, s.id));
				await tx.execute(sql`SELECT revoke_removed_seat_sessions(${s.account_id}::uuid)`);
			} else if ("to" in v.input && changed)
				cmd.writes.push(tx.update(t.seat).set({ role: v.input.to, revision: after }).where(eq(t.seat.id, s.id)));
			if (changed)
				events.push(
					await d.event(
						tx,
						cmd,
						s.id,
						mode === "remove" ? "remove" : "role_change",
						mode === "remove" ? "membership.ended" : "membership.role_changed",
						s.revision,
						after,
					),
				);
			const result = await d.finish(tx, cmd, () =>
				c.seatMutationResult.parse({
					seatId: s.id,
					revision: after,
					outcome: changed ? "changed" : "noop",
					duties,
				}),
			);
			// The sync reads each task at its new revision, so it runs after the final write moved them.
			await syncAll(reminders!, tx, replan)?.();
			return result;
		});
	}
	return {
		list,
		readCurrentMembership: membership,
		readRemoval,
		changeOrdinaryRole: (s: RequestActor, o: Owner, v: unknown) => mutation(s, o, v, "role"),
		appointAdmin: (s: RequestActor, o: Owner, v: unknown) => mutation(s, o, v, "appoint"),
		demote: (s: RequestActor, o: Owner, v: unknown) => mutation(s, o, v, "demote"),
		/** Moved tasks replan their owed reminders through `reminders` in the same transaction (REQ-TSK-014). */
		remove: (s: RequestActor, o: Owner, v: unknown, reminders: TaskReminders) => mutation(s, o, v, "remove", reminders),
	};
}
