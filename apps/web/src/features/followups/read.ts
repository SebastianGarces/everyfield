import * as c from "@everyfield/contracts/followups";
import { recordId } from "@everyfield/contracts/common";
import { followUpReader } from "@everyfield/domain/followups";
import "server-only";
import type { z } from "zod";
import { HISTORY_PAGE, outcomeOf, type Outcome } from "./model.ts";
import {
	COVERAGE_PAGE,
	PERSON_PAGE,
	loadCall,
	read,
	readOwners,
	readPersonFollowUps,
	taskViewer,
	type TaskViewer,
} from "./server.ts";

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
					{
						personId: p.get("person"),
						...(p.get("task") ? { taskId: p.get("task") } : {}),
						page: Number(p.get("page")),
						limit: HISTORY_PAGE,
					},
					(v) => read(async (tx) => outcomeOf(await followUpReader.listContactHistory(tx, viewer.authority, v))),
				),
			);
		case "person":
			return answer(
				await parsed(c.listContactHistoryRequest.pick({ personId: true }), { personId: p.get("person") }, (v) =>
					read(async (tx) => ok(await readPersonFollowUps(tx, viewer.authority, v.personId))),
				),
			);
		case "duties":
			return answer(
				await parsed(
					c.listFollowUpOwnersRequest,
					{ personId: p.get("person"), page: Number(p.get("page")), limit: PERSON_PAGE },
					(v) => read(async (tx) => outcomeOf(await followUpReader.listFollowUpOwners(tx, viewer.authority, v))),
				),
			);
		case "obligations":
			return answer(
				await parsed(
					c.readObligationsRequest,
					{
						...(p.get("person") ? { personId: p.get("person") } : {}),
						...(p.get("meeting") ? { meetingId: p.get("meeting") } : {}),
						page: Number(p.get("page")),
						limit: p.get("meeting") ? 100 : PERSON_PAGE,
					},
					(v) => read(async (tx) => outcomeOf(await followUpReader.readObligations(tx, viewer.authority, v))),
				),
			);
		case "coverage":
			return answer(
				await parsed(
					c.followUpCoverageRequest,
					{ coverage: p.get("show") ?? "any", page: Number(p.get("page") ?? "1"), limit: COVERAGE_PAGE },
					(v) => read(async (tx) => outcomeOf(await followUpReader.followUpCoverage(tx, viewer.authority, v))),
				),
			);
		case "call":
			return answer(await parsed(recordId, p.get("id"), (id) => read((tx) => loadCall(tx, viewer, id))));
		case "owners":
			return answer(await read((tx) => readOwners(tx, viewer)));
		case "plan":
			return answer(
				await parsed(c.planHandoffRequest, { fromAccountId: p.get("from") }, (v) =>
					read(async (tx) => outcomeOf(await followUpReader.planHandoff(tx, viewer.authority, v))),
				),
			);
		default:
			return answer(invalid);
	}
}
