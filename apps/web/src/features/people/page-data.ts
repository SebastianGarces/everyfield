import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { listPeopleRequest, type PeopleContext } from "@everyfield/contracts/people";
import type * as people from "@everyfield/contracts/people";
import { peopleReader, readPersonPage as readPersonPageData } from "@everyfield/domain/people";
import type { z } from "zod";
import { isFiltered, listRequest, pageCount, type PeopleQuery } from "./model.ts";

export type PeopleData =
	| { kind: "list"; page: z.infer<typeof people.peoplePage> }
	| { kind: "pipeline"; pipeline: z.infer<typeof people.pipelineResult> }
	| { kind: "failed" };
export type PeopleView = { query: PeopleQuery; data: PeopleData; workspaceEmpty: boolean };

// One caller-owned page transaction. A page number past the end reads the last page instead (D67).
export async function readPeoplePage(tx: Transaction, ctx: PeopleContext, query: PeopleQuery): Promise<PeopleView> {
	const request = (q: PeopleQuery) => listPeopleRequest.parse(listRequest(q));
	if (query.view === "pipeline") {
		const result = await peopleReader.getPipelineData(tx, ctx, request(query));
		return {
			query,
			data: result.status === "ok" ? { kind: "pipeline", pipeline: result.value } : { kind: "failed" },
			workspaceEmpty: result.status === "ok" && !isFiltered(query) && result.value.groups.every((g) => g.total === 0),
		};
	}
	let result = await peopleReader.listPeople(tx, ctx, request(query));
	const last = result.status === "ok" ? pageCount(result.value.total ?? 0) : 1;
	if (query.page > last) {
		query = { ...query, page: last };
		result = await peopleReader.listPeople(tx, ctx, request(query));
	}
	return {
		query,
		data: result.status === "ok" ? { kind: "list", page: result.value } : { kind: "failed" },
		workspaceEmpty: result.status === "ok" && !isFiltered(query) && result.value.total === 0,
	};
}

export async function readPersonPage(
	tx: Transaction,
	ctx: PeopleContext,
	personId: Parameters<typeof peopleReader.getPerson>[2]["personId"],
) {
	return readPersonPageData(tx, ctx, { personId }, 50);
}
