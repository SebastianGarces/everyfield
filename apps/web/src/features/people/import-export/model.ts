// Pure rules of the CSV import and export screens (REQ-PPL-018, REQ-PPL-019): row groups, choices, copy for each
// refusal and problem, and the export's filters in words. No React and no server code.

import type * as csv from "@everyfield/contracts/people";
import type { z } from "zod";
import {
	CLASSIFICATION_LABEL,
	isFiltered,
	SOURCE_LABEL,
	STAGE_LABEL,
	type PeopleQuery,
	type SourceValue,
	type StageValue,
} from "../model.ts";

export type Preview = z.infer<typeof csv.importPreview>;
export type PreviewRow = Preview["rows"][number];
export type ValidRow = Extract<PreviewRow, { status: "valid" }>;
export type Choice = z.infer<typeof csv.importChoice>;
export type ImportReceipt = z.infer<typeof csv.importReceipt>;
export type ReceiptRow = ImportReceipt["rows"][number];
export type RowProblem = z.infer<typeof csv.rowProblem>;
export type ExportReceipt = z.infer<typeof csv.peopleExport>["receipt"];

/** The file limits the server enforces (contract importLimits), checked here first so a too-big file sends nothing. */
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 10_000;
export const ROWS_PER_PAGE = 24;

/** A valid row with an existing or earlier-row match: it needs a person's choice. */
export const isDuplicate = (r: ValidRow) => r.existingDuplicates.length > 0 || r.withinFileDuplicateOf !== null;

export type Group = "check" | "fix" | "all";
export function rowsIn(rows: PreviewRow[], group: Group): PreviewRow[] {
	if (group === "all") return rows;
	if (group === "fix") return rows.filter((r) => r.status === "invalid");
	return rows.filter((r) => r.status === "valid" && isDuplicate(r));
}
/** Open on the rows that need attention: duplicates first, then errors, else everything. */
export function firstGroup(p: Preview): Group {
	if (p.counts.existingDuplicates + p.counts.withinFileDuplicates > 0) return "check";
	return p.counts.invalid > 0 ? "fix" : "all";
}

/** Every valid row's suggested choice. The import sends exactly one choice per valid row. */
export function suggestedChoices(p: Preview): Map<number, Choice> {
	return new Map(p.rows.flatMap((r) => (r.status === "valid" ? [[r.row, r.suggested] as const] : [])));
}
export const choicesPayload = (choices: Map<number, Choice>) => [...choices].map(([row, choice]) => ({ row, choice }));
export function addCount(choices: Map<number, Choice>): number {
	let n = 0;
	for (const c of choices.values()) if (c !== "skip") n++;
	return n;
}

const COLUMN_LABEL: Record<NonNullable<RowProblem["column"]>, string> = {
	first_name: "First name",
	last_name: "Last name",
	email: "Email",
	phone: "Phone",
	street: "Street",
	city: "City",
	state: "State",
	postal_code: "Postal code",
	country: "Country",
	source: "Source",
	source_details: "Source details",
	notes: "Notes",
};
export const SOURCE_VALUES = Object.keys(SOURCE_LABEL) as SourceValue[];

export function problemText(p: RowProblem): string {
	const column = p.column ? COLUMN_LABEL[p.column] : "This row";
	switch (p.code) {
		case "name_required":
			return "Add a first or last name";
		case "invalid_email":
			return "Email is not a complete address";
		case "too_long":
			return `${column} is too long`;
		case "invalid_source":
			return "Source is not one of the listed values";
		case "column_count":
			return "This row has a different number of cells than the header";
	}
}

/** What the upload step says for a refused file. Each answer names the fix. */
export function fileRefusal(code: string, line?: number): { title: string; text: string } {
	switch (code) {
		case "file_too_large":
			return { title: "This file is larger than 10 MB", text: "Split it into smaller files and import each one." };
		case "row_limit_exceeded":
			return {
				title: "This file has more than 10,000 rows",
				text: "Split it into files of 10,000 rows or fewer and import each one.",
			};
		case "unsupported_file_content":
			return {
				title: "This is not a CSV text file",
				text: "Save the spreadsheet as CSV UTF-8 (comma separated), then choose that file.",
			};
		case "malformed_csv_quoting":
			return {
				title: line ? `A quote mark is not closed on line ${line}` : "A quote mark is not closed",
				text: "Open the file, fix the quotes on that line, save it as CSV and choose it again.",
			};
		case "csv_header_invalid":
			return {
				title: "The first row does not match the template",
				text: "The first row needs first_name or last_name, and each column name only once. Start from the template if you are not sure.",
			};
		case "access_denied":
		case "unavailable":
			return {
				title: "You cannot import people now",
				text: "Only Owners and Admins of this church can import. Your seat may have changed.",
			};
		case "lost":
			return {
				title: "We could not check this file",
				text: "The connection dropped or the server did not answer. Nothing was saved. Try again.",
			};
		default:
			return { title: "We could not check this file", text: "Nothing was saved. Try again in a moment." };
	}
}

export const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The rows a running or finished import still has to account for, as a fraction for the progress bar. */
export function progressOf(r: ImportReceipt): { done: number; total: number } {
	const total = r.counts.created + r.counts.skipped + r.counts.failed + r.counts.remaining;
	return { done: total - r.counts.remaining, total };
}

/** The export's filters in words, from the same query the directory shows. */
export function describeFilters(q: PeopleQuery): string[] {
	if (!isFiltered(q)) return ["Everyone in People, without retired people"];
	const out: string[] = [];
	if (q.search) out.push(`Matches “${q.search}”`);
	if (q.stages.length) out.push(`Stage: ${q.stages.map((s: StageValue) => STAGE_LABEL[s]).join(", ")}`);
	if (q.sources.length) out.push(`Source: ${q.sources.map((s) => SOURCE_LABEL[s]).join(", ")}`);
	if (q.tags.length) out.push(q.tags.length === 1 ? "Has the selected tag" : `Has all ${q.tags.length} selected tags`);
	if (q.classification) out.push(`Age: ${CLASSIFICATION_LABEL[q.classification]}`);
	if (q.commitment !== "any")
		out.push(`Commitment: ${{ active: "Committed", withdrawn: "Withdrawn", unknown: "Not recorded" }[q.commitment]}`);
	const archived = q.view === "pipeline" ? "exclude" : q.archived;
	out.push(
		archived === "include"
			? "Includes retired people"
			: archived === "only"
				? "Only retired people"
				: "Without retired people",
	);
	return out;
}
