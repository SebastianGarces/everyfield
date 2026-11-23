import * as c from "@everyfield/contracts/followups";
import { recordId } from "@everyfield/contracts/common";
import { followUpReader } from "@everyfield/domain/followups";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import { outcomeOf } from "@everyfield/contracts/common";
import { HISTORY_PAGE } from "./model.ts";
import { plantSeat } from "@/server/request-context";
import { readTx } from "../../server/platform/tx.ts";
import { COVERAGE_PAGE, PERSON_PAGE, loadCall, readOwners, readPersonFollowUps } from "./server.ts";

const MEETING_PAGE = 100;
const unpaged = { limit: true } as const;

export const GET = defineReads(plantSeat, "access_denied", (get) => ({
	history: get(c.listContactHistoryRequest.omit(unpaged), (viewer, v) =>
		readTx("followups", async (tx) =>
			outcomeOf(await followUpReader.listContactHistory(tx, viewer.authority, { ...v, limit: HISTORY_PAGE })),
		),
	),
	person: get(c.listContactHistoryRequest.pick({ personId: true }), (viewer, v) =>
		readTx("followups", async (tx) => ({
			status: "ok" as const,
			value: await readPersonFollowUps(tx, viewer.authority, v.personId),
		})),
	),
	duties: get(
		c.listFollowUpOwnersRequest.pick({ personId: true, page: true }).required({ personId: true }),
		(viewer, v) =>
			readTx("followups", async (tx) =>
				outcomeOf(await followUpReader.listFollowUpOwners(tx, viewer.authority, { ...v, limit: PERSON_PAGE })),
			),
	),
	obligations: get(c.readObligationsRequest.pick({ personId: true, meetingId: true, page: true }), (viewer, v) =>
		readTx("followups", async (tx) =>
			outcomeOf(
				await followUpReader.readObligations(tx, viewer.authority, {
					...v,
					limit: v.meetingId ? MEETING_PAGE : PERSON_PAGE,
				}),
			),
		),
	),
	coverage: get(c.followUpCoverageRequest.pick({ coverage: true, page: true }), (viewer, v) =>
		readTx("followups", async (tx) =>
			outcomeOf(await followUpReader.followUpCoverage(tx, viewer.authority, { ...v, limit: COVERAGE_PAGE })),
		),
	),
	call: get(recordId, (viewer, id) => readTx("followups", (tx) => loadCall(tx, viewer, id))),
	owners: get(z.undefined(), (viewer) => readTx("followups", (tx) => readOwners(tx, viewer))),
	plan: get(c.planHandoffRequest, (viewer, v) =>
		readTx("followups", async (tx) => outcomeOf(await followUpReader.planHandoff(tx, viewer.authority, v))),
	),
}));
