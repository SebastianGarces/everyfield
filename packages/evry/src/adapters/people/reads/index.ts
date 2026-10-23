import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import {
	checkForDuplicates as nativeDuplicates,
	PeopleReadContext,
	peopleReader,
	personFields,
} from "@everyfield/domain/people";
import {
	duplicateCheckRequest,
	listPeopleRequest,
	personFieldsRequest,
	personRequest,
	stage,
} from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";

// The People read tools: each calls the native People read that screens use, under the same domain authority, whose
// statements carry the lock-free live access check (C13, C27). Only the safe identifying fields a person sees in the
// list reach the model.
type PlantPerson = { id: string; displayName: string; city?: string | null; stage: string };
const row = (p: PlantPerson) => ({
	kind: "person" as const,
	id: p.id,
	label: p.displayName,
	fields: { city: p.city ?? null, stage: p.stage },
});
const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
const one = (operation: string, rows: SourceRow[], exclusions: string[]): SourceResult => ({
	operation,
	status: rows.length ? "available" : "not_found",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions,
});

const listInput = z.strictObject({
	search: z.string().trim().min(1).max(255).optional().describe("Name, email or phone text to match"),
	stages: z.array(stage).max(7).optional(),
	page: z.int().min(1).max(100_000).optional().describe("Page number of a previous result's next page"),
	limit: z.int().min(1).max(100).optional(),
});
const personInput = z.strictObject({ personId: z.uuid() });

export const listPeople: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "people.listPeople",
	description: "List people in this church, with the exact matched total and the next page when more exist.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const request = listPeopleRequest.parse({ ...input, limit: input.limit ?? 24, page: input.page ?? 1 });
		const reply = await peopleReader.listPeople(tx, new PeopleReadContext(actor.authority), request);
		if (reply.status !== "ok")
			throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "source_unavailable");
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

export const getPerson: ReadAdapter<z.infer<typeof personInput>> = {
	operation: "people.getPerson",
	description: "Read one person in this church by an id from an earlier result.",
	input: personInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const reply = await peopleReader.getPerson(tx, new PeopleReadContext(actor.authority), personRequest.parse(input));
		// A foreign, retired or guessed id reads the same as one that never existed.
		const found = reply.status === "ok" && reply.value.status === "available" ? reply.value.person : null;
		return one("people.getPerson", found && "stage" in found ? [row(found)] : [], ["private care"]);
	},
};

export const getPersonPhoto: ReadAdapter<z.infer<typeof personInput>> = {
	operation: "people.getPersonPhoto",
	description:
		"Say whether one person in this church has a photo, by an id from an earlier result. The app shows the photo itself.",
	input: personInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const reply = await personFields.getPersonPhoto(
			tx,
			new PeopleReadContext(actor.authority),
			personFieldsRequest.parse(input),
		);
		// The photo stays a private object: the result names its version for the app's own route, never bytes, a
		// storage key or a link. A foreign, retired or guessed id reads the same as one that never existed.
		if (reply.status !== "ok") return one("people.getPersonPhoto", [], []);
		const photo = reply.value;
		const fields = { photo: photo.status, versionId: photo.status === "available" ? photo.versionId : null };
		return one(
			"people.getPersonPhoto",
			[{ kind: "person", id: input.personId, label: "Person photo", fields }],
			["photo bytes"],
		);
	},
};

export const checkForDuplicates: ReadAdapter<z.infer<typeof duplicateCheckRequest>> = {
	operation: "people.checkForDuplicates",
	description:
		"Before proposing a new person, find people in this church who share the email or phone (exact hint) or the name (potential hint). A hint never proves two records are the same person.",
	input: duplicateCheckRequest,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const reply = await nativeDuplicates(tx, new PeopleReadContext(actor.authority), input);
		if (reply.status !== "ok")
			throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "source_unavailable");
		const { items, completeness } = reply.value;
		return {
			operation: "people.checkForDuplicates",
			status: "available",
			rows: items.map((h) => ({
				kind: "person",
				id: h.personId,
				label: h.displayName,
				fields: { match: h.match, signals: h.signals.join(",") },
			})),
			// Hints are bounded; past the bound only the first ones are known, never a false exhaustive total.
			total: completeness === "complete" ? items.length : null,
			page: 1,
			next: null,
			completeness,
			exclusions: ["retired people", "contact values"],
		};
	},
};

/** The installed People read tools, in catalog order. */
export const PEOPLE_READS = [listPeople, getPerson, getPersonPhoto, checkForDuplicates] as const;

const verifiedRow = z.object({
	id: z.uuid(),
	display_name: z.string(),
	city: z.string().nullable(),
	stage: z.string(),
});
/**
 * The live people of the actor's church among these ids, in the given order, with the same safe fields a list row has.
 * One statement for any number of ids, with the lock-free live access check (C27) in it, so a reference or a selection
 * never outlives the access that returned it and a sign-out or seat end never waits for it. Foreign, retired and
 * guessed ids drop out.
 */
export async function verifyPeople(
	db: Pick<Database, "execute">,
	actor: EvryActor,
	ids: readonly string[],
): Promise<SourceRow[]> {
	if (!ids.length || !inPlant(actor)) return [];
	const r = await db.execute(sql`
		SELECT p.id,p.display_name,p.city,p.stage FROM person p
		WHERE p.id=ANY(${sql.param([...ids])}::uuid[]) AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid
			AND p.state='live' AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}
		ORDER BY array_position(${sql.param([...ids])}::uuid[], p.id)`);
	return r.rows.map((raw) => {
		const p = verifiedRow.parse(raw);
		return row({ id: p.id, displayName: p.display_name, city: p.city, stage: p.stage });
	});
}
