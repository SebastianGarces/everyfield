import { PeopleReadContext, peopleCsv, peopleReader, personFields } from "@everyfield/domain/people";
import {
	activityRequest,
	exportPeopleRequest,
	householdRequest,
	importLimits,
	importReceiptRequest,
	listHouseholdsRequest,
	listPeopleRequest,
	listTagsRequest,
	personFieldsRequest,
	pipelineColumn,
	stage,
	type activity,
	type activitiesResult,
	type householdResult,
	type importPreview,
	type importReceipt,
	type peopleExport,
	type personSkillsResult,
	type personTagsResult,
	type pipelineResult,
	type tagsResult,
	type householdsPage,
} from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";

// Household, tag, skill, activity, pipeline and CSV reads. Each calls the native read the screen uses. The model
// receives the same safe facts a directory row shows. Contact values, note bodies, care notes and file bytes stay out.
type Activity = z.infer<typeof activity>;
type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };

const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");
const readCtx = (actor: EvryActor) => new PeopleReadContext(actor.authority);
const row = (kind: SourceRow["kind"], id: string, label: string, fields: Record<string, string | null>): SourceRow => ({
	kind,
	id,
	label,
	fields,
});
const result = (
	operation: string,
	status: SourceResult["status"],
	rows: SourceRow[],
	total: number | null,
	page: number,
	next: number | null,
	completeness: SourceResult["completeness"],
	exclusions: string[],
): SourceResult => ({ operation, status, rows, total, page, next, completeness, exclusions });
const missing = (operation: string, exclusions: string[] = []): SourceResult =>
	result(operation, "not_found", [], 0, 1, null, "complete", exclusions);
const FIXABLE = new Set([
	"invalid_input",
	"file_too_large",
	"row_limit_exceeded",
	"unsupported_file_content",
	"malformed_csv_quoting",
	"csv_header_invalid",
]);
/** A missing or foreign record is not_found. A file the model can fix, or a down source, is a refusal. */
function valueOf<T>(reply: Reply<T>): T | null {
	if (reply.status === "ok") return reply.value;
	if (reply.error.code === "source_unavailable") throw new EvryRefusal("source_unavailable");
	if (FIXABLE.has(reply.error.code)) throw new EvryRefusal("invalid_input");
	return null;
}

const pageInput = {
	page: z.int().min(1).max(100_000).optional().describe("Page number of a previous result's next page"),
	limit: z.int().min(1).max(100).optional(),
};
const personInput = z.strictObject({ personId: z.uuid() });
const searchInput = z.strictObject({
	search: z.string().trim().max(255).optional().describe("Name, email or phone text to match"),
	...pageInput,
});
const ADDRESS = ["street", "postal code", "state", "country", "email", "phone"];
const CONTACT = ["contact values", "notes"];
const ACTIVITY = ["note bodies", "internal reasons", "private care", "account ids", "assessment record ids"];

function membership(value: { name: string; role: string } | null | undefined): string | null {
	return value ? `${value.name} (${value.role})` : null;
}
/** Activity the model may see. Note text, care follow-ups, account ids and record ids never leave this function. */
function activityRows(personId: string, items: Activity[]): SourceRow[] {
	const rows: SourceRow[] = [];
	for (const item of items) {
		if (item.kind === "follow_up") continue;
		const fields: Record<string, string | null> = { personId, occurredAt: item.occurredAt };
		let label: string = item.kind;
		if (item.kind === "note" || item.kind === "note_removed") {
			fields.kind = item.kind;
			fields.revision = item.revision;
			label = item.kind === "note" ? "Note" : "Note removed";
		} else if (item.kind === "stage_changed") {
			fields.kind = "stage_changed";
			fields.from = item.from;
			fields.to = item.to;
			label = "Stage";
		} else {
			fields.kind = "activity";
			fields.action = item.action;
			fields.from = item.stage?.from ?? null;
			fields.to = item.stage?.to ?? null;
			fields.householdFrom = membership(item.household?.from);
			fields.householdTo = membership(item.household?.to);
			label = item.action;
		}
		rows.push(row("activity", item.id, label, fields));
	}
	return rows;
}
function householdRows(value: z.infer<typeof householdResult>): SourceRow[] {
	if (value.status !== "available") return [];
	const home = value.household;
	const household = row("household", home.id, home.name, {
		name: home.name,
		city: home.city ?? null,
		memberCount: String(home.memberCount),
		revision: home.revision,
	});
	const members = value.members.map((member) =>
		row("person", member.personId, member.displayName, {
			role: member.role,
			city: member.city ?? null,
			householdId: home.id,
		}),
	);
	return [household, ...members];
}
function pipelineRows(value: z.infer<typeof pipelineResult>): SourceRow[] {
	return value.groups.flatMap((group) =>
		group.cards.map((card) =>
			row("person", card.person.id, card.person.displayName, {
				city: card.person.city ?? null,
				stage: card.person.stage,
				column: group.column,
				inactivity: card.inactivity.level,
				coverage: card.coverage,
			}),
		),
	);
}
function previewRows(value: z.infer<typeof importPreview>): SourceRow[] {
	const seen = new Set<string>();
	const people: SourceRow[] = [];
	const imports = value.rows.map((item) => {
		if (item.status === "invalid")
			return row("import", String(item.row), `Row ${item.row}`, {
				status: "invalid",
				suggested: null,
				duplicatePersonIds: null,
				withinFileDuplicateOf: null,
				problems: item.problems.map((problem) => problem.code).join(","),
			});
		for (const hint of item.existingDuplicates) {
			if (seen.has(hint.personId)) continue;
			seen.add(hint.personId);
			people.push(row("person", hint.personId, hint.displayName, { match: "exact" }));
		}
		return row("import", String(item.row), item.values.displayName, {
			status: "valid",
			suggested: item.suggested,
			duplicatePersonIds: item.existingDuplicates.map((hint) => hint.personId).join(",") || null,
			withinFileDuplicateOf: item.withinFileDuplicateOf === null ? null : String(item.withinFileDuplicateOf),
			problems: null,
		});
	});
	return [
		row("file", value.fileDigest, "Import preview", {
			fileDigest: value.fileDigest,
			reviewDigest: value.reviewDigest,
			rows: String(value.counts.rows),
			valid: String(value.counts.valid),
			invalid: String(value.counts.invalid),
			existingDuplicates: String(value.counts.existingDuplicates),
			withinFileDuplicates: String(value.counts.withinFileDuplicates),
		}),
		...imports,
		...people,
	];
}
function receiptRows(value: z.infer<typeof importReceipt>): SourceRow[] {
	const rows = [
		row("file", value.importId, value.status, {
			created: String(value.counts.created),
			skipped: String(value.counts.skipped),
			failed: String(value.counts.failed),
			remaining: String(value.counts.remaining),
		}),
	];
	for (const item of value.rows) {
		const personId = item.status === "created" ? item.personId : null;
		rows.push(
			row("import", String(item.row), item.status, {
				status: item.status,
				personId,
				reason: item.status === "failed" ? item.reason : null,
			}),
		);
		if (personId) rows.push(row("person", personId, "Imported person", { row: String(item.row) }));
	}
	return rows;
}

const listHouseholdsInput = searchInput;
export const listHouseholds: ReadAdapter<z.infer<typeof listHouseholdsInput>> = {
	operation: "people.listHouseholds",
	description: "List households in this church, with the exact matched total and the next page when more exist.",
	input: listHouseholdsInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const request = listHouseholdsRequest.parse({ ...input, limit: input.limit ?? 24, page: input.page ?? 1 });
		const found = valueOf<z.infer<typeof householdsPage>>(
			await personFields.listHouseholds(tx, readCtx(actor), request),
		);
		if (!found) return missing("people.listHouseholds", ADDRESS);
		return result(
			"people.listHouseholds",
			"available",
			found.items.map((home) =>
				row("household", home.id, home.name, {
					name: home.name,
					city: home.city ?? null,
					memberCount: String(home.memberCount),
					revision: home.revision,
				}),
			),
			found.total,
			request.page,
			found.next,
			found.next ? "partial" : "complete",
			ADDRESS,
		);
	},
};

function readHousehold(
	operation: "people.getHousehold" | "people.getHouseholdMembers",
): ReadAdapter<z.infer<typeof householdRequest>> {
	return {
		operation,
		description:
			operation === "people.getHousehold"
				? "Read one household in this church, by its id or by a person's id, with its live members."
				: "Read the live members of one household in this church, by its id or by a person's id.",
		input: householdRequest,
		allowed: inPlant,
		async invoke(tx, actor, input) {
			const request = householdRequest.parse(input);
			const reply =
				operation === "people.getHousehold"
					? await personFields.getHousehold(tx, readCtx(actor), request)
					: await personFields.getHouseholdMembers(tx, readCtx(actor), request);
			const found = valueOf<z.infer<typeof householdResult>>(reply);
			// A person with no household is a real answer. A missing household is not_found.
			if (!found) return missing(operation, ADDRESS);
			const rows = householdRows(found);
			return result(operation, "available", rows, rows.length, 1, null, "complete", ADDRESS);
		},
	};
}
export const getHousehold = readHousehold("people.getHousehold");
export const getHouseholdMembers = readHousehold("people.getHouseholdMembers");

export const listTags: ReadAdapter<z.infer<typeof listTagsRequest>> = {
	operation: "people.listTags",
	description: "List the tags in this church and how many live people carry each one.",
	input: listTagsRequest,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const found = valueOf<z.infer<typeof tagsResult>>(
			await personFields.listTags(tx, readCtx(actor), listTagsRequest.parse(input)),
		);
		if (!found) return missing("people.listTags");
		return result(
			"people.listTags",
			"available",
			found.items.map((tag) =>
				row("tag", tag.id, tag.name, {
					name: tag.name,
					color: tag.color,
					linkedPeople: String(tag.linkedPeople),
					revision: tag.revision,
				}),
			),
			found.items.length,
			1,
			null,
			"complete",
			[],
		);
	},
};

export const getPersonTags: ReadAdapter<z.infer<typeof personInput>> = {
	operation: "people.getPersonTags",
	description: "Read the tags one person in this church carries, by an id from an earlier result.",
	input: personInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const request = personFieldsRequest.parse(input);
		const found = valueOf<z.infer<typeof personTagsResult>>(
			await personFields.getPersonTags(tx, readCtx(actor), request),
		);
		if (!found) return missing("people.getPersonTags");
		return result(
			"people.getPersonTags",
			"available",
			found.tags.map((tag) => row("tag", tag.id, tag.name, { name: tag.name, color: tag.color })),
			found.tags.length,
			1,
			null,
			"complete",
			[],
		);
	},
};

export const getPersonSkills: ReadAdapter<z.infer<typeof personInput>> = {
	operation: "people.getPersonSkills",
	description: "Read one person's skills in this church, by an id from an earlier result. Skill notes stay out.",
	input: personInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const request = personFieldsRequest.parse(input);
		const found = valueOf<z.infer<typeof personSkillsResult>>(
			await personFields.getPersonSkills(tx, readCtx(actor), request),
		);
		if (!found) return missing("people.getPersonSkills", ["skill notes"]);
		return result(
			"people.getPersonSkills",
			"available",
			found.skills.map((skill) =>
				row("skill", skill.id, skill.name, {
					name: skill.name,
					category: skill.category,
					proficiency: skill.proficiency,
				}),
			),
			found.skills.length,
			1,
			null,
			"complete",
			["skill notes"],
		);
	},
};

const activityInput = z.strictObject({
	personId: z.uuid(),
	...pageInput,
	kinds: z
		.array(z.enum(["note", "activity", "follow_up"]))
		.max(3)
		.optional(),
});
export const getActivities: ReadAdapter<z.infer<typeof activityInput>> = {
	operation: "people.getActivities",
	description:
		"Read one person's history in this church: notes without their text, stage changes and household changes. Merged history shows on the survivor. Care notes stay out.",
	input: activityInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const request = activityRequest.parse({ ...input, limit: input.limit ?? 24, page: input.page ?? 1 });
		const found = valueOf<z.infer<typeof activitiesResult>>(
			await peopleReader.getActivities(tx, readCtx(actor), request),
		);
		if (!found) return missing("people.getActivities", ACTIVITY);
		const rows = activityRows(found.personId, found.items);
		return result(
			"people.getActivities",
			"available",
			rows,
			found.completeness === "complete" ? rows.length : null,
			request.page,
			found.next,
			found.completeness,
			ACTIVITY,
		);
	},
};

const pipelineInput = z.strictObject({
	search: z.string().trim().max(255).optional().describe("Name, email or phone text to match"),
	stages: z.array(stage).max(7).optional(),
	column: pipelineColumn.optional().describe("Read this pipeline column only"),
	...pageInput,
});
export const getPipelineData: ReadAdapter<z.infer<typeof pipelineInput>> = {
	operation: "people.getPipelineData",
	description:
		"Read this church's pipeline board: name, city, stage, column, inactivity and coverage. It does not rank people or return contact values.",
	input: pipelineInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const request = listPeopleRequest.parse({ ...input, limit: input.limit ?? 24, page: input.page ?? 1 });
		const found = valueOf<z.infer<typeof pipelineResult>>(
			await peopleReader.getPipelineData(tx, readCtx(actor), request),
		);
		if (!found) return missing("people.getPipelineData", ["email", "phone", "notes", "birth date", "duty ids"]);
		const known = found.groups.every((group) => group.total !== null);
		const total = known ? found.groups.reduce((sum, group) => sum + (group.total ?? 0), 0) : null;
		const next = found.groups.reduce<number | null>(
			(soonest, group) => (group.next !== null && (soonest === null || group.next < soonest) ? group.next : soonest),
			null,
		);
		return result(
			"people.getPipelineData",
			"available",
			pipelineRows(found),
			total,
			request.page,
			next,
			found.completeness,
			["email", "phone", "notes", "birth date", "duty ids", "private care"],
		);
	},
};

const templateInput = z.strictObject({});
export const generateCsvTemplate: ReadAdapter<z.infer<typeof templateInput>> = {
	operation: "people.generateCsvTemplate",
	description: "Return the people import header. It contains column names only and no church data.",
	input: templateInput,
	allowed: inPlant,
	async invoke() {
		const file = peopleCsv.generateCsvTemplate();
		return result(
			"people.generateCsvTemplate",
			"available",
			[
				row("file", file.filename, file.filename, {
					mediaType: file.mediaType,
					columns: file.text,
				}),
			],
			1,
			1,
			null,
			"complete",
			["church data"],
		);
	},
};

const previewInput = z.strictObject({
	file: z.string().min(1).max(importLimits.bytes).describe("CSV text that uses the import template columns"),
});
export const previewImport: ReadAdapter<z.infer<typeof previewInput>> = {
	operation: "people.previewImport",
	description:
		"Preview a people CSV for this church: row status, the suggested choice and duplicate people. It writes nothing and returns no contact values.",
	input: previewInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const file = previewInput.parse(input).file;
		const found = valueOf<z.infer<typeof importPreview>>(
			await peopleCsv.previewImport(tx, readCtx(actor), { file: new TextEncoder().encode(file) }),
		);
		if (!found) return missing("people.previewImport", CONTACT);
		const rows = previewRows(found);
		return result("people.previewImport", "available", rows, found.counts.rows, 1, null, "complete", CONTACT);
	},
};

const receiptInput = z.strictObject({ requestKey: z.string().min(1).max(200) });
export const getImportReceipt: ReadAdapter<z.infer<typeof receiptInput>> = {
	operation: "people.getImportReceipt",
	description: "Read one people import's row outcomes by its request key. Contact values stay out.",
	input: receiptInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const request = importReceiptRequest.parse(input);
		const found = valueOf<z.infer<typeof importReceipt>>(await peopleCsv.getImportReceipt(tx, readCtx(actor), request));
		if (!found) return missing("people.getImportReceipt", CONTACT);
		const rows = receiptRows(found);
		return result("people.getImportReceipt", "available", rows, found.rows.length, 1, null, "complete", CONTACT);
	},
};

const exportInput = z.strictObject({
	search: z.string().trim().max(255).optional().describe("Name, email or phone text to match"),
	stages: z.array(stage).max(7).optional(),
});
export const exportPeople: ReadAdapter<z.infer<typeof exportInput>> = {
	operation: "people.exportPeople",
	description:
		"Count the people this church's directory export would contain. The file itself stays in the app, with its contact values and notes.",
	input: exportInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const request = exportPeopleRequest.parse(input);
		const found = valueOf<z.infer<typeof peopleExport>>(await peopleCsv.exportPeople(tx, readCtx(actor), request));
		if (!found) return missing("people.exportPeople", ["contact values", "notes", "csv bytes"]);
		return result(
			"people.exportPeople",
			"available",
			[
				row("file", "export", found.filename, {
					matched: String(found.receipt.matched),
					returned: String(found.receipt.returned),
					completeness: found.receipt.completeness,
					mediaType: found.mediaType,
				}),
			],
			found.receipt.matched,
			1,
			null,
			found.receipt.completeness,
			["contact values", "notes", "csv bytes"],
		);
	},
};

/** The installed people-organization read tools, in catalog order. */
export const ORGANIZATION_READS = [
	exportPeople,
	generateCsvTemplate,
	getActivities,
	getHousehold,
	getHouseholdMembers,
	getImportReceipt,
	getPersonSkills,
	getPersonTags,
	getPipelineData,
	listHouseholds,
	listTags,
	previewImport,
] as const;
