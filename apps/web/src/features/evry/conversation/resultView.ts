import { z } from "zod";
import { timeText } from "@everyfield/contracts/common";
import { fourCs, interviewCriteria } from "@everyfield/contracts/people";
import { correctedFieldLabel, correctedValueText } from "../../people/corrections/model.ts";
import { fieldLabel, LEFT_OUT_REASON, sendTimeShort, valueText } from "../review/model.ts";
import { CHANNEL_LABEL } from "../../followups/model.ts";
import { STAGE_LABEL, type StageValue } from "../../people/model.ts";
import { CATEGORY_LABEL } from "../../tasks/model.ts";
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
	/** The row kind the summary counts, or "all" rows. Other rows (a household or file row heading the card) are not counted. */
	counts: Kind | "all";
	/** The total counts something other than the counted rows, so the summary never says "N of M". */
	shownOnly?: true;
	/** The summary is the read's total (a count by status), and the rows still show. */
	totalOnly?: true;
	/** One record read on its own: no count in the header, only "Not found" when it is gone. */
	quiet?: true;
	/** Of the rows of the counted kind, only these count (a commitment's current state heads its cards). */
	countIf?: (row: SourceRow) => boolean;
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
const meetings = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["meeting", "meetings"],
	icon: "meeting",
	counts: "meeting",
	empty: "No meeting in this church matches, or you can't see it.",
	...rest,
});
const items = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["item", "items"],
	icon: "meeting",
	counts: "item",
	empty: "Nothing to show for this meeting.",
	...rest,
});
const venues = (title: string): OpView => ({
	title,
	noun: ["venue", "venues"],
	icon: "venue",
	counts: "venue",
	empty: "No saved venue matches.",
});
const rows = (title: string, rest: Partial<OpView> = {}): OpView => ({
	title,
	noun: ["row", "rows"],
	icon: "file",
	counts: "import",
	empty: "This file has no rows to show.",
	...rest,
});
// The calendar helpers (WP-085): one row, the church's today or the one local date and time checked.
const calendar = (title: string): OpView => ({
	title,
	noun: ["date", "dates"],
	icon: "date",
	counts: "date",
	empty: "This church's calendar is not available.",
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

/** A card of recorded interviews, assessments, commitments, merges or corrections (Owners and Admins only). */
const records = (
	title: string,
	noun: readonly [string, string],
	empty: string,
	rest: Partial<OpView> = {},
): OpView => ({ title, noun, icon: "record", counts: "record", empty, ...rest });

const wiki = (title: string, rest: Partial<OpView> & Pick<OpView, "empty">): OpView => ({
	title,
	noun: ["article", "articles"],
	icon: "article",
	counts: "article",
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
	"people.getInterviews": records("Interviews", ["interview", "interviews"], "This person has no recorded interview."),
	"people.getAssessments": records(
		"4 C's assessments",
		["assessment", "assessments"],
		"This person has no recorded 4 C's assessment.",
	),
	"people.getCommitments": records("Commitment", ["card", "cards"], "This person has no commitment recorded.", {
		countIf: (row) => row.fields.record === "commitment",
	}),
	"people.getCommitmentDownload": records(
		"Signed document",
		["document", "documents"],
		"This card has no signed document on file.",
	),
	"people.getMergeReview": {
		title: "Merge review",
		noun: ["person", "people"],
		icon: "merge",
		counts: "person",
		shownOnly: true,
		empty: NO_PERSON,
	},
	"people.previewUnmerge": records("Undo merge", ["merge", "merges"], "No merge in this church matches.", {
		icon: "merge",
		counts: "merge",
	}),
	"people.listRecordCorrections": records(
		"Corrections",
		["correction", "corrections"],
		"No record of this person was corrected.",
		{
			icon: "correction",
			counts: "correction",
		},
	),
	"people.mergedPersonDestination": records("Where this record leads", ["record", "records"], NO_PERSON, {
		icon: "merge",
		counts: "merge",
	}),
	"seats.list": {
		title: "Seats",
		noun: ["seat", "seats"],
		icon: "seat",
		counts: "seat",
		empty: "No one has a seat in this church.",
	},
	"seats.listInvitations": {
		title: "Invitations",
		noun: ["invitation", "invitations"],
		icon: "invitation",
		counts: "invitation",
		empty: "No invitation is waiting.",
	},
	"privacy.getSharing": {
		title: "Sharing",
		noun: ["connection", "connections"],
		icon: "connection",
		counts: "connection",
		empty: "This church is not connected with that organization.",
	},
	"onboarding.getResume": {
		title: "Setup",
		noun: ["step", "steps"],
		icon: "step",
		counts: "step",
		empty: "This church has no setup in progress for you.",
	},
	"discovery.getProfile": {
		title: "Discovery space",
		noun: ["linked organization", "linked organizations"],
		icon: "relationship",
		counts: "relationship",
		empty: "No sending church or network is linked yet.",
	},
	// The organization pipeline as the seat's Pipeline page shows it: each stage's count, then the people it may see.
	"pipeline.listPeople": {
		title: "Pipeline",
		noun: ["stage", "stages"],
		icon: "stage",
		counts: "stage",
		shownOnly: true,
		empty: "This pipeline has no stages yet.",
	},
	"development.draftPlan": {
		title: "Who can direct a program",
		noun: ["staff member", "staff members"],
		icon: "seat",
		counts: "seat",
		empty: "Only an Owner or Admin sees who may direct a program.",
	},
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
	"meetings.list": meetings("Meetings", { empty: "No meeting in this church matches." }),
	"meetings.get": meetings("Meeting"),
	"meetings.hasHistory": items("Meeting history", { noun: ["answer", "answers"] }),
	"meetings.readAgenda": items("Agenda", { noun: ["section", "sections"], empty: "This meeting has no saved agenda." }),
	"meetings.listKit": items("Vision kit", { empty: "No kit item matches." }),
	// RSVPs are the guests' answers to the invitation, never attendance.
	"meetings.listGuests": people("RSVPs", { icon: "meeting", empty: "This meeting has no guests yet." }),
	"meetings.listCards": people("Response cards", { icon: "meeting", empty: "No response card is recorded." }),
	"meetings.cardBreakdown": items("Card responses", { noun: ["group", "groups"] }),
	"meetings.invitationAttribution": people("Invited by", { icon: "meeting", empty: "This meeting has no guests yet." }),
	"meetings.communicationContext": people("Invitation", { icon: "meeting", shownOnly: true }),
	"meetings.listCompletedPreLaunchPractices": items("Practices held", { noun: ["answer", "answers"] }),
	"meetings.getOwnRsvp": items("Your RSVP", {
		noun: ["answer", "answers"],
		empty: "You're not a guest of this meeting.",
	}),
	"meetings.listAttendance": people("Attendance", { icon: "meeting", shownOnly: true }),
	"meetings.attendanceSummary": items("Attendance summary", { noun: ["summary", "summaries"] }),
	"meetings.getEvaluation": items("Evaluation", { noun: ["evaluation", "evaluations"] }),
	"meetings.evaluationHistory": items("Evaluation history", {
		noun: ["entry", "entries"],
		empty: "No evaluation is recorded.",
	}),
	"meetings.evaluationTrend": items("Evaluation trend", {
		noun: ["meeting", "meetings"],
		empty: "No meeting has an evaluation.",
	}),
	"meetings.compareEvaluation": items("Evaluation compared", { noun: ["comparison", "comparisons"] }),
	// A held meeting with no attendance recorded says so; it is never counted as 0.
	"meetings.attendanceTrend": items("Attendance trend", {
		noun: ["meeting", "meetings"],
		empty: "No held meeting matches.",
	}),
	"meetings.summaryStats": items("Meetings summary", { noun: ["summary", "summaries"] }),
	"meetings.linkedTaskProgress": items("Meeting tasks", { noun: ["summary", "summaries"] }),
	"meetings.readAnalytics": items("Meeting report", { noun: ["report", "reports"] }),
	"meetings.previewRosterImport": people("Guest list update", {
		icon: "meeting",
		empty: "The guest list already matches the ministry.",
	}),
	"venues.list": venues("Venues"),
	"venues.get": venues("Venue"),
	"venues.history": items("Venue history", {
		icon: "venue",
		noun: ["change", "changes"],
		empty: "No change is recorded.",
	}),
	"notifications.feed": {
		title: "Notifications",
		noun: ["notification", "notifications"],
		icon: "notice",
		counts: "notice",
		empty: "You have no notifications that match.",
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
	// One line per plant and day; the total counts activities, not lines.
	"notifications.previewOversightDigest": {
		title: "Next oversight digest",
		noun: ["line", "lines"],
		icon: "digest",
		counts: "digest",
		headed: true,
		shownOnly: true,
		empty: "Your oversight digest has nothing owed yet.",
	},
	"calendar.getContext": calendar("Today"),
	"calendar.resolve": calendar("Date check"),
	"wiki.search": wiki("Wiki articles", { empty: "No Wiki article to show." }),
	"wiki.referenceExcerpt": wiki("From the Wiki", { empty: "This article is not in your Wiki, or you can't read it." }),
	"wiki.recommendForPhase": wiki("Suggested reading", { empty: "The Wiki has no suggestions for your phase." }),
	"wiki.reading.resume": wiki("Where you left off", { empty: "You haven't opened a Wiki article yet." }),
	"wiki.article.exportPdf": wiki("Wiki PDF", {
		noun: ["file", "files"],
		empty: "This article is not in your Wiki, or you can't read it.",
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
/** "2026-11-01T01:30", a church's local wall time, as "Sun, Nov 1, 2026, 1:30 AM". */
function localName(local: string) {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
	if (!m) return local;
	const wall = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(wall);
}
const DATE_STATUS: Record<string, string> = {
	ambiguous: "Happens twice",
	nonexistent: "Skipped by the clocks",
	invalid_date: "Not a date",
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
const categoryText = (value: unknown) =>
	typeof value === "string" ? (CATEGORY_TEXT[value as keyof typeof CATEGORY_TEXT]?.label ?? words(value)) : null;
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
const CHANNEL: Record<string, string> = CHANNEL_LABEL;
/** How a conversation happened, as the first word of its row: "Call — conversation". */
const CONVERSATION_BY: Record<string, string> = {
	phone: "Call",
	text: "Text",
	in_person: "In person",
	video: "Video call",
	email: "Email",
};
const ROLE_WORD: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const CATEGORY: Record<string, string> = CATEGORY_LABEL;
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
	 * A person (or a row that names its person: a created import row, a follow-up, a contact log entry), a meeting and a
	 * Wiki article open their page; a top-level task opens in Tasks. A household or any other record has no page.
	 */
	href: string | null;
	/** A recorded judgment in full, field by field: every criterion, score, result and note, never clamped. */
	details?: { label: string; value: string }[];
	/** The row opens a file through the People page's download route, which signs its link only when opened. */
	download?: true;
	/** The link opens a file the app makes (the agenda's print view) in a new tab. */
	newTab?: true;
	/** A file the row downloads (the Wiki's PDF): a plain link, never prefetched. */
	file?: string;
	/** The Wiki's own words, quoted under the row: an excerpt exactly as the article has it, markup aside. */
	quote?: string;
};
export type CardView = {
	title: string;
	summary: string;
	icon: Glyph;
	rows: RowView[];
	facts: string[];
};

/** An excerpt's words without its markup: headings, emphasis marks and component tags go, line breaks stay. */
const plainExcerpt = (excerpt: string) =>
	excerpt
		.replace(/<\/?[A-Za-z][^>]*>/g, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

function activityLine(fields: Record<string, unknown>) {
	const stageChange = fields.from && fields.to ? `${stage(fields.from)} → ${stage(fields.to)}` : null;
	const home =
		fields.householdFrom || fields.householdTo
			? `${text(fields.householdFrom) ?? "No household"} → ${text(fields.householdTo) ?? "No household"}`
			: null;
	return joined(stageChange, home, day(fields.occurredAt));
}

const corrected = z.array(z.object({ field: z.string(), old: z.unknown(), new: z.unknown() }));
/** Each corrected field with its old and new value, in the People correction history's words. */
function correctionDetails(value: unknown) {
	let raw: unknown = null;
	try {
		raw = typeof value === "string" ? JSON.parse(value) : null;
	} catch {
		// A saved row in another shape shows no details rather than breaking the conversation.
	}
	const parsed = corrected.safeParse(raw);
	return parsed.success
		? parsed.data.map((c) => ({
				label: correctedFieldLabel(c.field),
				value: `${correctedValueText(c.old)} → ${correctedValueText(c.new)}`,
			}))
		: undefined;
}
/** One field of a record row, in the review card's words: "Team chemistry: Concern · Needs time". */
const detail = (field: string, value: unknown) => {
	const v = valueText(field, value);
	return v ? { label: fieldLabel(field), value: v } : null;
};
const details = (...items: ({ label: string; value: string } | null)[]) =>
	items.filter((x): x is { label: string; value: string } => x !== null);
function recordRow(row: SourceRow, plain: Pick<RowView, "key" | "mark" | "href" | "photoFor">): RowView {
	const f = row.fields;
	const judged = (k: string, score: boolean) =>
		detail(
			k,
			score ? { score: Number(f[k]), notes: f[`${k}Notes`] ?? null } : { rating: f[k], notes: f[`${k}Notes`] ?? null },
		);
	switch (f.record) {
		case "interview":
			return {
				...plain,
				name: `Interview on ${valueText("occurredOn", f.occurredOn) ?? "an unknown date"}`,
				line: valueText("result", f.result),
				avatar: "record",
				details: details(
					...interviewCriteria.map((k) => judged(k, false)),
					detail("result", f.result),
					detail("nextSteps", f.nextSteps),
				),
			};
		case "assessment":
			return {
				...plain,
				name: `4 C's on ${valueText("occurredOn", f.occurredOn) ?? "an unknown date"}`,
				line: typeof f.total === "string" ? `Total ${f.total} of 20` : null,
				avatar: "record",
				details: details(...fourCs.map((k) => judged(k, true)), detail("total", f.total)),
			};
		case "commitment_status":
			return {
				...plain,
				name: `Commitment: ${valueText("commitment", f.state) ?? "Not recorded"}`,
				line: f.effectiveOn ? `Since ${valueText("effectiveOn", f.effectiveOn)}` : null,
				avatar: "record",
			};
		case "commitment":
			return {
				...plain,
				name: `${valueText("kind", f.kind) ?? "Commitment"} card, signed ${valueText("occurredOn", f.occurredOn) ?? ""}`.trim(),
				line: joined(f.voided === true ? "Voided" : null, f.document === "attached" ? "Signed document on file" : null),
				avatar: "record",
				details: details(detail("witness", f.witness), detail("cardNotes", f.notes)),
			};
		case "commitment_document":
			return {
				...plain,
				name: "Download the signed document",
				line: joined(
					text(f.mediaType) === "application/pdf" ? "PDF" : text(f.mediaType) ? "Image" : null,
					num(f.byteCount) > 0 ? `${Math.max(1, Math.round(num(f.byteCount) / 1024))} KB` : null,
				),
				avatar: "file",
				href: text(f.href),
				download: true,
			};
	}
	return { ...plain, name: row.label, line: null, avatar: "record" };
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
			// A team a task may be linked to (tasks.relationOptions): its name only.
			if (operation === "tasks.relationOptions") return { ...plain, name: row.label, line: "Team", avatar: "team" };
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
		case "responsibility":
			return {
				...plain,
				name: row.label,
				line: text(fields.doneOn) ? `Done ${day(fields.doneOn + "T12:00:00Z")}` : null,
				mark: fields.done === true ? { kind: "status", text: "Done", warn: false } : null,
				avatar: "responsibility",
			};
		case "template":
			// A task checklist (tasks.*) or a team template.
			if (operation.startsWith("tasks.")) return templateView(operation, row, key);
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
		case "record":
			return recordRow(row, plain);
		case "merge": {
			const blocked = text(fields.blocked);
			return {
				...plain,
				name: row.label,
				line: blocked
					? null
					: joined(
							text(fields.moves) ? `Moves over: ${text(fields.moves)}` : null,
							text(fields.movesBack) ? `Moves back: ${text(fields.movesBack)}` : null,
							fields.status === "merged" ? "Merged into another person" : null,
						),
				mark: blocked ? { kind: "status", text: "Can't run", warn: true } : null,
				avatar: "merge",
				details: blocked ? [{ label: "Why", value: blocked }] : undefined,
			};
		}
		case "correction":
			return {
				...plain,
				name: `${words(String(fields.recordType ?? "Record"))} corrected ${day(fields.correctedAt) ?? ""}`.trim(),
				line: text(fields.reason),
				avatar: "correction",
				details: correctionDetails(fields.changes),
			};
		case "meeting": {
			// A meeting a task may be linked to (tasks.relationOptions): its name only.
			if (operation === "tasks.relationOptions")
				return { ...plain, name: row.label, line: "Meeting", avatar: "meeting", href: `/meetings/${row.id}` };
			// An email's meeting carries its start; a ministry's team meetings (teams.listMeetings) the date and status.
			if (!operation.startsWith("meetings."))
				return {
					...plain,
					name: row.label,
					line: text(fields.startsAt)
						? text(fields.startsAt)
						: joined(
								day(String(fields.date) + "T12:00:00Z"),
								text(fields.status) ? words(String(fields.status)) : null,
							),
					avatar: "meeting",
					href: `/meetings/${row.id}`,
				};
			const status = text(fields.status);
			if (typeof fields.print === "string")
				return { ...plain, name: "Print agenda", line: row.label, avatar: "meeting", href: fields.print, newTab: true };
			if (operation === "meetings.readAgenda")
				return {
					...plain,
					name: row.label,
					line: "Printing is for Vision meeting agendas",
					avatar: "meeting",
					href: `/meetings/${row.id}`,
				};
			return {
				...plain,
				name: row.label,
				line: joined(text(fields.when), text(fields.venue)),
				mark: status === "cancelled" ? { kind: "status", text: "Cancelled", warn: true } : null,
				avatar: "meeting",
				href: `/meetings/${row.id}`,
			};
		}
		case "venue":
			return {
				...plain,
				name: row.label,
				line: joined(text(fields.address), fields.active === false ? "Archived" : null),
				avatar: "venue",
			};
		case "item":
			return {
				...plain,
				name: row.label,
				line: itemLine(operation, fields),
				mark: itemMark(operation, fields),
				avatar: null,
			};
		case "seat":
			// A seat: the person's name and role, as Settings > Seats lists it.
			return {
				...plain,
				href: "/settings/seats",
				name: row.label,
				line: joined(text(fields.role), fields.you === true ? "You" : null),
				avatar: null,
			};
		case "invitation":
			return {
				...plain,
				href: "/settings/seats",
				name: row.label,
				line: joined(
					text(fields.role),
					typeof fields.expiresAt === "string" ? `Expires ${day(fields.expiresAt)}` : null,
				),
				avatar: null,
			};
		case "connection":
			// A connection and what this church shares with it; a Member sees only that Owners and Admins choose.
			return {
				...plain,
				href: "/settings/sharing",
				name: row.label,
				line:
					typeof fields.shared === "string"
						? fields.shared === "nothing"
							? "Shares nothing"
							: `Shares ${fields.shared}`
						: "Owners and Admins choose what is shared",
				avatar: null,
			};
		case "step":
			// A setup step as `/onboarding` shows it: saved with its answer, or still open.
			return {
				...plain,
				href: "/onboarding",
				name: row.label,
				line: text(fields.answer),
				mark: { kind: "status", text: fields.status === "saved" ? "Saved" : "Open", warn: fields.status !== "saved" },
				avatar: null,
			};
		case "stage": {
			// A pipeline stage: everyone in it, and how many of them this answer lists when a filter narrowed it.
			const all = Number(fields.count ?? 0);
			const shown = typeof fields.matching === "number" && fields.matching !== all ? `, ${fields.matching} listed` : "";
			return {
				...plain,
				href: "/organization/pipeline",
				name: row.label,
				line: `${count(all, "person", "people")}${shown}`,
				avatar: null,
			};
		}
		case "relationship":
			// A sending church or network a Discovery space is linked to, and what that link shares.
			return {
				...plain,
				href: "/onboarding",
				name: row.label,
				line: `${text(fields.relationship)} · ${typeof fields.shares === "string" ? `Shares ${fields.shares}` : "Shares nothing"}`,
				avatar: null,
			};
		case "date": {
			// calendar.getContext names today; calendar.resolve says whether the local time exists once, twice or not at all.
			if (operation === "calendar.getContext")
				return {
					...plain,
					name: joined(text(fields.weekday), text(fields.today)) ?? row.label,
					line: joined(text(fields.zone), text(fields.zoneName)),
					avatar: "date",
				};
			const status = String(fields.status);
			return {
				...plain,
				name: status === "invalid_date" ? row.label : localName(String(fields.local ?? row.label)),
				// An exact time names its zone abbreviation ("EST", the end of "Sun, Nov 1, 2026, 1:30 AM EST"); the answer under
				// the card lists both times of a fold. The status sits on the line, not in a tag, so the date keeps its width.
				line: joined(
					status === "exact" ? (text(fields.shows)?.split(" ").at(-1) ?? null) : (DATE_STATUS[status] ?? "Not a date"),
					text(fields.zone),
				),
				avatar: "date",
			};
		}
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
						line: joined(
							text(fields.sendsAt)
								? `${fields.sent === false ? "Would send" : "Sends"} ${String(fields.sendsAt)}`
								: null,
							fields.sent === false ? "Not sent: nothing to report" : null,
						),
						avatar: "digest",
					}
				: { ...plain, name: row.label, line: null, avatar: null };
		case "article": {
			// A version other than the global one says whose it is, as the Wiki page does.
			const whose =
				fields.source === "network"
					? "Your network's version"
					: fields.source === "church"
						? "Your sending church's version"
						: null;
			const line =
				operation === "wiki.search"
					? text(fields.snippet)
					: operation === "wiki.reading.resume"
						? joined(text(fields.read) && `${String(fields.read)} read`, fields.completed === true ? "Finished" : null)
						: operation === "wiki.recommendForPhase"
							? text(fields.phase)
							: operation === "wiki.article.exportPdf"
								? "Download the PDF"
								: text(fields.section);
			return {
				...plain,
				name: row.label,
				line: joined(line, whose),
				avatar: "article",
				href: operation === "wiki.article.exportPdf" ? null : text(fields.href),
				...(operation === "wiki.article.exportPdf" && text(fields.pdfHref) ? { file: text(fields.pdfHref)! } : {}),
				...(operation === "wiki.referenceExcerpt" && text(fields.excerpt)
					? { quote: plainExcerpt(text(fields.excerpt)!) }
					: {}),
			};
		}
		case "person":
			break;
	}
	// A person in an organization's pipeline: their stage, last move and responsible staff, and their pipeline record.
	if (operation === "pipeline.listPeople")
		return {
			key,
			name: row.label,
			line: joined(
				text(fields.stage),
				typeof fields.lastMovedOn === "string" ? `Last moved ${day(`${fields.lastMovedOn}T12:00:00Z`)}` : null,
				typeof fields.responsible === "string" ? `With ${fields.responsible}` : null,
			),
			mark: null,
			avatar: "person",
			photoFor: null,
			href: `/organization/pipeline/${row.id}`,
		};
	const meetingMark = personMark(operation, fields);
	if (meetingMark !== undefined)
		return {
			key,
			name: row.label,
			line: typeof fields.invitedBy === "string" ? `Invited by ${fields.invitedBy}` : null,
			mark: meetingMark,
			avatar: "person",
			photoFor: row.id,
			href: `/people/${row.id}`,
		};
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
	if (operation === "people.getMergeReview")
		return {
			key,
			name: row.label,
			line: fields.role === "stays" ? "Stays" : "Merges in",
			mark: null,
			avatar: "person",
			photoFor: row.id,
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

const RSVP_TEXT: Record<string, string> = { yes: "RSVP yes", no: "RSVP no", "no answer": "No answer" };
const PRESENCE_TEXT: Record<string, string> = { attended: "Attended", absent: "Absent", excused: "Excused" };
/** A person row of a meeting read: their RSVP, presence, card or roster change. Undefined for any other read. */
function personMark(operation: string, fields: Record<string, unknown>): RowMark | undefined {
	if (!operation.startsWith("meetings.")) return undefined;
	const value = (table: Record<string, string>, key: unknown) =>
		typeof key === "string" ? (table[key] ?? words(key)) : null;
	const say = (t: string | null, warn = false): RowMark => (t ? { kind: "status", text: t, warn } : null);
	if (operation === "meetings.listAttendance") return say(value(PRESENCE_TEXT, fields.presence));
	if (operation === "meetings.listCards") return say(typeof fields.card === "string" ? words(fields.card) : null);
	if (operation === "meetings.previewRosterImport")
		return say(
			fields.change === "add" ? "Adds" : fields.change === "remove" ? "Removes" : "Stays",
			fields.change === "remove",
		);
	return say(value(RSVP_TEXT, fields.rsvp), fields.rsvp === "no");
}
/** The short line of an item row: an agenda section's start and length, a kit item's category, a trend point. */
function itemLine(operation: string, f: Record<string, unknown>): string | null {
	switch (operation) {
		case "meetings.readAgenda":
			return joined(
				typeof f.starts === "string" ? timeText(f.starts) : null,
				text(f.minutes) ? `${f.minutes as string} min` : null,
			);
		case "meetings.listKit":
			return joined(typeof f.category === "string" ? words(f.category) : null, text(f.assignee));
		case "meetings.attendanceTrend":
			return joined(
				day(`${String(f.date)}T12:00:00Z`),
				f.attended === "not recorded" ? "Not recorded" : `${String(f.attended)} attended`,
			);
		case "meetings.evaluationTrend":
			return joined(day(`${String(f.date)}T12:00:00Z`), `Average ${String(f.average)}`);
		case "meetings.getEvaluation":
			return f.recorded === false ? "No evaluation recorded yet" : `Average ${String(f.average)} of 5`;
		case "meetings.listCompletedPreLaunchPractices":
			return `${String(f.held)} held`;
		case "meetings.getOwnRsvp":
			return typeof f.rsvp === "string" ? (RSVP_TEXT[f.rsvp] ?? f.rsvp) : null;
		case "meetings.hasHistory":
			return f.hasHistory ? "Meetings are on record" : "No meeting on record";
		default: {
			// A report line: its counts, in the words of its fields.
			const parts = Object.entries(f)
				.filter(([, v]) => typeof v === "string" && v !== "")
				.slice(0, 4)
				.map(([k, v]) => `${words(k.replace(/([A-Z])/g, " $1").toLowerCase())} ${String(v)}`);
			return parts.join(" · ") || null;
		}
	}
}
function itemMark(operation: string, f: Record<string, unknown>): RowMark {
	if (operation === "meetings.listKit")
		return { kind: "status", text: f.checked ? "Checked" : "Needed", warn: !f.checked };
	if (operation === "meetings.attendanceTrend" && f.attended === "not recorded")
		return { kind: "status", text: "Not recorded", warn: true };
	return null;
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
	const counted = view.countAnswer
		? 0
		: rows.filter(
				(r, n) =>
					(view.counts === "all" || r.kind === view.counts) &&
					!(view.headed && n === 0) &&
					(!view.countIf || view.countIf(r)),
			).length;
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
	const totals = result.facts ?? {};
	if (typeof totals.phase === "string")
		facts.push(
			`${String(totals.church ?? "Your church")} is in ${totals.phase}.${typeof totals.launchDate === "string" ? ` Launch date ${totals.launchDate}.` : ""}${typeof totals.resumeAt === "string" && !totals.finished ? ` Setup picks up at ${totals.resumeAt}.` : ""}`,
		);
	if (operation === "pipeline.listPeople" && typeof totals.asOf === "string")
		facts.push(
			typeof totals.measured === "string"
				? `As of ${day(`${totals.asOf}T12:00:00Z`)}. ${totals.measured}`
				: `As of ${day(`${totals.asOf}T12:00:00Z`)}.`,
		);
	if (typeof totals.discoveryClosedOn === "string")
		facts.push(`Your Discovery space closed on ${totals.discoveryClosedOn}, when it became this church.`);
	if (typeof totals.foundationsRead === "number")
		facts.push(`${totals.foundationsRead} of ${Number(totals.foundationsTotal)} foundation articles read.`);
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
