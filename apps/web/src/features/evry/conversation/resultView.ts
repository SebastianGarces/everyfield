import { sendTimeShort } from "../review/model.ts";
import { STAGE_LABEL, type StageValue } from "../../people/model.ts";
import { CATEGORY_TEXT } from "../../settings/model.ts";
import type { SourceResult, SourceRow } from "./model.ts";

// What a result card says, as plain data: the title, the count, the notes under the rows and, per row, its name, a short
// line, a link and a mark. ResultCard.tsx draws it. Kept apart so the wording is tested without a browser.

type Kind = SourceRow["kind"];
export type Glyph = "person" | "people" | Exclude<Kind, "person" | "import">;

/** One operation's card. Every installed read has one; an unknown operation falls back to FALLBACK. */
type OpView = {
	title: string;
	/** The count word, singular and plural, for the rows the card counts. */
	noun: readonly [string, string];
	/** The header icon. "person" turns into "people" when the card shows more than one row. */
	icon: Glyph;
	/** The row kind the summary counts. Other rows (a household or file row heading the card) are not counted. */
	counts: Kind;
	/** The total counts something other than the counted rows, so the summary never says "N of M". */
	shownOnly?: true;
	/** The first row heads the card (a digest's title and dates) and is not one of the counted rows. */
	headed?: true;
	/** Said when nothing came back. */
	empty: string;
	/** A count answer: the summary is the total and the rows stay hidden, with this note instead. */
	countAnswer?: string;
};

const NO_PERSON = "No person in this church matches, or you can't see them.";
const NO_HOUSEHOLD = "No household in this church matches, or you can't see them.";
const people = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["person", "people"],
	icon: "person",
	counts: "person",
	empty: NO_PERSON,
	...rest,
});
const rows = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["row", "rows"],
	icon: "file",
	counts: "import",
	empty: "This file has no rows to show.",
	...rest,
});

const VIEWS: Record<string, OpView> = {
	"people.listPeople": people("People"),
	"people.getPerson": people("Person"),
	"people.getPersonPhoto": people("Photo"),
	"people.checkForDuplicates": people("Possible duplicates"),
	// One row per import review pair: the imported person, with the person it may duplicate on its line.
	"people.listDuplicatePairs": people("Duplicates to review", {
		empty: "No import has flagged a possible duplicate that still needs review.",
	}),
	"people.getPipelineData": people("Pipeline"),
	"evry.selectReturnedRows": people("Selected people"),
	"people.listHouseholds": {
		title: "Households",
		noun: ["household", "households"],
		icon: "household",
		counts: "household",
		empty: NO_HOUSEHOLD,
	},
	// A household read counts the people it names; the household's own row heads the card and is not a person.
	"people.getHousehold": people("Household", { icon: "household", shownOnly: true, empty: NO_HOUSEHOLD }),
	"people.getHouseholdMembers": people("Household members", {
		icon: "household",
		shownOnly: true,
		empty: NO_HOUSEHOLD,
	}),
	"people.listTags": {
		title: "Tags",
		noun: ["tag", "tags"],
		icon: "tag",
		counts: "tag",
		empty: "This church has no tags yet, or you can't see them.",
	},
	"people.getPersonTags": {
		title: "Assigned tags",
		noun: ["tag", "tags"],
		icon: "tag",
		counts: "tag",
		empty: "This person has no tags, or you can't see them.",
	},
	"people.getPersonSkills": {
		title: "Skills",
		noun: ["skill", "skills"],
		icon: "skill",
		counts: "skill",
		empty: "This person has no skills recorded, or you can't see them.",
	},
	"people.getActivities": {
		title: "History",
		noun: ["activity", "activities"],
		icon: "activity",
		counts: "activity",
		empty: "This person has no history to show, or you can't see it.",
	},
	"people.generateCsvTemplate": {
		title: "Import template",
		noun: ["file", "files"],
		icon: "file",
		counts: "file",
		empty: "The import template is not available.",
	},
	"people.previewImport": rows("Import preview"),
	"people.getImportReceipt": rows("Import results", { empty: "No import with that request key, or you can't see it." }),
	"people.exportPeople": people("Directory export", {
		icon: "file",
		countAnswer: "Download the file from the People page.",
	}),
	"communication.list": {
		title: "Messages",
		noun: ["message", "messages"],
		icon: "message",
		counts: "message",
		empty: "No draft or scheduled message in this church matches.",
	},
	"notifications.feed": {
		title: "Notifications",
		noun: ["notification", "notifications"],
		icon: "notice",
		counts: "notice",
		empty: "You have no notifications that match.",
	},
	"notifications.unreadCount": {
		title: "Unread notifications",
		noun: ["unread notification", "unread notifications"],
		icon: "notice",
		counts: "notice",
		empty: "You have no unread notifications.",
		countAnswer: "Open the bell to see them.",
	},
	"notifications.preferences.get": {
		title: "Notification settings",
		noun: ["category", "categories"],
		icon: "setting",
		counts: "setting",
		empty: "Your notification settings are not available.",
	},
	// The digest's own row heads the card; each line under it is one item the digest will list.
	"notifications.previewPlanterDigest": {
		title: "Next church digest",
		noun: ["open item", "open items"],
		icon: "digest",
		counts: "digest",
		headed: true,
		empty: "Your church digest is turned off, so no digest is coming.",
	},
};
/** An operation with no view of its own. A test fails while any installed read falls back to it. */
export const FALLBACK = { title: "Records", noun: ["record", "records"] } as const;
const fallback: OpView = {
	...FALLBACK,
	icon: "file",
	counts: "person",
	empty: "Nothing in this church matches, or you can't see it.",
};
const HOUSEHOLD_DETAIL = new Set(["people.getHousehold", "people.getHouseholdMembers"]);
const ROLE: Record<string, string> = { head: "Head", spouse: "Spouse", child: "Child", other: "Other" };
const SKILL: Record<string, string> = {
	worship: "Worship",
	tech: "Tech",
	admin: "Admin",
	teaching: "Teaching",
	hospitality: "Hospitality",
	leadership: "Leadership",
	other: "Other",
};
const LEVEL: Record<string, string> = {
	beginner: "Beginner",
	intermediate: "Intermediate",
	advanced: "Advanced",
	expert: "Expert",
};
const ACTION: Record<string, string> = { created: "Added to People", updated: "Details changed" };
const SUGGESTED: Record<string, string> = {
	create: "Ready to add",
	create_and_review: "Add, then review the possible duplicate",
	skip: "Skip suggested",
};
const PROBLEM: Record<string, string> = {
	name_required: "Name required",
	invalid_email: "Email not valid",
	too_long: "Value too long",
	invalid_source: "Source not recognized",
	column_count: "Wrong number of columns",
};
const RECEIPT: Record<string, string> = {
	complete: "Import complete",
	partial: "Import partly complete",
	in_progress: "Import in progress",
};
const ROW_OUTCOME: Record<string, string> = {
	created: "Added",
	skipped: "Skipped",
	remaining: "Not added yet",
};

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) => (typeof value === "string" && value !== "" ? Number(value) : Number.NaN);
const joined = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ") || null;
const stage = (value: unknown) => (typeof value === "string" ? (STAGE_LABEL[value as StageValue] ?? value) : null);
/** "Commitment recorded" from "commitment_recorded". */
const words = (value: string) => {
	const s = value.replaceAll("_", " ");
	return s.charAt(0).toUpperCase() + s.slice(1);
};
/** A stored value's label, or the value in words when the table has no label for it. */
const label = (table: Record<string, string>, value: unknown) =>
	typeof value === "string" && value ? (table[value] ?? words(value)) : null;
const categoryText = (value: unknown) =>
	typeof value === "string" ? (CATEGORY_TEXT[value as keyof typeof CATEGORY_TEXT]?.label ?? words(value)) : null;
const day = (value: unknown) => {
	const at = typeof value === "string" ? new Date(value) : null;
	return at && !Number.isNaN(at.getTime())
		? at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
		: null;
};

type RowMark =
	| { kind: "stage"; stage: string }
	| { kind: "match"; exact: boolean }
	| { kind: "status"; text: string; warn: boolean }
	| null;
export type RowView = {
	key: string;
	name: string;
	line: string | null;
	mark: RowMark;
	/** The round mark before the name: a person's initials, or the icon of a household, tag, skill, activity or file. */
	avatar: Exclude<Kind, "import"> | null;
	/** The person whose initials the round mark shows, and whose current photo it shows when there is one. */
	photoFor: string | null;
	/** Only a person (or a row that names the person it created) has a page. A household or any other record has none. */
	href: string | null;
};
export type CardView = {
	title: string;
	summary: string;
	icon: Glyph;
	rows: RowView[];
	facts: string[];
};

function activityLine(fields: Record<string, unknown>) {
	const stageChange = fields.from && fields.to ? `${stage(fields.from)} → ${stage(fields.to)}` : null;
	const home =
		fields.householdFrom || fields.householdTo
			? `${text(fields.householdFrom) ?? "No household"} → ${text(fields.householdTo) ?? "No household"}`
			: null;
	return joined(stageChange, home, day(fields.occurredAt));
}

function rowView(operation: string, row: SourceRow): RowView {
	const { fields } = row;
	const key = `${row.kind}:${row.id}`;
	const plain = { key, mark: null, href: null, photoFor: null } as const;
	switch (row.kind) {
		case "household": {
			const members = num(fields.memberCount);
			return {
				...plain,
				name: row.label,
				line: joined(text(fields.city), Number.isFinite(members) ? count(members, "member", "members") : null),
				avatar: "household",
			};
		}
		case "tag": {
			const linked = num(fields.linkedPeople);
			return {
				...plain,
				name: row.label,
				line: Number.isFinite(linked) ? count(linked, "person", "people") : null,
				avatar: "tag",
			};
		}
		case "skill":
			return {
				...plain,
				name: row.label,
				line: joined(label(SKILL, fields.category), label(LEVEL, fields.proficiency)),
				avatar: "skill",
			};
		case "activity": {
			// Note text never reaches the card: a note row says only that a note was added or removed, and when.
			const kind = fields.kind;
			const name =
				kind === "note"
					? "Note added"
					: kind === "note_removed"
						? "Note removed"
						: kind === "stage_changed"
							? "Stage changed"
							: (ACTION[String(fields.action)] ?? words(String(fields.action ?? row.label)));
			return { ...plain, name, line: activityLine(fields), avatar: "activity" };
		}
		case "file": {
			if (operation === "people.previewImport")
				return {
					...plain,
					name: "Your file",
					line: joined(
						count(num(fields.valid) || 0, "valid row", "valid rows"),
						count(num(fields.invalid) || 0, "invalid row", "invalid rows"),
						num(fields.existingDuplicates) > 0
							? count(num(fields.existingDuplicates), "possible duplicate", "possible duplicates")
							: null,
					),
					avatar: "file",
				};
			if (operation === "people.getImportReceipt")
				return {
					...plain,
					name: RECEIPT[row.label] ?? words(row.label),
					line: joined(
						`${num(fields.created) || 0} added`,
						`${num(fields.skipped) || 0} skipped`,
						`${num(fields.failed) || 0} failed`,
						num(fields.remaining) > 0 ? `${num(fields.remaining)} not added yet` : null,
					),
					avatar: "file",
				};
			const columns = text(fields.columns)?.trim().split(",").length ?? null;
			return {
				...plain,
				name: row.label,
				line: columns ? count(columns, "column", "columns") : null,
				avatar: "file",
			};
		}
		case "import": {
			// A row of the file, named by its row number. Only a row that created a person links to that person.
			const name = `Row ${row.id}`;
			if (operation === "people.getImportReceipt") {
				const personId = text(fields.personId);
				const failed = fields.status === "failed";
				return {
					key,
					name,
					line: failed ? (fields.reason === "invalid" ? "Not valid" : "Could not be written") : null,
					mark: {
						kind: "status",
						text: failed ? "Failed" : (ROW_OUTCOME[String(fields.status)] ?? "Unknown"),
						warn: failed,
					},
					avatar: null,
					photoFor: null,
					href: personId ? `/people/${personId}` : null,
				};
			}
			if (fields.status === "invalid")
				return {
					...plain,
					name,
					line: joined(
						...String(fields.problems ?? "")
							.split(",")
							.filter(Boolean)
							.map((code) => PROBLEM[code] ?? words(code)),
					),
					mark: { kind: "status", text: "Invalid", warn: true },
					avatar: null,
				};
			const twin = text(fields.withinFileDuplicateOf);
			return {
				...plain,
				name,
				line: joined(row.label, twin ? `Same as row ${twin}` : null, SUGGESTED[String(fields.suggested)] ?? null),
				avatar: null,
			};
		}
		case "message":
			// A draft or scheduled message: its send time in the church's zone, never its body or recipients.
			return {
				...plain,
				name: row.label,
				line:
					typeof fields.sendsAtInstant === "string" && typeof fields.zone === "string"
						? `Sends ${sendTimeShort({ at: fields.sendsAtInstant, zone: fields.zone })}`
						: "Draft",
				avatar: null,
			};
		case "notice":
			// A bell notification: its area and church-local time. A card never marks it read.
			return {
				...plain,
				name: row.label,
				line: joined(categoryText(fields.category), text(fields.at)),
				mark: fields.read === false ? { kind: "status", text: "Unread", warn: false } : null,
				avatar: "notice",
			};
		case "setting": {
			const cadence = text(fields.cadence);
			return {
				...plain,
				name: categoryText(row.id) ?? row.label,
				line: joined(
					fields.email ? `Email ${String(fields.email)}` : null,
					fields.inApp ? `In-app ${String(fields.inApp)}` : null,
					cadence ? (cadence === "daily" ? "Daily" : "Weekly") : null,
				),
				avatar: "setting",
			};
		}
		case "digest":
			// The digest's head says when it sends and the dates it covers; each other row is one line of it.
			return row.id === "next"
				? {
						...plain,
						name: row.label,
						line: joined(text(fields.sendsAt) ? `Sends ${String(fields.sendsAt)}` : null),
						avatar: "digest",
					}
				: { ...plain, name: row.label, line: null, avatar: null };
		case "person":
			break;
	}
	const href = `/people/${row.id}`;
	if (operation === "people.getPersonPhoto")
		// The photo read names no person; the row says what it found and opens the person's page.
		return {
			key,
			name: fields.photo === "available" ? "Has a photo" : "No photo",
			line: fields.photo === "available" ? "Open the person's page to see it" : null,
			mark: null,
			avatar: null,
			photoFor: null,
			href,
		};
	if (operation === "people.listDuplicatePairs")
		return {
			key,
			name: row.label,
			line: typeof fields.mayDuplicate === "string" ? `May duplicate ${fields.mayDuplicate}` : null,
			mark: null,
			avatar: "person",
			photoFor: row.id,
			href,
		};
	if (typeof fields.match === "string")
		return {
			key,
			name: row.label,
			line: null,
			mark: { kind: "match", exact: fields.match === "exact" },
			avatar: "person",
			photoFor: row.id,
			href,
		};
	if (HOUSEHOLD_DETAIL.has(operation))
		return {
			key,
			name: row.label,
			line: typeof fields.role === "string" ? (ROLE[fields.role] ?? fields.role) : null,
			mark: null,
			avatar: "person",
			photoFor: row.id,
			href,
		};
	return {
		key,
		name: row.label,
		line: typeof fields.city === "string" ? fields.city : null,
		mark: typeof fields.stage === "string" ? { kind: "stage", stage: fields.stage } : null,
		avatar: "person",
		photoFor: row.id,
		href,
	};
}

/** The rows a card shows. A receipt's created import row links to its person, so the separate person row goes. */
function shownRows(operation: string, view: OpView, result: SourceResult) {
	if (view.countAnswer) return [];
	if (operation === "people.getImportReceipt") return result.rows.filter((r) => r.kind !== "person");
	return result.rows;
}

export function cardView(operation: string, result: SourceResult, originalTotal: number | null): CardView {
	const view = VIEWS[operation] ?? fallback;
	const [one, many] = view.noun;
	const rows = shownRows(operation, view, result);
	const counted = view.countAnswer
		? 0
		: rows.filter((r, n) => r.kind === view.counts && !(view.headed && n === 0)).length;
	const photo = operation === "people.getPersonPhoto";
	const missing = result.status === "not_found" || (photo && !rows.length);
	const summary = missing
		? "Not found"
		: photo
			? ""
			: view.countAnswer
				? count(result.total ?? 0, one, many)
				: view.shownOnly || result.total === null || result.total === counted
					? count(counted, one, many)
					: `${counted.toLocaleString()} of ${result.total.toLocaleString()}`;
	const facts: string[] = [];
	if (missing || !result.rows.length) facts.push(view.empty);
	if (result.withheldRows)
		facts.push(`${count(result.withheldRows, "row is", "rows are")} no longer available and not shown.`);
	if (result.completeness === "partial")
		facts.push(
			result.next !== null
				? `More ${many} match. Ask Evry for page ${result.next}.`
				: "Only the first matches are shown.",
		);
	if (operation === "evry.selectReturnedRows") {
		if (originalTotal !== null) facts.push(`Picked from ${count(originalTotal, "match", "matches")}.`);
	} else if (view.countAnswer) {
		if (!missing) facts.push(view.countAnswer);
	} else if (result.exclusions.length) facts.push(`Not included: ${result.exclusions.join(", ")}.`);
	return {
		title: view.title,
		summary,
		icon: view.icon === "person" && rows.length > 1 ? "people" : view.icon,
		rows: rows.map((row) => rowView(operation, row)),
		facts,
	};
}
