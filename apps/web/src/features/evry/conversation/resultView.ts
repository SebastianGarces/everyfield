import { sendTimeShort } from "../review/model.ts";
import { STAGE_LABEL, type StageValue } from "../../people/model.ts";
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
	/** The row kind the summary counts, or "all" rows. Other rows (a household or file row heading the card) are not counted. */
	counts: Kind | "all";
	/** The total counts something other than the counted rows, so the summary never says "N of M". */
	shownOnly?: true;
	/** The summary is the read's total (a count by status), and the rows still show. */
	totalOnly?: true;
	/** One record read on its own: no count in the header, only "Not found" when it is gone. */
	quiet?: true;
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

const task = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["task", "tasks"],
	icon: "task",
	counts: "task",
	empty: "No task in this church matches, or you can't see it.",
	...rest,
});
const followUps = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["follow-up", "follow-ups"],
	icon: "follow_up",
	counts: "follow_up",
	empty: "No open follow-up matches, or you can't see it.",
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
	"tasks.list": task("Tasks"),
	"tasks.count": task("Task count", { icon: "tally", counts: "tally", totalOnly: true }),
	"tasks.get": task("Task", { quiet: true, empty: "This task is not available, or you can't see it." }),
	"tasks.statusHistory": {
		title: "Status history",
		noun: ["change", "changes"],
		icon: "history",
		counts: "history",
		empty: "This task has no status changes to show, or you can't see it.",
	},
	"tasks.listSubtasks": task("Checklist", {
		noun: ["item", "items"],
		empty: "This task has no checklist, or you can't see it.",
	}),
	"tasks.listPrerequisites": task("Waits on", { empty: "This task doesn't wait on another task." }),
	"tasks.prerequisiteCandidates": task("Tasks it could wait on", { empty: "No other task matches." }),
	"tasks.findOpenOccurrence": task("Open occurrence", {
		quiet: true,
		empty: "This task doesn't repeat, or every occurrence of it is settled.",
	}),
	"tasks.eligibleAssignees": {
		title: "Who can hold tasks",
		noun: ["account", "accounts"],
		icon: "person",
		counts: "account",
		empty: "Nobody in this church has a seat that can hold tasks.",
	},
	"tasks.relationOptions": {
		title: "Link options",
		noun: ["match", "matches"],
		icon: "task",
		counts: "all",
		empty: "Nothing in this church matches that name.",
	},
	"tasks.listTemplates": {
		title: "Task checklists",
		noun: ["checklist", "checklists"],
		icon: "template",
		counts: "template",
		empty: "No checklist is available.",
	},
	"tasks.previewTemplate": {
		title: "Checklist preview",
		noun: ["task", "tasks"],
		icon: "template",
		counts: "template",
		quiet: true,
		empty: "This checklist is not available.",
	},
	"tasks.readPhaseOffer": {
		title: "Phase checklists",
		noun: ["item", "items"],
		icon: "template",
		counts: "all",
		empty: "No checklist is offered after the latest phase move.",
	},
	"tasks.importReceipt": {
		title: "Checklist imports",
		noun: ["import", "imports"],
		icon: "template",
		counts: "template",
		empty: "No checklist was imported yet, or you can't see it.",
	},
	"tasks.listFollowUpOwners": followUps("Follow-ups"),
	"tasks.planHandoff": followUps("Handoff plan", { empty: "This account holds no open follow-ups." }),
	"followups.readObligations": followUps("Meeting follow-ups", {
		empty: "No meeting follow-up matches, or you can't see it.",
	}),
	"followups.listContactHistory": {
		title: "Contact log",
		noun: ["entry", "entries"],
		icon: "contact",
		counts: "contact",
		empty: "Nothing is recorded in this contact log. That doesn't prove nobody reached out.",
	},
	"tasks.followUpCoverage": people("Follow-up coverage"),
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
const num = (value: unknown) =>
	typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : Number.NaN;
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
const day = (value: unknown) => {
	// A church-local time ("2026-11-05 15:30 America/Chicago") names its own calendar day.
	const local = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2} /.exec(value) : null;
	if (local)
		return new Date(`${local[1]}T12:00:00Z`).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			timeZone: "UTC",
		});
	const at = typeof value === "string" ? new Date(value) : null;
	return at && !Number.isNaN(at.getTime())
		? at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
		: null;
};

/** "Oct 9" or "Oct 9, 2:30 PM" from a church-local due date ("2026-10-09", "2026-10-09 14:30 America/Chicago"). */
const localDay = (value: unknown) => {
	const m = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value) : null;
	if (!m) return null;
	const at = new Date(`${m[1]}T${m[2] ?? "00"}:${m[3] ?? "00"}:00Z`);
	if (Number.isNaN(at.getTime())) return null;
	const date = at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
	return m[2]
		? `${date}, ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })}`
		: date;
};
const due = (value: unknown) => (localDay(value) ? `Due ${localDay(value)}` : null);
/** Owners by name; the signed-in user's own account reads "Yours" alone, else "you" among the names. */
const owners = (value: unknown) => {
	const names = text(value);
	return names === "you" ? "Yours" : names;
};
const TASK_STATUS: Record<string, string> = {
	not_started: "Not started",
	in_progress: "In progress",
	blocked: "Blocked",
	complete: "Complete",
	no_longer_needed: "No longer needed",
};
const OBLIGATION_STATE: Record<string, string> = {
	open: "Open",
	complete: "Complete",
	no_longer_needed: "No longer needed",
	superseded: "Replaced",
};
/** An outcome as the contact log names it. Only a conversation is contact. */
const OUTCOME: Record<string, string> = {
	contacted: "Conversation",
	attempted_no_contact: "Attempt, no conversation",
	administrative_completion: "Admin completion",
	no_longer_needed: "No longer needed",
};
const CHANNEL: Record<string, string> = {
	phone: "Phone call",
	text: "Text message",
	in_person: "In person",
	video: "Video call",
	email: "Email",
	other: "Other",
};
/** How a conversation happened, as the first word of its row: "Call — conversation". */
const CONVERSATION_BY: Record<string, string> = {
	phone: "Call",
	text: "Text",
	in_person: "In person",
	video: "Video call",
	email: "Email",
};
const ROLE_WORD: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const CATEGORY: Record<string, string> = { follow_up: "Follow-up" };
const COVERAGE: Record<string, string> = {
	needs_owner: "Follow-up needs an owner",
	uncovered: "No open follow-up",
};
/** "meeting: Interest meeting" as "Meeting: Interest meeting". */
const capital = (value: unknown) => {
	const s = text(value);
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
};
/** A checklist key ("launch-prep") in words, for a receipt that names only the key. */
const keyWords = (value: string) =>
	/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value) ? words(value.replaceAll("-", " ")) : value;

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
	/** The round mark before the name: a person's (or an account's) initials, or the icon of any other record. */
	avatar: Exclude<Kind, "import"> | null;
	/** The person whose initials the round mark shows, and whose current photo it shows when there is one. */
	photoFor: string | null;
	/**
	 * A person (or a row that names its person: a created import row, a follow-up, a contact log entry) opens the person;
	 * a top-level task opens in Tasks. A household or any other record has no page.
	 */
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
		case "task":
			return taskView(operation, row, key);
		case "tally": {
			const n = num(fields.count);
			const done = num(fields.complete);
			return {
				...plain,
				name: row.id === "checklist" ? "Checklist items" : label(TASK_STATUS, row.label)!,
				line: Number.isFinite(done)
					? `${done.toLocaleString()} of ${count(n || 0, "item", "items")} done`
					: count(n || 0, "task", "tasks"),
				avatar: "tally",
			};
		}
		case "history":
			return {
				...plain,
				name: fields.from ? `${label(TASK_STATUS, fields.from)} → ${label(TASK_STATUS, fields.to)}` : "Created",
				line: joined(day(fields.occurredAt), text(fields.by) ? `By ${fields.by}` : null),
				avatar: "history",
			};
		case "follow_up":
			return followUpView(operation, row, key);
		case "contact": {
			const outcome = String(fields.outcome ?? row.label);
			const by = CONVERSATION_BY[String(fields.channel)];
			const personId = text(fields.personId);
			return {
				key,
				name: outcome === "contacted" ? (by ? `${by} — conversation` : "Conversation") : label(OUTCOME, outcome)!,
				line: joined(
					day(fields.occurredAt),
					outcome === "contacted" ? null : label(CHANNEL, fields.channel),
					text(fields.recordedBy) ? `Recorded by ${fields.recordedBy}` : null,
				),
				mark:
					fields.state === "corrected"
						? { kind: "status", text: "Corrected", warn: false }
						: fields.state === "voided"
							? { kind: "status", text: "Withdrawn", warn: false }
							: null,
				avatar: "contact",
				photoFor: null,
				href: personId ? `/people/${personId}` : null,
			};
		}
		case "account":
			// A seat's account, by its name: its initials, never a Person's photo or page.
			return {
				...plain,
				// The avatar's initials come from the name, so "You" goes on the line.
				name: row.label,
				line: joined(
					fields.you === true ? "You" : null,
					label(ROLE_WORD, fields.role),
					fields.canOwnFollowUps === true
						? "Can own follow-ups"
						: fields.canOwnFollowUps === false
							? "Can't own follow-ups"
							: null,
					fields.canTakeThem === true ? "Can take them" : null,
				),
				avatar: "person",
			};
		case "template":
			return templateView(operation, row, key);
		case "meeting":
		case "team":
			return { ...plain, name: row.label, line: row.kind === "meeting" ? "Meeting" : "Team", avatar: row.kind };
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
	if (operation === "tasks.followUpCoverage")
		return {
			key,
			name: row.label,
			line:
				fields.coverage === "owned"
					? text(fields.owners)
						? `Followed up by ${fields.owners}`
						: "Has an open follow-up"
					: (COVERAGE[String(fields.coverage)] ?? null),
			mark: typeof fields.stage === "string" ? { kind: "stage", stage: fields.stage } : null,
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

/** A task, a checklist item, a prerequisite or a task a phase offer created. */
function taskView(operation: string, row: SourceRow, key: string): RowView {
	const { fields } = row;
	const child = text(fields.parentId) !== null;
	const deleted = fields.deleted === true;
	const settled = fields.status === "complete" || fields.status === "no_longer_needed";
	const mark: RowMark = deleted
		? { kind: "status", text: "Deleted", warn: false }
		: fields.overdue === true && !settled
			? { kind: "status", text: "Overdue", warn: true }
			: fields.blocking === true
				? { kind: "status", text: "Not done yet", warn: true }
				: fields.status && fields.status !== "not_started"
					? { kind: "status", text: label(TASK_STATUS, fields.status)!, warn: false }
					: null;
	const owner = fields.needsOwner === true ? "Needs owner" : owners(fields.owners);
	const phase =
		fields.fromPhase !== undefined && fields.toPhase !== undefined
			? `Added after the move to Phase ${fields.toPhase}`
			: null;
	const line =
		operation === "tasks.readPhaseOffer"
			? phase
			: joined(
					due(fields.due),
					owner,
					fields.followUp === true && text(fields.person)
						? `Follow-up with ${fields.person}`
						: capital(fields.relatedTo),
					text(fields.checklist),
					fields.status === "complete" ? (day(fields.completedAt) ? `Done ${day(fields.completedAt)}` : null) : null,
				);
	return {
		key,
		name: row.label,
		line,
		mark,
		avatar: "task",
		photoFor: null,
		// The Tasks page opens one top-level task from its address; a checklist item opens with its task.
		href: deleted ? null : `/tasks?task=${child ? String(fields.parentId) : row.id}`,
	};
}

/** An open follow-up (by person), or a meeting's generated follow-up or evaluation. */
function followUpView(operation: string, row: SourceRow, key: string): RowView {
	const { fields } = row;
	const personId = text(fields.personId);
	const owner = fields.needsOwner === true ? "Nobody assigned" : owners(fields.owners);
	const origin = text(fields.from);
	const from = origin?.startsWith("meeting: ") ? `From ${origin.slice(9)}` : origin ? capital(origin) : null;
	const obligation = operation === "followups.readObligations";
	const open = obligation ? fields.state === "open" : true;
	const mark: RowMark =
		fields.overdue === true && open
			? { kind: "status", text: "Overdue", warn: true }
			: obligation && fields.state !== "open"
				? { kind: "status", text: label(OBLIGATION_STATE, fields.state)!, warn: false }
				: null;
	const line = obligation
		? joined(
				text(fields.meeting)
					? `From ${fields.meeting}${localDay(fields.meetingDate) ? ` (${localDay(fields.meetingDate)})` : ""}`
					: null,
				open ? owner : null,
				open ? due(fields.due) : null,
				fields.completedWith ? (label(OUTCOME, fields.completedWith) ?? null) : null,
				fields.contacted === true ? "Contact recorded" : null,
			)
		: joined(owner, due(fields.due), from, fields.lastOutcome ? `Last: ${label(OUTCOME, fields.lastOutcome)}` : null);
	return {
		key,
		name: row.label,
		line,
		mark,
		avatar: personId ? "person" : "follow_up",
		photoFor: personId,
		href: personId ? `/people/${personId}` : null,
	};
}

/** A phase checklist, one task a checklist would create, or a receipt of an import. */
function templateView(operation: string, row: SourceRow, key: string): RowView {
	const { fields } = row;
	const plain = { key, mark: null, href: null, photoFor: null, avatar: "template" } as const;
	if (operation === "tasks.importReceipt")
		return {
			...plain,
			name: keyWords(row.label),
			line: joined(
				capital(fields.receipt),
				day(fields.at),
				count(num(fields.tasksCreated) || 0, "task created", "tasks created"),
			),
		};
	const tasks = num(fields.taskCount);
	if (!Number.isFinite(tasks))
		// One task of a previewed checklist, with the date it would be due.
		return { ...plain, name: row.label, line: joined(due(fields.due), label({}, fields.priority)), avatar: null };
	return {
		...plain,
		name: row.label,
		line: joined(
			`Phase ${fields.phase}`,
			label(CATEGORY, fields.category),
			count(tasks, "task", "tasks"),
			fields.toPhase !== undefined ? `Offered after the move to Phase ${fields.toPhase}` : null,
		),
		mark:
			fields.currentPhase !== undefined && fields.currentPhase === fields.phase
				? { kind: "status", text: "Current phase", warn: false }
				: null,
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
	const counted = view.countAnswer ? 0 : rows.filter((r) => view.counts === "all" || r.kind === view.counts).length;
	const photo = operation === "people.getPersonPhoto";
	const missing = result.status === "not_found" || ((photo || view.quiet) && !rows.length);
	const summary = missing
		? "Not found"
		: photo || view.quiet
			? ""
			: view.countAnswer || view.totalOnly
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
