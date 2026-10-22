import * as c from "@everyfield/contracts/followups";
import { recordId } from "@everyfield/contracts/common";
import { followUpReader } from "@everyfield/domain/followups";
import { taskReader } from "@everyfield/domain/tasks";
import "server-only";
import type { z } from "zod";
import type { Outcome } from "./model.ts";
import {
	HISTORY_PAGE,
	loadCall,
	outcomeOf,
	read,
	readOwners,
	readPersonFollowUps,
	taskViewer,
	type TaskViewer,
} from "./server.ts";

// GET /follow-ups/read: the follow-up screens' reads after the first paint (more of the contact log, eligible owners,
// a handoff preview, the seats a handoff can start from, and a fresh copy after a revision conflict). A GET handler, not
// a server action, so a read never waits for a save or holds one up. Every read rechecks the live seat inside its
// statement (C13).

const answer = (body: Outcome<unknown>) => Response.json(body, { headers: { "cache-control": "private, no-store" } });
const invalid = { status: "refused", code: "invalid_input" } as const;

function parsed<S extends z.ZodType>(schema: S, raw: unknown, run: (v: z.output<S>) => Promise<Outcome<unknown>>) {
	const input = schema.safeParse(raw);
	return input.success ? run(input.data) : Promise.resolve(invalid);
}
const ok = <T>(value: T): Outcome<T> => ({ status: "ok", value });

export async function GET(request: Request) {
	const viewer: TaskViewer | null = await taskViewer();
	if (!viewer) return answer({ status: "refused", code: "access_denied" });
	const p = new URL(request.url).searchParams;
	switch (p.get("what")) {
		case "history":
			return answer(
				await parsed(
					c.listContactHistoryRequest,
					{ personId: p.get("person"), page: Number(p.get("page")), limit: HISTORY_PAGE },
					(v) =>
						read(viewer, async (tx) => outcomeOf(await followUpReader.listContactHistory(tx, viewer.authority, v))),
				),
			);
		// The Person page's follow-up part again, after a refusal because it was out of date.
		case "person":
			return answer(
				await parsed(c.listContactHistoryRequest.pick({ personId: true }), { personId: p.get("person") }, (v) =>
					read(viewer, async (tx) => ok(await readPersonFollowUps(tx, viewer.authority, v.personId))),
				),
			);
		case "call":
			return answer(await parsed(recordId, p.get("id"), (id) => read(viewer, (tx) => loadCall(tx, viewer, id))));
		case "owners":
			return answer(await read(viewer, (tx) => readOwners(tx, viewer)));
		case "plan":
			return answer(
				await parsed(c.planHandoffRequest, { fromAccountId: p.get("from") }, (v) =>
					read(viewer, async (tx) => outcomeOf(await followUpReader.planHandoff(tx, viewer.authority, v))),
				),
			);
		case "seats":
			return answer(
				await read(viewer, async (tx) => {
					const r = await taskReader.eligibleAssignees(tx, viewer.authority);
					return r.status === "ok" ? r : { status: "refused", code: r.error.code };
				}),
			);
		default:
			return answer(invalid);
	}
}
