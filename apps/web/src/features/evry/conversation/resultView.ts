import type { SourceResult, SourceRow } from "./model.ts";

// What a result card says, as plain data: the title, the count, the notes under the rows and, per row, its name, a short
// line, a link and a mark. ResultCard.tsx draws it. Kept apart so the wording is tested without a browser.

const TITLE: Record<string, string> = {
	"people.listPeople": "People",
	"people.getPerson": "Person",
	"people.getPersonPhoto": "Photo",
	"people.checkForDuplicates": "Possible duplicates",
	"people.listHouseholds": "Households",
	"people.getHousehold": "Household",
	"people.getHouseholdMembers": "Household members",
	"evry.selectReturnedRows": "Selected people",
};
const HOUSEHOLD_LIST = "people.listHouseholds";
const HOUSEHOLD_DETAIL = new Set(["people.getHousehold", "people.getHouseholdMembers"]);
const ROLE: Record<string, string> = { head: "Head", spouse: "Spouse", child: "Child", other: "Other" };

export const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export type RowMark = { kind: "stage"; stage: string } | { kind: "match"; exact: boolean } | null;
export type RowView = {
	key: string;
	name: string;
	line: string | null;
	mark: RowMark;
	avatar: "person" | "household" | null;
	/** Only a person row has a page. A household or any other record has none. */
	href: string | null;
};
export type CardView = {
	title: string;
	summary: string;
	icon: "person" | "people" | "household";
	rows: RowView[];
	facts: string[];
};

function rowView(operation: string, row: SourceRow): RowView {
	const { fields } = row;
	const key = `${row.kind}:${row.id}`;
	if (row.kind === "household") {
		const city = typeof fields.city === "string" && fields.city ? fields.city : null;
		const members = Number(fields.memberCount);
		const size = Number.isFinite(members) ? count(members, "member", "members") : null;
		return {
			key,
			name: row.label,
			line: [city, size].filter(Boolean).join(" · ") || null,
			mark: null,
			avatar: "household",
			href: null,
		};
	}
	const href = row.kind === "person" ? `/people/${row.id}` : null;
	if (operation === "people.getPersonPhoto")
		// The photo read names no person; the row says what it found and opens the person's page.
		return {
			key,
			name: fields.photo === "available" ? "Has a photo" : "No photo",
			line: fields.photo === "available" ? "Open the person's page to see it" : null,
			mark: null,
			avatar: null,
			href,
		};
	if (operation === "people.checkForDuplicates")
		return {
			key,
			name: row.label,
			line: null,
			mark: { kind: "match", exact: fields.match === "exact" },
			avatar: "person",
			href,
		};
	if (HOUSEHOLD_DETAIL.has(operation) && row.kind === "person")
		return {
			key,
			name: row.label,
			line: typeof fields.role === "string" ? (ROLE[fields.role] ?? fields.role) : null,
			mark: null,
			avatar: "person",
			href,
		};
	return {
		key,
		name: row.label,
		line: typeof fields.city === "string" ? fields.city : null,
		mark: typeof fields.stage === "string" ? { kind: "stage", stage: fields.stage } : null,
		avatar: "person",
		href,
	};
}

export function cardView(operation: string, result: SourceResult, originalTotal: number | null): CardView {
	const households = operation === HOUSEHOLD_LIST;
	const detail = HOUSEHOLD_DETAIL.has(operation);
	const shown = result.rows.length;
	const noun = households ? (["household", "households"] as const) : (["person", "people"] as const);
	// A household read counts the people it names; the household's own row is the title of the card, not a person.
	const counted = detail ? result.rows.filter((r) => r.kind === "person").length : shown;
	const summary =
		result.status === "not_found" || (operation === "people.getPersonPhoto" && !shown)
			? "Not found"
			: operation === "people.getPersonPhoto"
				? ""
				: detail || result.total === null || result.total === shown
					? count(counted, noun[0], noun[1])
					: `${shown.toLocaleString()} of ${result.total.toLocaleString()}`;
	const facts: string[] = [];
	if (result.status === "not_found" || !shown)
		facts.push(
			households || detail
				? "No household in this church matches, or you can't see them."
				: "No person in this church matches, or you can't see them.",
		);
	if (result.withheldRows)
		facts.push(`${count(result.withheldRows, "row is", "rows are")} no longer available and not shown.`);
	if (result.completeness === "partial")
		facts.push(
			result.next !== null
				? `More ${households ? "households" : "people"} match. Ask Evry for page ${result.next}.`
				: "Only the first matches are shown.",
		);
	if (operation === "evry.selectReturnedRows") {
		if (originalTotal !== null) facts.push(`Picked from ${count(originalTotal, "match", "matches")}.`);
	} else if (result.exclusions.length) facts.push(`Not included: ${result.exclusions.join(", ")}.`);
	return {
		title: TITLE[operation] ?? "Records",
		summary,
		icon: households || detail ? "household" : shown > 1 ? "people" : "person",
		rows: result.rows.map((row) => rowView(operation, row)),
		facts,
	};
}
