import { requestDatabase } from "@/server/database";
import { tasksMount } from "@/server/tasks";
import { personId as personIdOf } from "@everyfield/contracts/common";
import type { FollowUpError } from "@everyfield/contracts/followups";
import type { Transaction } from "@everyfield/db/client";
import {
	createFollowUpWriter,
	followUpReader,
	withFollowUpWrite,
	type FollowUpReply,
} from "@everyfield/domain/followups";
import { PeopleReadContext, peopleReader } from "@everyfield/domain/people";
import type { RequestActor } from "@everyfield/domain/access";
import { taskReader, type TaskContext } from "@everyfield/domain/tasks";
import "server-only";
import type { TaskDetail } from "../tasks/model.ts";
import { taskViewer, type TaskViewer } from "../tasks/server.ts";
import {
	COVERAGE_PAGE,
	ownersOf,
	type Account,
	type ContactHistory,
	type ObligationItem,
	type Outcome,
	type Owners,
	type ObligationPage,
} from "./model.ts";

// The follow-up screens reach the WP-023 producer here. Pages, reads and actions share the request's one viewer
// (D59/D60), every read statement rechecks the live seat itself (C13), and every write rechecks authority inside its
// own statement (D70). The writer reuses the tasks mount's database and reminder port, as tasks does.

export { COVERAGE_PAGE, taskViewer, type TaskViewer };

/** One short read transaction. A database failure reads as lost, never as a crash or an empty list. */
export async function read<T>(viewer: TaskViewer, run: (tx: Transaction) => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await db.transaction(run);
	} catch (error) {
		console.error(JSON.stringify({ component: "followups", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}
export const administers = (v: Pick<TaskViewer, "role">) => v.role !== "member";

export const outcomeOf = <T>(reply: FollowUpReply<T>): Outcome<T> =>
	reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };

let writer: ReturnType<typeof createFollowUpWriter> | undefined;
type Writer = ReturnType<typeof createFollowUpWriter>;
/** One follow-up command in one transaction with the request's verified actor. A database failure reads as lost. */
export async function write<T>(
	viewer: TaskViewer,
	run: (w: Writer, tx: Transaction, ctx: TaskContext) => Promise<FollowUpReply<T>>,
): Promise<Outcome<T>> {
	const mount = tasksMount();
	if (!mount) return { status: "lost" };
	writer ??= createFollowUpWriter({ reminders: mount.reminders });
	const w = writer;
	try {
		return outcomeOf(await withFollowUpWrite(mount.db, viewer.authority, (tx, ctx) => run(w, tx, ctx)));
	} catch (error) {
		console.error(JSON.stringify({ component: "followups", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** The current eligible follow-up owners, in one statement (REQ-TSK-012). Owner/Admin. */
export async function readOwners(tx: Transaction, viewer: TaskViewer): Promise<Outcome<Account[]>> {
	const plan = outcomeOf(await followUpReader.planHandoff(tx, viewer.authority, { fromAccountId: viewer.accountId }));
	return plan.status === "ok" ? { status: "ok", value: ownersOf(plan.value) } : plan;
}

/** Contact log entries per page on the Person page; "Show earlier" reads the next one. */
export const HISTORY_PAGE = 20;
/** Open follow-ups and Vision follow-ups per page on the Person page; "Show more" reads the next one. */
export const PERSON_PAGE = 20;
const okOrNull = <T>(r: FollowUpReply<T>) => (r.status === "ok" ? r.value : null);

/** The Person page's follow-up part. Each piece reads as null when refused or failed, so the rest still shows. */
export type PersonFollowUps = {
	history: ContactHistory | null;
	obligations: ObligationPage | null;
	duties: Owners | null;
};
/**
 * A Person's contact log, Vision follow-ups and open follow-ups, read in the person page's own transaction: one
 * statement each, whatever the number of records (REQ-MTG-021, REQ-MTG-022, REQ-TSK-012).
 */
export async function readPersonFollowUps(
	tx: Transaction,
	authority: RequestActor,
	personId: string,
): Promise<PersonFollowUps> {
	const history = await followUpReader.listContactHistory(tx, authority, { personId, limit: HISTORY_PAGE, page: 1 });
	const obligations = await followUpReader.readObligations(tx, authority, { personId, limit: PERSON_PAGE });
	const duties = await followUpReader.listFollowUpOwners(tx, authority, { personId, limit: PERSON_PAGE });
	return { history: okOrNull(history), obligations: okOrNull(obligations), duties: okOrNull(duties) };
}

/** The follow-up call page's data (REQ-MTG-022): the task, its Person's ways to reach them and the 48-hour origin. */
export type CallData = {
	task: TaskDetail;
	person: { id: string; label: string; phone: string | null; email: string | null; live: boolean };
	obligation: ObligationItem | null;
	recent: ContactHistory | null;
};
export type CallRead =
	{ kind: "call"; call: CallData } | { kind: "not_follow_up"; taskId: string } | { kind: "missing" };

/**
 * The call page in one transaction: the task, its Person, their last few log entries and, for a generated follow-up,
 * its obligation. Four statements. A task that is not a follow-up with a Person says so instead.
 */
export async function loadCall(tx: Transaction, viewer: TaskViewer, taskId: string): Promise<Outcome<CallRead>> {
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
	const managed = task.managed;
	const obligation = managed
		? (okOrNull(await followUpReader.readObligations(tx, viewer.authority, { personId, limit: 100 }))?.items.find(
				(o) => o.id === managed.obligationId,
			) ?? null)
		: null;
	return { status: "ok", value: { kind: "call", call: { task, person, obligation, recent } } };
}

export type { FollowUpError };
