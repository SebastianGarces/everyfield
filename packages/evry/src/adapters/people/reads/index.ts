import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead, type WriteTx } from "@everyfield/domain/access";
import {
	checkForDuplicates as nativeDuplicates,
	listDuplicatePairs as nativePairs,
	PeopleReadContext,
	peopleReader,
	personFields,
} from "@everyfield/domain/people";
import {
	adultClassification,
	duplicateCheckRequest,
	listPeopleRequest,
	movedInto,
	moveWarningLines,
	moveWarnings,
	personFieldsRequest,
	personRequest,
	skillCategory,
	skillName,
	stage,
	type peoplePage,
} from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { personRow } from "../../../catalog/person-row.ts";
import { ownerOrAdmin } from "../commands/index.ts";
import { id } from "../../tasks/values.ts";
import { stageWarnings } from "../stage-warnings.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";

type PlantPerson = { id: string; displayName: string; city?: string | null; stage: string };
const row = (actor: EvryActor, p: PlantPerson) =>
	personRow(actor, p.id, p.displayName, { city: p.city ?? null, stage: p.stage });
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
	search: z.string().trim().min(1).max(255).optional().describe("Name, email or phone text to match, never a place"),
	city: z.string().trim().min(1).max(255).optional().describe("The recorded city, matched whole, ignoring case"),
	stages: z
		.array(stage)
		.max(7)
		.optional()
		.describe(
			"The seven stages, in order: prospect, attendee, following_up, interviewed, core_group, launch_team, leader. There is no inactive stage: asked for one, name these seven and offer people.deletePerson with a reason.",
		),
	skillCategories: z
		.array(skillCategory)
		.min(1)
		.max(7)
		.optional()
		.describe("Recorded skill categories. A person matches on any category or skillNames text; notes never count."),
	skillNames: z.array(skillName).min(1).max(10).optional().describe("Text in a recorded skill's name"),
	hasPhoto: z
		.boolean()
		.optional()
		.describe("Whether the People list shows a photo for them, their account's photo included"),
	inHousehold: z.boolean().optional().describe("Whether they are in any household"),
	adultClassification: adultClassification
		.optional()
		.describe(
			"What is recorded, or what the birth date decides. A child row names its household. A household role, surname or note never counts; unknown means nothing is recorded.",
		),
	movedInto: movedInto
		.optional()
		.describe(
			"People with a recorded move into this stage between two church-local dates, each person once with the date of their last such move. Leave the dates out for this calendar month. Being added or imported in the stage, or moving on from it, isn't a move into it.",
		),
	page: z.int().min(1).max(100_000).optional().describe("Page number of a previous result's next page"),
	limit: z
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("At most 24 a page under a skill, photo, household, child or move filter"),
});
type Match = NonNullable<z.infer<typeof peoplePage>["matches"]>[number];
const matchFields = (m: Match) => ({
	...(m.skills && {
		skills: m.skills.map((s) => `${s.name} (${s.category}), ${s.proficiency ?? "level not recorded"}`).join("; "),
	}),
	...(m.household && { household: m.household.name, householdId: m.household.id }),
	...(m.movedOn && { movedOn: m.movedOn }),
});
const PAGE = 24;
const CHURCH_WIDE =
	"These filters cover everyone in the church: say so in the answer, with peopleInChurch, how many people that is. When next is not null, name every one of this page's people, say they are onThisPage of the total and offer the next page under the same filter. Any number you give for this page is onThisPage: never count the names yourself.";
const CHILD_NOTE =
	"Say that people with no adult or child recorded aren't counted. A household no page names has no child recorded.";
const MOVE_NOTE =
	"Moves say who moved in and when, never who is stuck or inactive: for that, read people.getPipelineData instead and give each person's inactivity.";
const personInput = z.strictObject({ personId: z.uuid() });

export const listPeople: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "people.listPeople",
	description:
		"List people in this church, or only those matching a city, stage, skill, photo, household, adult or child, or stage move, with the exact matched total and the next page when more exist. A stage says where someone is, never whether they are ready for the next one: list the stage and say that readiness is the user's call.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx: WriteTx, actor: EvryActor, input): Promise<SourceResult> {
		const churchWide =
			input.skillCategories !== undefined ||
			input.skillNames !== undefined ||
			input.hasPhoto !== undefined ||
			input.inHousehold !== undefined ||
			input.adultClassification !== undefined ||
			input.movedInto !== undefined;
		const limit = Math.min(input.limit ?? PAGE, churchWide ? PAGE : 100);
		const named = (input.skillNames ?? []).flatMap((n) => skillCategory.safeParse(n.toLowerCase()).data ?? []);
		const skillCategories = [...new Set([...(input.skillCategories ?? []), ...named])];
		const request = listPeopleRequest.parse({
			...input,
			...(skillCategories.length > 0 && { skillCategories }),
			limit,
			page: input.page ?? 1,
		});
		const reply = await peopleReader.listPeople(tx, new PeopleReadContext(actor.authority), request);
		if (reply.status !== "ok")
			throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "source_unavailable");
		const page = reply.value;
		const everyone = churchWide
			? await peopleReader.listPeople(
					tx,
					new PeopleReadContext(actor.authority),
					listPeopleRequest.parse({ page: 1, limit: 1 }),
				)
			: null;
		if (everyone && everyone.status !== "ok") throw new EvryRefusal("source_unavailable");
		const matches = new Map((page.matches ?? []).map((m) => [m.personId, matchFields(m)]));
		return {
			operation: "people.listPeople",
			status: "available",
			rows: page.items.map((p) => {
				const found = row(actor, p);
				return { ...found, fields: { ...found.fields, ...matches.get(p.id) } };
			}),
			total: page.total,
			page: request.page,
			next: page.next,
			completeness: page.completeness,
			exclusions: [
				"archived people",
				"private care",
				...(input.skillCategories || input.skillNames ? ["skill notes"] : []),
				...(input.adultClassification === "child" ? ["people with no adult or child recorded"] : []),
			],
			...(everyone && {
				facts: {
					peopleInChurch: everyone.value.total,
					onThisPage: page.items.length,
					...(page.next !== null && page.total !== null && { pages: Math.ceil(page.total / limit) }),
					note: [
						CHURCH_WIDE,
						...(input.adultClassification === "child" ? [CHILD_NOTE] : []),
						...(input.movedInto ? [MOVE_NOTE] : []),
					].join(" "),
				},
			}),
		};
	},
};

const CONTACT_NOTE =
	"Give this person's email and phone only when the user asks for contact details, such as an email, a phone number or how to reach them, and then give both as recorded. Leave them out of any other answer about this person.";

export const getPerson: ReadAdapter<z.infer<typeof personInput>> = {
	operation: "people.getPerson",
	description: "Read one person in this church by an id from an earlier result.",
	input: personInput,
	allowed: inPlant,
	async invoke(tx: WriteTx, actor: EvryActor, input): Promise<SourceResult> {
		const reply = await peopleReader.getPerson(tx, new PeopleReadContext(actor.authority), personRequest.parse(input));
		const found = reply.status === "ok" && reply.value.status === "available" ? reply.value.person : null;
		if (!found || !("stage" in found)) return one("people.getPerson", [], ["private care"]);
		const fields = {
			city: found.city ?? null,
			stage: found.stage,
			email: found.email ?? null,
			phone: found.phone ?? null,
		};
		const read = one("people.getPerson", [personRow(actor, found.id, found.displayName, fields)], ["private care"]);
		return fields.email || fields.phone ? { ...read, facts: { note: CONTACT_NOTE } } : read;
	},
};

export const getPersonPhoto: ReadAdapter<z.infer<typeof personInput>> = {
	operation: "people.getPersonPhoto",
	description:
		"Say whether one person in this church has a photo, by an id from an earlier result. The app shows the photo itself.",
	input: personInput,
	allowed: inPlant,
	async invoke(tx: WriteTx, actor: EvryActor, input): Promise<SourceResult> {
		const reply = await personFields.getPersonPhoto(
			tx,
			new PeopleReadContext(actor.authority),
			personFieldsRequest.parse(input),
		);
		if (reply.status !== "ok") return one("people.getPersonPhoto", [], []);
		const fields = { photo: reply.value.status };
		return one("people.getPersonPhoto", [personRow(actor, input.personId, "Person photo", fields)], ["photo bytes"]);
	},
};

export const checkForDuplicates: ReadAdapter<z.infer<typeof duplicateCheckRequest>> = {
	operation: "people.checkForDuplicates",
	description:
		"Find people in this church who share an email or phone (exact hint) or a name (potential hint): before proposing a new person, or to compare people who may be the same person. A hint never proves two records are the same person.",
	input: duplicateCheckRequest,
	allowed: inPlant,
	async invoke(tx: WriteTx, actor: EvryActor, input): Promise<SourceResult> {
		const reply = await nativeDuplicates(tx, new PeopleReadContext(actor.authority), input);
		if (reply.status !== "ok")
			throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "source_unavailable");
		const { items, completeness } = reply.value;
		return {
			operation: "people.checkForDuplicates",
			status: "available",
			rows: items.map((h) =>
				personRow(actor, h.personId, h.displayName, { match: h.match, signals: h.signals.join(",") }),
			),
			total: completeness === "complete" ? items.length : null,
			page: 1,
			next: null,
			completeness,
			exclusions: ["retired people", "contact values"],
		};
	},
};

export const listDuplicatePairs: ReadAdapter<Record<string, never>> = {
	operation: "people.listDuplicatePairs",
	description:
		'List the people waiting for duplicate review: the possible duplicates a CSV import flagged ("Add, review later"), each an imported person and the existing person it may duplicate. Use it when asked who needs review or about possible duplicates. Only import-flagged pairs nobody marked "Not a duplicate", not a scan of all People, so an empty list never means the church has no duplicates. A pair is never proof that two records are the same person.',
	input: z.strictObject({}),
	allowed: ownerOrAdmin,
	async invoke(tx: WriteTx, actor: EvryActor): Promise<SourceResult> {
		const reply = await nativePairs(tx, new PeopleReadContext(actor.authority));
		if (reply.status !== "ok") throw new EvryRefusal("source_unavailable");
		const { items, completeness } = reply.value;
		return {
			operation: "people.listDuplicatePairs",
			status: "available",
			rows: items.map((pair) =>
				personRow(actor, pair.person.id, pair.person.displayName, {
					mayDuplicateId: pair.with.id,
					mayDuplicate: pair.with.displayName,
				}),
			),
			total: completeness === "complete" ? items.length : null,
			page: 1,
			next: null,
			completeness,
			exclusions: ["pairs marked not a duplicate", "retired or merged people", "pairs no import flagged"],
		};
	},
};

const warningsInput = z.strictObject({ personId: id, stage: stage.optional() });
export const getStatusWarnings: ReadAdapter<z.infer<typeof warningsInput>> = {
	operation: "people.getStatusWarnings",
	description:
		"The reminders the stage dialog shows before one person moves, as it shows them to every seat: each stage the move skips (give stage, the stage they would move to), and an assessment, interview or commitment that isn't recorded, with how many open duties they hold. Reminders never block a move and never say whether someone is ready",
	input: warningsInput,
	allowed: inPlant,
	async invoke(tx: WriteTx, actor: EvryActor, input): Promise<SourceResult> {
		const found = await stageWarnings(tx, actor, input.personId);
		if (!found) return one("people.getStatusWarnings", [], []);
		const { person, warnings } = found;
		const lines = moveWarningLines(moveWarnings(person.stage, input.stage ?? null, warnings));
		const fields = {
			stage: person.stage,
			movingTo: input.stage ?? null,
			openDuties: warnings.openDuties.length,
			reminders: lines.join("\n") || "None",
		};
		return one("people.getStatusWarnings", [personRow(actor, person.id, person.displayName, fields)], ["private care"]);
	},
};

export const PEOPLE_READS = [
	listPeople,
	getPerson,
	getPersonPhoto,
	checkForDuplicates,
	listDuplicatePairs,
	getStatusWarnings,
] as const;

const verifiedRow = z.strictObject({
	id: z.uuid(),
	display_name: z.string(),
	city: z.string().nullable(),
	stage: z.string(),
});
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
		return row(actor, { id: p.id, displayName: p.display_name, city: p.city, stage: p.stage });
	});
}
