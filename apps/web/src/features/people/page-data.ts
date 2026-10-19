import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { listPeopleRequest, type PeopleContext, type PeopleReply } from "@everyfield/contracts/people";
import type * as people from "@everyfield/contracts/people";
import { peopleReader, getAccountLink } from "@everyfield/domain/people";
import type { z } from "zod";
import { isFiltered, listRequest, type PeopleQuery } from "./model.ts";

export type PeopleData =
	| { kind: "list"; page: z.infer<typeof people.peoplePage>; expired: boolean }
	| { kind: "pipeline"; pipeline: z.infer<typeof people.pipelineResult> }
	| { kind: "failed" };
export type PeopleView = { query: PeopleQuery; data: PeopleData; workspaceEmpty: boolean };

// One caller-owned page transaction, including an expired-cursor retry.
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
	const expired = result.status === "refused" && result.error.code === "invalid_input" && query.trail.length > 0;
	if (expired) {
		query = { ...query, trail: [], page: 1 };
		result = await peopleReader.listPeople(tx, ctx, request(query));
	}
	return {
		query,
		data: result.status === "ok" ? { kind: "list", page: result.value, expired } : { kind: "failed" },
		workspaceEmpty: result.status === "ok" && !isFiltered(query) && result.value.total === 0,
	};
}

type PersonPageData = {
	found: z.infer<typeof people.personResult>;
	activities: Awaited<ReturnType<typeof peopleReader.getActivities>> | null;
	link: Awaited<ReturnType<typeof getAccountLink>> | null;
	survivor: Awaited<ReturnType<typeof peopleReader.getPerson>> | null;
};

export async function readPersonPage(
	tx: Transaction,
	ctx: PeopleContext,
	personId: Parameters<typeof peopleReader.getPerson>[2]["personId"],
): Promise<PeopleReply<PersonPageData>> {
	const found = await peopleReader.getPerson(tx, ctx, { personId });
	if (found.status !== "ok") return found;
	if (found.value.status !== "available")
		return { status: "ok", value: { found: found.value, activities: null, link: null, survivor: null } };
	const person = found.value.person;
	const activities = await peopleReader.getActivities(tx, ctx, { personId, limit: 50 });
	const link = await getAccountLink(tx, ctx, { personId });
	const survivor =
		person.lifecycle.state === "merged"
			? await peopleReader.getPerson(tx, ctx, { personId: person.lifecycle.survivorId })
			: null;
	return { status: "ok", value: { found: found.value, activities, link, survivor } };
}
