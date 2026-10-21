import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { PeopleReadContext, peopleReader } from "@everyfield/domain/people";
import { listPeopleRequest, personRequest, stage } from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority } from "../context/authority.ts";
import { EvryRefusal } from "../context/errors.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "./types.ts";

// The built-in first adapter: the two People reads native screens use, under the same domain authority (WP-059 adds
// the rest of the People tools). Only the safe identifying fields a person sees in the list reach the model.
type PlantPerson = { id: string; displayName: string; city?: string | null; stage: string };
const row = (p: PlantPerson) => ({
	kind: "person" as const,
	id: p.id,
	label: p.displayName,
	fields: { city: p.city ?? null, stage: p.stage },
});
const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;

const listInput = z.strictObject({
	search: z.string().trim().min(1).max(255).optional().describe("Name, email or phone text to match"),
	stages: z.array(stage).max(7).optional(),
	page: z.int().min(1).max(100_000).optional().describe("Page number of a previous result's next page"),
	limit: z.int().min(1).max(100).optional(),
});
const getInput = z.strictObject({ personId: z.uuid() });

function refused(code: string): never {
	throw new EvryRefusal(code === "invalid_input" ? "invalid_input" : "source_unavailable");
}

export const listPeople: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "people.listPeople",
	description: "List people in this church, with the exact matched total and the next page when more exist.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const request = listPeopleRequest.parse({ ...input, limit: input.limit ?? 24, page: input.page ?? 1 });
		const reply = await peopleReader.listPeople(tx, new PeopleReadContext(actor.authority), request);
		if (reply.status !== "ok") refused(reply.error.code);
		const page = reply.value;
		return {
			operation: "people.listPeople",
			status: "available",
			rows: page.items.map(row),
			total: page.total,
			page: request.page,
			next: page.next,
			completeness: page.completeness,
			exclusions: ["archived people", "private care"],
		};
	},
};

export const getPerson: ReadAdapter<z.infer<typeof getInput>> = {
	operation: "people.getPerson",
	description: "Read one person in this church by an id from an earlier result.",
	input: getInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const reply = await peopleReader.getPerson(tx, new PeopleReadContext(actor.authority), personRequest.parse(input));
		// A foreign, retired or guessed id reads the same as one that never existed.
		if (reply.status !== "ok" || reply.value.status !== "available" || !("stage" in reply.value.person))
			return {
				operation: "people.getPerson",
				status: "not_found",
				rows: [],
				total: 0,
				page: 1,
				next: null,
				completeness: "complete",
				exclusions: [],
			};
		return {
			operation: "people.getPerson",
			status: "available",
			rows: [row(reply.value.person)],
			total: 1,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["private care"],
		};
	},
};

const verifiedRow = z.object({
	id: z.uuid(),
	display_name: z.string(),
	city: z.string().nullable(),
	stage: z.string(),
});
/**
 * The live people of the actor's church among these ids, in the given order, with the same safe fields a list row has.
 * One statement for any number of ids: current session, seat and lifecycle authority are checked in the same read, so
 * a reference or a selection never outlives the access that returned it. Foreign, retired and guessed ids drop out.
 */
export async function verifyPeople(db: Database, actor: EvryActor, ids: readonly string[]): Promise<SourceRow[]> {
	if (!ids.length || !inPlant(actor)) return [];
	const r = await db.execute(sql`
		SELECT p.id,p.display_name,p.city,p.stage FROM person p
		WHERE p.id=ANY(${sql.param([...ids])}::uuid[]) AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid
			AND p.state='live' AND ${currentAuthority(actor)}
		ORDER BY array_position(${sql.param([...ids])}::uuid[], p.id)`);
	return r.rows.map((raw) => {
		const p = verifiedRow.parse(raw);
		return row({ id: p.id, displayName: p.display_name, city: p.city, stage: p.stage });
	});
}
