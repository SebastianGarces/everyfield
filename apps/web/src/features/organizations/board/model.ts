import { STARTER_STAGES, type PipelineBoardQuery, type PipelineRefusal } from "@everyfield/contracts/organizations";

// Shared by the Pipeline page and a person's record: labels, dates, URL filters and refusal copy. No React and no
// server code.

export const PIPELINE_PATH = "/organization/pipeline";

/** Each stage kind's name: the starter stage's label, and "Other". */
export const KIND_LABEL: Record<string, string> = Object.fromEntries([...STARTER_STAGES, ["other", "Other"]]);

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** A calendar day (YYYY-MM-DD) as "Oct 17, 2026". The day is already the organization's own. */
export const formatDay = (value: string) => day.format(new Date(`${value}T00:00:00Z`));

type Search = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** The board's filters from the address (D67). Anything unreadable falls back to its default. */
export function queryFromSearch(search: Search): PipelineBoardQuery {
	const page = Number(first(search.page));
	return {
		view: first(search.view) === "retired" ? "retired" : "board",
		stale: first(search.stale) === "1",
		q: (first(search.q) ?? "").trim().slice(0, 100),
		page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
	};
}
/** The address of the board under `query`. A filter change returns to page one, as the caller decides. */
export function boardHref(query: PipelineBoardQuery) {
	const params = new URLSearchParams();
	if (query.view === "retired") params.set("view", "retired");
	if (query.stale) params.set("stale", "1");
	if (query.q) params.set("q", query.q);
	if (query.page > 1) params.set("page", String(query.page));
	const text = params.toString();
	return text ? `${PIPELINE_PATH}?${text}` : PIPELINE_PATH;
}

/** What an `invalid_input` refusal says, by the field it names; a list item's position is dropped (`counts.2.label`). */
const FIELD_PROBLEM: Record<string, string> = {
	assessedOn: "The date can’t be after today.",
	occurredOn: "The date can’t be after today.",
	leaderTarget: "Targets can’t be less than 0.",
	plantTarget: "Targets can’t be less than 0.",
	targetYear: "Enter a year between 2000 and 2200.",
	goals: "You can keep up to 50 goals.",
	countingFrom: "The counting-from date can’t be after today.",
	counts: "A goal can have up to 4 counts.",
	"counts.kind": "This goal already counts that stage kind. Choose another kind.",
	"counts.label": "Name each count in 1 to 60 characters.",
	label: "Two stages can’t have the same name.",
	responsibleSeatId: "That staff member no longer has a seat here. Choose someone else.",
};

/** What a refused or lost change tells the person. */
export function refusalText(answer: { status: "refused"; refusal: PipelineRefusal } | { status: "lost" }) {
	if (answer.status === "lost") return "We couldn’t reach Everyfield. Nothing was saved. Try again.";
	const r = answer.refusal;
	switch (r.code) {
		case "conflict":
			return "Someone changed this while you were working. Reload the page to see the latest, then try again.";
		case "invalid_input":
			return (
				FIELD_PROBLEM[(r.field ?? "").replace(/\.\d+(?=\.|$)/g, "")] ?? "Check the highlighted fields and try again."
			);
		case "stage_occupied":
			return `This stage still has ${r.people === 1 ? "1 person" : `${r.people} people`} in it. Move them to another stage first.`;
		default:
			return "You don’t have access to make this change.";
	}
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The exact changes between the saved stages and the edited list, in the words the review shows (REQ-MUL-008). */
export function stageChanges(
	saved: readonly { id: string; label: string }[],
	rows: readonly { id: string; label: string; kind: string }[],
) {
	const before = new Map(saved.map((s) => [s.id, s]));
	const kept = new Set(rows.map((r) => r.id));
	const changes: string[] = [];
	for (const r of rows) {
		const was = before.get(r.id);
		if (!was) changes.push(`Add “${r.label.trim()}”, counted as ${KIND_LABEL[r.kind]}`);
		else if (was.label !== r.label.trim()) changes.push(`Rename “${was.label}” to “${r.label.trim()}”`);
	}
	for (const s of saved) if (!kept.has(s.id)) changes.push(`Delete “${s.label}”`);
	// The order changed when the stages that stay are no longer in their saved order, or a new stage is not last.
	const savedOrder = saved.filter((s) => kept.has(s.id)).map((s) => s.id);
	const naturalOrder = [...savedOrder, ...rows.filter((r) => !before.has(r.id)).map((r) => r.id)];
	if (rows.some((r, i) => r.id !== naturalOrder[i]))
		changes.push(`New order: ${rows.map((r, i) => `${i + 1}. ${r.label.trim()}`).join(", ")}`);
	return changes;
}

/** A goal in words, from its own numbers: "Develop 6 leaders to plant 2 churches by 2028". */
export function goalHeadline(goal: { leaderTarget: number; plantTarget: number; targetYear: number }) {
	const leaders = goal.leaderTarget ? `Develop ${plural(goal.leaderTarget, "leader")}` : "";
	const plants = goal.plantTarget ? `plant ${plural(goal.plantTarget, "church", "churches")}` : "";
	const aim = leaders && plants ? `${leaders} to ${plants}` : leaders || plants.replace(/^p/, "P");
	return aim ? `${aim} by ${goal.targetYear}` : `Goal for ${goal.targetYear}`;
}

const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
/** "2026-10" as "Oct"; January also names its year, so a row that crosses a year reads plainly. */
export const monthLabel = (month: string) => {
	const name = monthName.format(new Date(`${month}-01T00:00:00Z`));
	return month.endsWith("-01") ? `${name} ${month.slice(0, 4)}` : name;
};
