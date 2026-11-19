import { getViewer } from "@/server/request-context";
import { personId } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import {
	assessments,
	commitments,
	interviews,
	peopleMerge,
	peopleReader,
	personFields,
} from "@everyfield/domain/people";
import "server-only";
import { z } from "zod";
import type { Outcome } from "../../components/save/model.ts";
import { defineReads } from "../../server/platform/reads.ts";
import { HISTORY_PAGE } from "./assessments/server.ts";
import { invalid, outcome } from "./boundary.ts";
import { readPersonPageNow, type PersonPage } from "./corrections/page.ts";
import { readPair, readRecords, readUnmerge } from "./corrections/server.ts";
import { parseQuery } from "./model.ts";
import { loadPeople, loadPerson, read } from "./server.ts";

const HOUSEHOLDS_FOUND = 20;
const WITNESSES_FOUND = 8;
const ACTIVITY_PAGE = 50;
const QUERY_MAX = 16_384;

const records = c.personRecordsRequest.pick({ personId: true, page: true });
const column = z.strictObject({ query: z.record(z.string(), z.unknown()), column: c.pipelineColumn, page: z.int() });
const pair = z.strictObject({ person: personId, with: personId, keep: personId.nullable() });

export const GET = defineReads(
	async () => (await getViewer())?.people ?? null,
	"access_denied",
	(get) => ({
		view: get(z.strictObject({ search: z.string().max(QUERY_MAX) }), (viewer, v) =>
			loadPeople(viewer, parseQuery(new URLSearchParams(v.search))),
		),
		person: get(c.personRequest, async (viewer, v) => {
			const r = outcome(await loadPerson(viewer, v.personId, false), (page) => page);
			if (r.status !== "ok") return r;
			const { found, activities } = r.value;
			if (found.status !== "available" || !("stage" in found.person))
				return { status: "refused", code: "unavailable" } as const;
			return {
				status: "ok",
				value: { person: found.person, activities: activities?.status === "ok" ? activities.value : null },
			} as const;
		}),
		warnings: get(c.personRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => peopleReader.getStatusWarnings(tx, ctx, v)), (r) => r),
		),
		activities: get(c.activityRequest.pick({ personId: true, page: true }), async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) => peopleReader.getActivities(tx, ctx, { ...v, limit: ACTIVITY_PAGE })),
				(r) => r,
			),
		),
		column: get(column, async (viewer, v) => {
			const request = c.listPeopleRequest.safeParse({ ...v.query, view: "pipeline", page: v.page, column: v.column });
			if (!request.success) return invalid;
			return outcome(await read(viewer, (tx, ctx) => peopleReader.getPipelineData(tx, ctx, request.data)), (r) =>
				r.groups.find((g) => g.column === v.column)!,
			);
		}),
		assessments: get(records, async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) => assessments.getAssessments(tx, ctx, { ...v, limit: HISTORY_PAGE })),
				(r) => r,
			),
		),
		interviews: get(records, async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) => interviews.getInterviews(tx, ctx, { ...v, limit: HISTORY_PAGE })),
				(r) => r,
			),
		),
		commitments: get(records, async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) => commitments.getCommitments(tx, ctx, { ...v, limit: HISTORY_PAGE })),
				(r) => r,
			),
		),
		tags: get(c.listTagsRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => personFields.listTags(tx, ctx, v)), (r) => r.items),
		),
		skills: get(c.personFieldsRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => personFields.getPersonSkills(tx, ctx, v)), (r) => r.skills),
		),
		household: get(c.personFieldsRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => personFields.getHousehold(tx, ctx, v)), (r) => r),
		),
		photo: get(c.personFieldsRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => personFields.getPersonPhoto(tx, ctx, v)), (r) => r),
		),
		households: get(c.listHouseholdsRequest.pick({ search: true }), async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) =>
					personFields.listHouseholds(tx, ctx, { ...v, page: 1, limit: HOUSEHOLDS_FOUND }),
				),
				(r) => r,
			),
		),
		witnesses: get(c.listPeopleRequest.pick({ search: true }), async (viewer, v) =>
			outcome(
				await read(viewer, (tx, ctx) =>
					peopleReader.listPeople(tx, ctx, c.listPeopleRequest.parse({ search: v.search, limit: WITNESSES_FOUND })),
				),
				(r) => r.items.map((p) => ({ id: p.id, name: p.displayName, detail: p.email ?? p.phone ?? "" })),
			),
		),
		page: get(c.personRequest, async (viewer, v): Promise<Outcome<PersonPage>> => {
			const page = await readPersonPageNow(viewer, v.personId).catch(() => null);
			return page ? { status: "ok", value: page } : { status: "lost" };
		}),
		records: get(c.personRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => readRecords(tx, ctx, v.personId)), (r) => r),
		),
		pair: get(pair, async (viewer, v) => {
			const r = await read(viewer, async (tx, ctx) => ({ status: "ok", value: await readPair(tx, ctx, v) }) as const);
			return r.status === "ok" ? ({ status: "ok", value: r.value } as const) : ({ status: "lost" } as const);
		}),
		destination: get(c.mergedPersonDestinationRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => peopleMerge.mergedPersonDestination(tx, ctx, v)), (r) => r),
		),
		unmerge: get(c.unmergePreviewRequest, async (viewer, v) =>
			outcome(await read(viewer, (tx, ctx) => readUnmerge(tx, ctx, v.mergeId)), (r) => r),
		),
	}),
);
