import { requestDatabase } from "@/server/database";
import type { PlantSeat } from "@/server/request-context";
import { outcomeOf, type Outcome } from "@everyfield/contracts/common";
import { tasksMount } from "../tasks/mount.ts";
import { personId as personIdOf } from "@everyfield/contracts/common";
import {
	createFollowUpWriter,
	followUpReader,
	withFollowUpWrite,
	type FollowUpReply,
} from "@everyfield/domain/followups";
import { PeopleReadContext, peopleReader } from "@everyfield/domain/people";
import type { RequestActor, WriteTx } from "@everyfield/domain/access";
import { taskReader, type TaskContext } from "@everyfield/domain/tasks";
import "server-only";
import type { TaskDetail } from "../tasks/model.ts";
import {
	COVERAGE_PAGE,
	HISTORY_PAGE,
	type Account,
	type ContactHistory,
	type DutyItem,
	type ObligationItem,
	type Owners,
	type ObligationPage,
} from "./model.ts";
import { transient } from "../../server/platform/transient.ts";
import { guardedWrite } from "../../server/platform/tx.ts";
import { gatedTransaction } from "@everyfield/domain/operations";

export { COVERAGE_PAGE };

export const administers = (v: Pick<PlantSeat, "role">) => v.role !== "member";

let writer: ReturnType<typeof createFollowUpWriter> | undefined;
type Writer = ReturnType<typeof createFollowUpWriter>;
export async function write<T>(
	viewer: PlantSeat,
	run: (w: Writer, tx: WriteTx, ctx: TaskContext) => Promise<FollowUpReply<T>>,
): Promise<Outcome<T>> {
	const mount = tasksMount();
	writer ??= createFollowUpWriter({ reminders: mount.reminders });
	const w = writer;
	return guardedWrite("followups", async () =>
		outcomeOf(await withFollowUpWrite(mount.db, viewer.authority, (tx, ctx) => run(w, tx, ctx))),
	);
}

export async function readOwners(tx: WriteTx, viewer: PlantSeat): Promise<Outcome<Account[]>> {
	const seats = await taskReader.eligibleAssignees(tx, viewer.authority, { purpose: "committed_follow_up" });
	return seats.status === "ok"
		? {
				status: "ok",
				value: seats.value.items.map(({ accountId, displayName }) => ({ accountId, displayName })),
			}
		: { status: "refused", code: seats.error.code };
}

export const PERSON_PAGE = 20;
const okOrNull = <T>(r: FollowUpReply<T>) => (r.status === "ok" ? r.value : null);

export type PersonFollowUps = {
	history: ContactHistory | null;
	obligations: ObligationPage | null;
	duties: Owners | null;
};
export async function readPersonFollowUps(
	tx: WriteTx,
	authority: RequestActor,
	personId: string,
): Promise<PersonFollowUps> {
	const history = await followUpReader.listContactHistory(tx, authority, { personId, limit: HISTORY_PAGE, page: 1 });
	const obligations = await followUpReader.readObligations(tx, authority, { personId, limit: PERSON_PAGE });
	const duties = await followUpReader.listFollowUpOwners(tx, authority, { personId, limit: PERSON_PAGE });
	return { history: okOrNull(history), obligations: okOrNull(obligations), duties: okOrNull(duties) };
}

export async function loadPersonFollowUps(authority: RequestActor, personId: string): Promise<PersonFollowUps | null> {
	const db = requestDatabase();
	return transient(
		{ component: "followups", outcome: "read_failed" },
		() => gatedTransaction(db, (tx) => readPersonFollowUps(tx, authority, personId)),
		null,
	);
}

export type CallData = {
	task: TaskDetail;
	person: { id: string; label: string; phone: string | null; email: string | null; live: boolean };
	obligation: ObligationItem | null;
	recent: ContactHistory | null;
	others: DutyItem[];
	record: ContactHistory | null;
};
export type CallRead =
	{ kind: "call"; call: CallData } | { kind: "not_follow_up"; taskId: string } | { kind: "missing" };

export async function loadCall(tx: WriteTx, viewer: PlantSeat, taskId: string): Promise<Outcome<CallRead>> {
	const found = await taskReader.get(tx, viewer.authority, { taskId });
	if (found.status !== "ok") return { status: "refused", code: found.error.code };
	if (found.value.status !== "available" || found.value.task.deleted)
		return { status: "ok", value: { kind: "missing" } };
	const task = found.value.task;
	if (task.parentId !== null || task.relation?.kind !== "person")
		return { status: "ok", value: { kind: "not_follow_up", taskId } };
	const personId = personIdOf.parse(task.relation.id);
	const p = await peopleReader.getPerson(tx, new PeopleReadContext(viewer.authority), { personId });
	const person =
		p.status === "ok" && p.value.status === "available"
			? {
					id: personId,
					label: p.value.person.displayName,
					phone: p.value.person.phone ?? null,
					email: p.value.person.email ?? null,
					live: p.value.person.lifecycle.state === "live",
				}
			: { id: personId, label: task.relation.label, phone: null, email: null, live: false };
	const recent = okOrNull(await followUpReader.listContactHistory(tx, viewer.authority, { personId, limit: 3 }));
	const closed = task.status === "complete" || task.status === "no_longer_needed";
	const record = closed
		? okOrNull(await followUpReader.listContactHistory(tx, viewer.authority, { personId, taskId: task.id, limit: 5 }))
		: null;
	const others = closed
		? []
		: (
				okOrNull(await followUpReader.listFollowUpOwners(tx, viewer.authority, { personId, limit: 100 }))?.items ?? []
			).filter(
				(d) =>
					d.taskId !== task.id && (viewer.role !== "member" || d.owners.some((o) => o.accountId === viewer.accountId)),
			);
	const managed = task.managed;
	const obligation = managed
		? (okOrNull(await followUpReader.readObligations(tx, viewer.authority, { personId, limit: 100 }))?.items.find(
				(o) => o.id === managed.obligationId,
			) ?? null)
		: null;
	return { status: "ok", value: { kind: "call", call: { task, person, obligation, recent, others, record } } };
}
