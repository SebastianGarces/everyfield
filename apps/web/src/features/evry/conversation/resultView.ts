import { LEFT_OUT_REASON, sendTimeShort } from "../review/model.ts";
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
	/** The row kind the summary counts. Other rows (a household or file row heading the card) are not counted. */
	counts: Kind;
	/** The total counts something other than the counted rows, so the summary never says "N of M". */
	shownOnly?: true;
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
	"people.getImportReceipt": rows("Import results", { empty: "No import found, or you can't see it." }),
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
	"communication.preview": people("Who it reaches", {
		empty: "Nobody in this church is in that audience, or you can't see them.",
	}),
	"communication.get": people("Email results", {
		icon: "message",
		empty: "No email in Messages matches, or you can't see it.",
	}),
	"communication.forPerson": {
		title: "Emails",
		noun: ["email", "emails"],
		icon: "message",
		counts: "message",
		shownOnly: true,
		empty: "Messages has no email to this person.",
	},
	"communication.templates.list": {
		title: "Email templates",
		noun: ["template", "templates"],
		icon: "template",
		counts: "template",
		empty: "No email template is available.",
	},
	"communication.resendCandidates": people("Resend", {
		icon: "message",
		shownOnly: true,
		empty: "That email is not in Messages, or you can't see it.",
	}),
};
/** With no person, communication.forPerson lists the people no email has gone out to. */
const NEVER_EMAILED = people("No email recorded", {
	empty: "Every live person in this church has had an email from Messages.",
});
// The Ministries reads (WP-069). A ministry row opens its Ministries page; a person row opens the person.
const ministries = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["ministry", "ministries"],
	icon: "team",
	counts: "team",
	empty: "No ministry in this church matches, or you can't see it.",
	...rest,
});
const roles = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["role", "roles"],
	icon: "role",
	counts: "role",
	empty: "No role matches, or you can't see it.",
	...rest,
});
const programs = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["program", "programs"],
	icon: "training",
	counts: "training",
	empty: "No training program matches, or you can't see it.",
	...rest,
});
const TEAM_VIEWS: Record<string, OpView> = {
	"teams.list": ministries("Ministries"),
	"teams.get": people("Ministry roster", {
		icon: "team",
		shownOnly: true,
		empty: "This ministry has no one serving now.",
	}),
	"teams.searchMembers": people("Serving in ministries", { icon: "team" }),
	"teams.staffingSummary": ministries("Staffing"),
	"teams.personTeamCounts": people("Serving on several ministries", {
		icon: "team",
		empty: "No one serves on that many ministries now.",
	}),
	"teams.staffingFacts": ministries("Staffing facts"),
	"teams.health": ministries("Ministry health"),
	"teams.aggregateHealth": ministries("Ministry health"),
	"teams.trainingMatrix": people("Required training", { icon: "training", shownOnly: true }),
	"teams.readRequiredTrainingParticipants": people("Required training", { icon: "training", shownOnly: true }),
	"teams.previewRequiredTrainingParticipants": people("Proposed required list", { icon: "training", shownOnly: true }),
	"teams.listTraining": programs("Training programs"),
	"teams.personTraining": people("Ministries and training", { icon: "training" }),
	"teams.trainingHistory": {
		title: "Training history",
		noun: ["entry", "entries"],
		icon: "training",
		counts: "activity",
		empty: "This person has no training recorded.",
	},
	"teams.personAssignments": roles("Ministry roles", { empty: "This person holds no ministry role." }),
	"teams.membershipHistory": people("Past members", { icon: "team", empty: "No one has left this ministry." }),
	"teams.history": {
		title: "Ministry history",
		noun: ["change", "changes"],
		icon: "activity",
		counts: "activity",
		empty: "This ministry has no changes recorded.",
	},
	"teams.listRoles": roles("Roles"),
	"teams.leaderCandidates": people("Possible leaders"),
	"teams.orgChart": ministries("Organization view"),
	"teams.exportOrgChart": {
		title: "Organization view",
		noun: ["file", "files"],
		icon: "file",
		counts: "file",
		empty: "The organization view is not available.",
	},
	"teams.listImportTemplates": {
		title: "Ministry templates",
		noun: ["template", "templates"],
		icon: "template",
		counts: "template",
		empty: "No ministry template is available.",
	},
	"teams.previewTemplateImport": {
		title: "Import preview",
		noun: ["template", "templates"],
		icon: "template",
		counts: "template",
		empty: "Nothing to import.",
	},
	"teams.listResponsibilities": {
		title: "Responsibilities",
		noun: ["responsibility", "responsibilities"],
		icon: "responsibility",
		counts: "responsibility",
		empty: "This ministry has no responsibilities yet.",
	},
	"teams.previewResponsibilities": {
		title: "Suggested responsibilities",
		noun: ["suggestion", "suggestions"],
		icon: "responsibility",
		counts: "template",
		empty: "No Playbook responsibilities are waiting for this ministry.",
	},
	"teams.listMeetings": {
		title: "Team meetings",
		noun: ["meeting", "meetings"],
		icon: "meeting",
		counts: "meeting",
		empty: "This ministry has no team meetings.",
	},
};
Object.assign(VIEWS, TEAM_VIEWS);

/** An operation with no view of its own. A test fails while any installed read falls back to it. */
export const FALLBACK = { title: "Records", noun: ["record", "records"] } as const;
const fallback: OpView = {
	...FALLBACK,
	icon: "file",
	counts: "person",
	empty: "Nothing in this church matches, or you can't see it.",
};
/** One recipient's recorded result. "Sent" is never "delivered": only the email service's report says that. */
const RESULT: Record<string, string> = {
	waiting: "Waiting for its send time",
	checking: "Result still being checked",
	sent: "Sent, delivery not confirmed yet",
	delivered: "Delivered",
	opened: "Delivered, open recorded",
	bounced: "Bounced",
	failed: "Not sent",
	cancelled: "Cancelled",
	unsubscribed: "Unsubscribed, not sent",
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
					// The reason in words, as the receipt read gives it: each column and what is wrong with it.
					line: failed ? (text(fields.reason) ?? "Not valid") : null,
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
		case "team": {
			const percent = (v: unknown) => (typeof v === "number" ? `${v}%` : null);
			const health =
				"staffingPercent" in fields
					? joined(
							`Staffing ${percent(fields.staffingPercent) ?? "unknown"}`,
							`Training ${percent(fields.trainingPercent) ?? "unknown"}`,
							`Attendance ${percent(fields.attendancePercent) ?? "unknown"}`,
							typeof fields.windowFrom === "string" && typeof fields.windowTo === "string"
								? `${day(fields.windowFrom + "T12:00:00Z")} – ${day(fields.windowTo + "T12:00:00Z")}`
								: null,
						)
					: null;
			const staffing =
				typeof fields.roles === "number"
					? joined(
							`${fields.filledRoles} of ${count(fields.roles, "role", "roles")} filled`,
							count(Number(fields.people), "person", "people"),
						)
					: null;
			const leader =
				fields.leaderStatus === "none"
					? "No leader"
					: fields.leaderStatus === "unavailable"
						? "Leader unavailable"
						: text(fields.leader)
							? `Led by ${fields.leader}`
							: null;
			const composite = fields.composite;
			return {
				...plain,
				name: row.label,
				line:
					health ??
					joined(
						leader,
						staffing ?? (typeof fields.people === "number" ? count(fields.people, "person", "people") : null),
					),
				mark:
					"composite" in fields
						? {
								kind: "status",
								text: typeof composite === "number" ? `Composite ${composite}` : "Unknown",
								warn: false,
							}
						: fields.leaderStatus === "none"
							? { kind: "status", text: "No leader", warn: true }
							: fields.archived === true
								? { kind: "status", text: "Archived", warn: false }
								: null,
				avatar: "team",
				href: operation === "teams.staffingFacts" ? null : `/ministries/${row.id}`,
			};
		}
		case "role":
			return {
				...plain,
				name: row.label,
				line: joined(
					text(fields.team),
					text(fields.filledBy) ? `Filled by ${fields.filledBy}` : null,
					text(fields.since) ? `Since ${day(fields.since + "T12:00:00Z")}` : null,
					text(fields.ended) ? `Ended ${day(fields.ended + "T12:00:00Z")}` : null,
				),
				mark:
					fields.open === true
						? { kind: "status", text: "Open", warn: true }
						: fields.retired === true
							? { kind: "status", text: "Retired", warn: false }
							: fields.current === false
								? { kind: "status", text: "Past", warn: false }
								: null,
				avatar: "role",
			};
		case "training":
			return {
				...plain,
				name: row.label,
				line:
					typeof fields.of === "number"
						? `${fields.complete} of ${fields.of} finished`
						: fields.required === false && fields.requiredPeople === 0
							? null
							: typeof fields.requiredPeople === "number"
								? joined(
										`${fields.finished} of ${count(fields.requiredPeople, "required person", "required people")} finished`,
										fields.churchWide === true ? "Church-wide" : null,
									)
								: typeof fields.people === "number"
									? count(fields.people, "person", "people")
									: null,
				mark: fields.required === false ? { kind: "status", text: "Optional", warn: false } : null,
				avatar: "training",
			};
		case "meeting":
			return {
				...plain,
				name: row.label,
				// An email's meeting carries its start; a ministry's team meeting its date and status.
				line: text(fields.startsAt)
					? text(fields.startsAt)
					: joined(day(String(fields.date) + "T12:00:00Z"), text(fields.status) ? words(String(fields.status)) : null),
				avatar: "meeting",
				href: `/meetings/${row.id}`,
			};
		case "responsibility":
			return {
				...plain,
				name: row.label,
				line: text(fields.doneOn) ? `Done ${day(fields.doneOn + "T12:00:00Z")}` : null,
				mark: fields.done === true ? { kind: "status", text: "Done", warn: false } : null,
				avatar: "responsibility",
			};
		case "template":
			return {
				...plain,
				name: row.label,
				// An email template says where it comes from; a ministry template what importing it adds.
				line:
					"origin" in fields
						? fields.origin === "system"
							? "System template · copy it to edit"
							: "Church template"
						: fields.alreadyHere === true
							? joined("Already here", text(fields.newRoles) ? `Adds ${fields.newRoles}` : "Nothing new")
							: joined(text(fields.newRoles) ? `Adds ${fields.newRoles}` : null, text(fields.roles)),
				avatar: "template",
			};
		case "message":
			// What happened to a sent email, in the words of its recorded results.
			if (typeof fields.result === "string")
				return {
					...plain,
					name: row.label,
					line: joined(RESULT[fields.result] ?? fields.result, text(fields.sentAt)),
					avatar: null,
				};
			if (typeof fields.results === "string")
				return { ...plain, name: row.label, line: joined(text(fields.sentAt), fields.results), avatar: null };
			if ("tooSoon" in fields)
				return {
					...plain,
					name: row.label,
					line: fields.tooSoon ? `Can resend from ${text(fields.resendFrom)}` : joined("Sent", text(fields.sentAt)),
					avatar: null,
				};
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
	// A person in an email's audience or results: why they are left out, or what happened to their email.
	if ("leftOut" in fields || "result" in fields || fields.email === "no email recorded")
		return {
			key,
			name: row.label,
			line:
				typeof fields.leftOut === "string"
					? `Left out: ${LEFT_OUT_REASON[fields.leftOut] ?? fields.leftOut}`
					: typeof fields.result === "string"
						? (RESULT[fields.result] ?? fields.result)
						: fields.email === "no email recorded"
							? "No email recorded"
							: "Gets it",
			mark: null,
			avatar: "person",
			photoFor: row.id,
			href,
		};
	if (operation.startsWith("teams."))
		return {
			key,
			name: row.label,
			line:
				typeof fields.complete === "string"
					? text(fields.program)
					: typeof fields.ministries === "number"
						? joined(count(fields.ministries, "ministry", "ministries"), text(fields.names))
						: joined(
								text(fields.role)
									? text(fields.team)
										? `${fields.role} · ${fields.team}`
										: String(fields.role)
									: null,
								text(fields.currentMinistries),
								text(fields.ended) ? `Ended ${day(fields.ended + "T12:00:00Z")}` : null,
							),
			mark:
				typeof fields.complete === "string"
					? {
							kind: "status",
							text: fields.complete === "yes" ? "Finished" : "Not finished",
							warn: fields.complete !== "yes",
						}
					: typeof fields.stage === "string" && !("role" in fields)
						? { kind: "stage", stage: fields.stage }
						: null,
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
	// A roster leads with its people: the ministry, then who serves, then its role slots.
	if (operation === "teams.get")
		return ["team", "person", "role"].flatMap((kind) => result.rows.filter((r) => r.kind === kind));
	return result.rows;
}

export function cardView(operation: string, result: SourceResult, originalTotal: number | null): CardView {
	const view =
		operation === "communication.forPerson" && result.rows.some((r) => r.kind === "person")
			? NEVER_EMAILED
			: (VIEWS[operation] ?? fallback);
	const [one, many] = view.noun;
	const rows = shownRows(operation, view, result);
	const counted = view.countAnswer ? 0 : rows.filter((r) => r.kind === view.counts).length;
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
	const totals = result.facts ?? {};
	if (typeof totals.roles === "number")
		facts.push(
			`${count(totals.roles, "role", "roles")} in all: ${totals.filledRoles} filled, ${totals.openRoles} open. ${Number(totals.peopleServing).toLocaleString()} serving, each counted once however many roles they hold.`,
		);
	if (typeof totals.measuredMinistries === "number")
		facts.push(
			`${totals.measuredMinistries} of ${count(Number(totals.ministries), "ministry", "ministries")} measured${typeof totals.composite === "number" ? `; their composite is ${totals.composite}` : ""}. A ministry with a missing measure is Unknown.`,
		);
	if (typeof totals.minTeams === "number")
		facts.push(`On ${totals.minTeams} or more current ministries. A count to look at, never a limit.`);
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
