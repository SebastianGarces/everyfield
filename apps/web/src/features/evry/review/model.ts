import type { MailReport, RecipientOutcome } from "@everyfield/contracts/communication";
import { CHANNEL_LABEL } from "../../followups/model.ts";
import { ROLE_LABEL, SHARING_CATEGORIES, SHARING_CATEGORY_LABEL, ZONE_NAME } from "@everyfield/evry/labels";
import { SOURCE_LABEL, STAGE_LABEL, type SourceValue, type StageValue } from "../../people/model.ts";
import { CATEGORY_LABEL, PRIORITY_LABEL } from "../../tasks/model.ts";
import { TASK_REFUSAL, type ProjectedError } from "../conversation/model.ts";
import {
	CRITERION_LABEL,
	FIELD_LABEL as MERGE_FIELD_LABEL,
	LENS_LABEL,
	RATING_LABEL,
	RESULT_LABEL,
	type InterviewResult,
	type MergeField,
	type Rating,
} from "../../people/corrections/model.ts";

export type Operation =
	| "people.createPerson"
	| "people.updatePerson"
	| "people.changeStatus"
	| "people.deletePerson"
	| "people.setPersonPhoto"
	| "people.removePersonPhoto"
	| "people.createInterview"
	| "people.createAssessment"
	| "people.createCommitment"
	| "people.withdrawCommitment"
	| "people.reactivateCommitment"
	| "people.correctCommitmentLifecycle"
	| "people.correctPersonRecord"
	| "people.mergePeople"
	| "people.unmergePeople"
	| OrganizationOperation
	| "communication.saveDraft"
	| "communication.scheduleReviewed"
	| "communication.rescheduleReviewed"
	| "communication.cancelScheduledReviewed"
	| "communication.replaceScheduledReviewed"
	| TaskOperation
	| "communication.sendReviewed"
	| "communication.executeResend"
	| "communication.retryProvenFailed"
	| "communication.deleteDraft"
	| "communication.templates.create"
	| "communication.templates.fork"
	| "communication.templates.update"
	| "meetings.schedule"
	| "meetings.edit"
	| "meetings.changeStatus"
	| "meetings.delete"
	| "meetings.completePractice"
	| "meetings.correctPracticeOccurrence"
	| "meetings.correctOccurrence"
	| "meetings.replaceAgenda"
	| "meetings.populateKit"
	| "meetings.updateKitItem"
	| "meetings.inviteGuest"
	| "meetings.removeGuest"
	| "meetings.setInviter"
	| "meetings.correctRsvp"
	| "meetings.saveOwnRsvp"
	| "meetings.createGuestContact"
	| "meetings.createWalkInContact"
	| "meetings.recordCard"
	| "meetings.clearCard"
	| "meetings.copyTeamRoster"
	| "meetings.setAttendance"
	| "meetings.checkIn"
	| "meetings.clearAttendance"
	| "meetings.captureAttendanceBatch"
	| "meetings.finalizeAttendance"
	| "meetings.reconcileAttendance"
	| "meetings.recordEvaluation"
	| "meetings.correctEvaluation"
	| "meetings.addAttendeeNote"
	| "venues.create"
	| "venues.edit"
	| "venues.correct"
	| "venues.archive"
	| "venues.restore"
	| "documents.createFromTemplate"
	| "documents.exportNative"
	| "documents.archive"
	| "documents.designateCoreValues"
	| "notifications.markSelectedRead"
	| "notifications.markAllVisibleRead"
	| "notifications.setPreferences"
	| "notifications.digestCadence.set"
	| "notifications.oversightDigestCadence.set"
	| "wiki.bookmarks.set"
	| "wiki.feedback.setMine"
	| TeamsOperation
	| "phases.declare"
	| "phases.transition"
	| "signals.attest"
	| "signals.correct"
	| "signals.reaffirm"
	| SettingsOperation
	| PipelineOperation
	| LaunchOperation;

export type LaunchOperation =
	| "launch.schedule"
	| "launch.postpone"
	| "launch.recordOutcome"
	| "launch.submitDebrief"
	| "launch.publishDebriefSummary"
	| "launch.completeMilestone"
	| "launch.reopenMilestone"
	| "launch.addGuestAttendance"
	| "launch.correctOutcome";
export const isLaunch = (operation: Operation): operation is LaunchOperation => operation.startsWith("launch.");

export type PipelineOperation =
	"pipeline.proposeStageMove" | "development.saveProgram" | "development.draftNextVersion";
export const isPipeline = (operation: Operation): operation is PipelineOperation =>
	operation === "pipeline.proposeStageMove" ||
	operation === "development.saveProgram" ||
	operation === "development.draftNextVersion";
export const asksReason = (operation: Operation) => operation === "pipeline.proposeStageMove";
export function pipelineLink(review: Pick<Review, "operation" | "review">): { href: string; label: string } {
	const who = review.review.target;
	if (review.operation === "development.draftNextVersion" && who)
		return { href: `/organization/pipeline/programs/${who.id}`, label: "Open the program" };
	return review.operation === "pipeline.proposeStageMove" && who
		? { href: `/organization/pipeline/${who.id}`, label: `Open ${who.label}` }
		: { href: "/organization/pipeline/programs", label: "Open Programs" };
}
type TaskOperation =
	| "tasks.create"
	| "tasks.configureRecurrence"
	| "tasks.edit"
	| "tasks.complete"
	| "tasks.completeOccurrence"
	| "tasks.reopen"
	| "tasks.changeStatus"
	| "tasks.waive"
	| "tasks.delete"
	| "tasks.bulkComplete"
	| "tasks.bulkReschedule"
	| "tasks.createSubtask"
	| "tasks.setSubtaskCompletion"
	| "tasks.removeSubtask"
	| "tasks.createFollowUp"
	| "tasks.assignFollowUp"
	| "tasks.reopenObligation"
	| "followups.recordOutcome"
	| "followups.correctOutcome";

const TEAMS_TITLE = {
	"teams.create": "Add a ministry",
	"teams.edit": "Update a ministry",
	"teams.archive": "Archive a ministry",
	"teams.restore": "Restore a ministry",
	"teams.createRole": "Add a role",
	"teams.editRole": "Update a role",
	"teams.retireRole": "Retire a role",
	"teams.assignRole": "Fill a role",
	"teams.assignMember": "Add to a ministry",
	"teams.removeRole": "End a role",
	"teams.endMembership": "Leave a ministry",
	"teams.reactivateMembership": "Return to a role",
	"teams.appointLeader": "Appoint a leader",
	"teams.initialize": "Import ministries",
	"teams.importRoles": "Import roles",
	"teams.scheduleMeeting": "Schedule a team meeting",
	"teams.offerResponsibilities": "Playbook responsibilities",
	"teams.addResponsibility": "Add a responsibility",
	"teams.editResponsibility": "Update a responsibility",
	"teams.completeResponsibility": "Tick a responsibility",
	"teams.deleteResponsibility": "Remove a responsibility",
	"teams.createProgram": "Add a training program",
	"teams.correctProgram": "Correct a training program",
	"teams.setRequiredTrainingParticipants": "Set required training",
	"teams.attestCompletion": "Record a training completion",
	"teams.revokeCompletion": "Revoke a training completion",
	"teams.recompleteTraining": "Record training again",
} as const;
type TeamsOperation = keyof typeof TEAMS_TITLE;
export const isTeams = (operation: Operation): operation is TeamsOperation => operation in TEAMS_TITLE;

export type SettingsOperation =
	| "seats.invite"
	| "seats.resendInvitation"
	| "seats.revokeInvitation"
	| "seats.changeOrdinaryRole"
	| "seats.remove"
	| "plant.updateProfile"
	| "plant.setTimezone"
	| "church.digestSchedule.set"
	| "privacy.setSharing"
	| "associations.invite"
	| "associations.end"
	| "account.finalizeAvatar"
	| "account.requestDeletion"
	| "organizations.updateProfile"
	| OnboardingOperation;
export type OnboardingOperation =
	| "onboarding.declareJourney"
	| "identity.answerLeadOnboarding"
	| "onboarding.complete"
	| "onboarding.createPlant"
	| "discovery.create"
	| "discovery.convertToPlant";
export type OrganizationOperation =
	| "people.addToHousehold"
	| "people.createHouseholdWithHead"
	| "people.updateHousehold"
	| "people.deleteHousehold"
	| "people.removeFromHousehold"
	| "people.setHouseholdRole"
	| "people.propagateAddress"
	| "people.createTag"
	| "people.updateTag"
	| "people.deleteTag"
	| "people.assignTag"
	| "people.removeTag"
	| "people.addSkill"
	| "people.updateSkill"
	| "people.removeSkill"
	| "people.addNote"
	| "people.editNote"
	| "people.deleteNote"
	| "people.executeBulkImport";

export type Change = { field: string; before: unknown; after: unknown };
export type ReviewedPerson = { id: string; label: string; changes: Change[]; unchanged?: string };
export type ReviewedRow = {
	row: number;
	outcome: "create" | "create_and_review" | "skip" | "fail";
	label: string | null;
	reason: string | null;
};
export type PersonOutcome = { id: string; label: string; outcome: "changed" | "unchanged"; reason?: string };
export type ImportOutcome = {
	status: "in_progress" | "complete" | "partial";
	counts: { created: number; skipped: number; failed: number; remaining: number };
	failed: { row: number; reason: string }[];
};

export type Review = {
	id: string;
	conversationId: string;
	operation: Operation;
	revision: number;
	digest: string;
	expiresAt: string;
	approvedAt: string | null;
	status: "pending" | "approved" | "cancelled" | "expired";
	review: {
		target: {
			kind:
				| "person"
				| "message"
				| "task"
				| "team"
				| "role"
				| "training"
				| "responsibility"
				| "household"
				| "tag"
				| "meeting"
				| "venue"
				| "church"
				| "plant"
				| "seat"
				| "invitation"
				| "connection"
				| "organization"
				| "account"
				| "article"
				| "document"
				| "template"
				| "program";
			id: string;
			label: string;
			articleId?: string;
			href?: string;
		} | null;
		changes: Change[];
		people?: ReviewedPerson[];
		rows?: ReviewedRow[];
		notes?: string[];
		refusal?: string;
		withheld?: true;
	};
	outcome: "completed" | "failed" | "refused" | "unknown" | null;
	executing: boolean;
	receipt: {
		receiptId?: string;
		revision?: string;
		code?: string;
		report?: MailReport;
		people?: PersonOutcome[];
		import?: ImportOutcome;
		current?: { id: string; label: string; value: string | null }[];
	} | null;
	stale: boolean;
	now: string;
};

export type Phase =
	"pending" | "expired" | "cancelled" | "running" | "completed" | "refused" | "unconfirmed" | "withheld";

export const approvalLeft = (review: Review) => Date.parse(review.expiresAt) - Date.parse(review.now);

export function phaseOf(review: Review, lapsed: boolean): Phase {
	if (review.outcome === "completed") return "completed";
	if (review.review.withheld) return "withheld";
	if (review.status === "cancelled") return "cancelled";
	if (review.status === "expired") return "expired";
	if (review.status === "pending") return lapsed ? "expired" : "pending";
	if (review.outcome === "refused") return "refused";
	if (review.outcome === "failed" || review.outcome === "unknown") return "unconfirmed";
	return "running";
}

export const retryable = (review: Review, lapsed: boolean) =>
	(review.outcome === "failed" || review.outcome === "unknown") && !lapsed;

const FIELD_LABEL: Record<string, string> = {
	displayName: "Name",
	pipelineStage: "Stage",
	programKind: "Kind",
	director: "Director",
	expectedLength: "Expected length",
	rhythm: "Meets",
	stages: "Stages",
	milestones: "Milestones",
	actualDate: "Launch Sunday",
	milestone: "Milestone",
	decisions: "Decisions",
	guestAnswer: "Guests not entered by name",
	wentWell: "What went well",
	toChange: "What to change",
	operations: "Operations",
	followUpPlan: "Follow-up plan",
	supportNeeded: "Support needed",
	summary: "Summary",
	addedMilestones: "Milestones added",
	changedMilestones: "Milestones changed",
	removedMilestones: "Milestones removed",
	milestoneOrder: "Milestone order",
	firstName: "First name",
	lastName: "Last name",
	email: "Email",
	phone: "Phone",
	street: "Street",
	city: "City",
	stateProvince: "State or province",
	postalCode: "Postal code",
	country: "Country",
	source: "Source",
	sourceDetails: "Source details",
	summaryNotes: "Notes",
	birthDate: "Birth date",
	stage: "Stage",
	adultClassification: "Age group",
	reason: "Reason",
	photo: "Photo",
	state: "Status",
	occurredOn: "Date",
	...CRITERION_LABEL,
	result: "Result",
	nextSteps: "Next steps",
	...LENS_LABEL,
	total: "Total",
	kind: "Commitment",
	witness: "Witness",
	cardNotes: "Notes",
	commitment: "Commitment",
	effectiveOn: "From",
	cardVoided: "Voided",
	keeps: "Stays",
	mergesIn: "Merges in",
	moves: "Moves over",
	keptDetails: "Kept as is",
	staysWithMergedRecord: "Stays behind",
	comesBack: "Comes back",
	movesBack: "Moves back",
	detailsGoBack: "Details back",
	bookmarked: "Bookmark",
	feedback: "Your feedback",
	household: "Household",
	householdRole: "Role",
	householdAddress: "Address",
	address: "Address",
	name: "Name",
	tag: "Tag",
	createTag: "New tag",
	color: "Color",
	taggedPeople: "People with it",
	skill: "Skill",
	category: "Category",
	proficiency: "Level",
	notes: "Skill notes",
	note: "Note",
	status: "Status",
	title: "Title",
	priority: "Priority",
	due: "Due",
	owners: "Owners",
	recurrence: "Repeats",
	relatedTo: "Related to",
	nextOccurrence: "Next occurrence",
	outcome: "Outcome",
	occurredAt: "When",
	channel: "How",
	contactNote: "Note",
	followUp: "Follow-up",
	description: "Description",
	archived: "Archived",
	leadership: "Leadership role",
	timeCommitment: "Time commitment",
	desiredSkills: "Desired skills",
	retired: "Retired",
	filledBy: "Filled by",
	member: "Member",
	leader: "Leader",
	ministries: "Ministries",
	roles: "Roles",
	date: "Date",
	time: "Time",
	subtype: "Kind",
	offer: "Offer",
	responsibilities: "Responsibilities",
	responsibility: "Responsibility",
	text: "Text",
	done: "Done",
	required: "Required",
	requiredPeople: "Required people",
	person: "Person",
	completedOn: "Completed on",
	completedAgainOn: "Completed again on",
	completion: "Completion",
	phase: "Phase",
	direction: "Direction",
	openCriteria: "Not met yet",
	signal: "Signal",
	value: "Answer",
	asOf: "True as of",
	detail: "In your words",
	reference: "Written down in",
	type: "Type",
	when: "When",
	venue: "Venue",
	held: "Held",
	voided: "Counts",
	meetingNotes: "Notes",
	kitNote: "Note",
	evaluationNotes: "Notes",
	venueNotes: "Notes",
	removed: "Meetings",
	team: "Ministry",
	guests: "Guests",
	agenda: "Agenda",
	kit: "Vision kit",
	guest: "Guest",
	rsvp: "RSVP",
	invitedBy: "Invited by",
	yourRsvp: "Your RSVP",
	newPerson: "New person",
	attendance: "Attendance",
	possibleDuplicates: "Possible duplicates",
	card: "Response card",
	cardNote: "Card note",
	add: "Adds",
	remove: "Removes",
	attended: "Attended",
	noLongerAttended: "No longer attended",
	finalized: "Finalize",
	item: "Kit item",
	checked: "Checked",
	bringer: "Who brings it",
	average: "Average",
	attendanceScore: "Attendance",
	locationScore: "Location",
	logisticsScore: "Logistics",
	agendaScore: "Agenda",
	vibeScore: "Vibe",
	messageScore: "Message",
	closeScore: "Close",
	nextStepsScore: "Next steps",
	capacity: "Capacity",
	costDescription: "Cost",
	active: "Status",
	contactEmail: "Contact email",
	contactPhone: "Contact phone",
	statementOfFaith: "Statement of faith",
	invitation: "Invitation",
	role: "Role",
	access: "Access",
	timeZone: "Time zone",
	digestSchedule: "Church digest",
	connection: "Connection",
	recipientEmail: "Sent to",
	account: "Your login",
	church: "Church",
	whereYouAre: "Where you are",
	launchDate: "Launch date",
	lead: "Lead",
	setup: "Setup",
	discovery: "Discovery",
	yourRole: "Your role",
	page: "Page",
	...SHARING_CATEGORY_LABEL,
	template: "Template",
	templateVersion: "Version",
	notice: "Notice",
	format: "Format",
	version: "Version",
	list: "Leaves",
	documentType: "Type",
};
const KIND_LABEL: Record<string, string> = { core_group: "Core group", launch_team: "Launch team" };
const COMMITMENT_LABEL: Record<string, string> = { active: "Active", withdrawn: "Withdrawn", unknown: "Not recorded" };
function judgmentText(value: object): string | null {
	const v = value as { rating?: unknown; score?: unknown; notes?: unknown };
	const head =
		typeof v.score === "number"
			? `${v.score} of 5`
			: typeof v.rating === "string"
				? (RATING_LABEL[v.rating as Rating] ?? v.rating)
				: null;
	if (!head) return null;
	return typeof v.notes === "string" && v.notes ? `${head} · ${v.notes}` : head;
}
const MEETINGS_LABEL: Record<string, string> = { tasks: "Tasks it creates" };
const LAUNCH_LABEL: Record<string, string> = { guest: "Launch Sunday guest" };
export const fieldLabel = (field: string, operation?: string) =>
	field.startsWith("presence:")
		? field.slice("presence:".length)
		: ((operation?.startsWith("meetings.")
				? MEETINGS_LABEL[field]
				: operation?.startsWith("launch.")
					? LAUNCH_LABEL[field]
					: undefined) ??
			FIELD_LABEL[field] ??
			MERGE_FIELD_LABEL[field as MergeField] ??
			field);

const TEAM_STATE: Record<string, string> = { forming: "Forming", active: "Active", paused: "Paused" };
const DATE_FIELDS = new Set([
	"birthDate",
	"date",
	"completedOn",
	"completedAgainOn",
	"occurredOn",
	"effectiveOn",
	"asOf",
]);

const CAPITALIZED = new Set(["householdRole", "category", "proficiency", "color"]);
const CLASSIFICATION_LABEL: Record<string, string> = { adult: "Adult", child: "Child", unknown: "Not recorded" };
const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const TASK_STATUS: Record<string, string> = {
	not_started: "Not started",
	in_progress: "In progress",
	blocked: "Blocked",
	complete: "Complete",
	no_longer_needed: "No longer needed",
	deleted: "Deleted",
	added: "Added",
	removed: "Removed",
};
const OUTCOME: Record<string, string> = {
	contacted: "Contacted (a conversation happened)",
	attempted_no_contact: "Attempted, no conversation",
	administrative_completion: "Administrative completion",
	no_longer_needed: "No longer needed",
	withdrawn: "Withdrawn",
};
const CHANNEL: Record<string, string> = CHANNEL_LABEL;
const PRIORITY: Record<string, string> = PRIORITY_LABEL;
const CATEGORY: Record<string, string> = CATEGORY_LABEL;
const FREQUENCY: Record<string, string> = {
	daily: "Daily",
	weekly: "Weekly",
	biweekly: "Every two weeks",
	monthly: "Monthly",
	quarterly: "Quarterly",
	yearly: "Yearly",
};
const NONE: Record<string, string> = { owners: "Needs owner", due: "No due date", recurrence: "Doesn't repeat" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function localWhen(value: string): string {
	const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?(?: (\S+))?$/.exec(value);
	if (!m) return value;
	const at = new Date(`${m[1]}T${m[2] ?? "00"}:${m[3] ?? "00"}:00Z`);
	if (Number.isNaN(at.getTime())) return value;
	const date = at.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
	if (!m[2]) return date;
	const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
	const place = m[4]?.split("/").at(-1)?.replaceAll("_", " ");
	return `${date}, ${time}${place ? ` (${place} time)` : ""}`;
}
function repeats(value: string) {
	if (value === "stopped") return "Stops repeating";
	const all = value.split(", ");
	const zone = all.find((p) => p.includes("/"));
	const [rule = "", ...rest] = all.filter((p) => p !== zone);
	const [frequency = "", ...tail] = rule.split(" ");
	const head = [FREQUENCY[frequency] ?? frequency, ...tail].join(" ");
	const text = [head, ...rest.map((p) => p.replace(/^until (\S+)$/, (_, d: string) => `until ${localWhen(d)}`))].join(
		", ",
	);
	return zone ? `${text} (${zone})` : text;
}

const DIRECTION_TEXT: Record<string, string> = {
	forward: "Forward, to the next phase",
	skip_forward: "Forward, skipping a phase",
	backward: "Backward, to an earlier phase",
};
const ANSWER_TEXT: Record<string, string> = { yes: "Yes", not_yet: "Not yet", retracted: "Retracted" };
const named = (value: unknown, name: "name" | "label") =>
	value && typeof value === "object" && name in value ? String((value as Record<string, unknown>)[name]) : null;

export function valueText(field: string, value: unknown): string | null {
	if (value === null || value === undefined || value === "") return NONE[field] ?? null;
	if (field === "phase") return named(value, "name");
	if (field === "signal") return named(value, "label");
	if (field === "direction") return DIRECTION_TEXT[String(value)] ?? String(value);
	if (field === "value") return ANSWER_TEXT[String(value)] ?? String(value);
	if (field === "asOf" && value === "today") return "Today, when you approve";
	if (Array.isArray(value)) return value.length ? value.map(String).join("\n") : null;
	if (field === "photo") return `Photo ${photoRef(value)}`;
	if (typeof value === "boolean" && SHARED.has(field)) return value ? "Shared" : "Not shared";
	const word = WORDS[field]?.[String(value)];
	if (word) return word;
	if (field === "timeZone") return zoneText(String(value));
	if (field === "stage") return STAGE_LABEL[value as StageValue] ?? String(value);
	if (field === "source") return SOURCE_LABEL[value as SourceValue] ?? String(value);
	if (field === "adultClassification") return CLASSIFICATION_LABEL[String(value)] ?? String(value);
	if (field === "state")
		return value === "live"
			? "Current"
			: value === "retired"
				? "Removed"
				: (TEAM_STATE[String(value)] ?? String(value));
	if (field === "bookmarked") return value === true ? "Bookmarked" : "Not bookmarked";
	if (field === "feedback")
		return value === "helpful" ? "Helpful" : value === "unhelpful" ? "Not helpful" : String(value);
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (Array.isArray(value)) return value.map(String).join(", ");
	if (field === "category" && String(value) in CATEGORY) return CATEGORY[String(value)] ?? String(value);
	if (CAPITALIZED.has(field) && typeof value === "string") return value.charAt(0).toUpperCase() + value.slice(1);
	if (DATE_FIELDS.has(field) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
		return dateFormat.format(new Date(`${value}T00:00:00Z`));
	if (field === "status" || field === "followUp") return TASK_STATUS[String(value)] ?? String(value);
	if (field === "outcome") return OUTCOME[String(value)] ?? String(value);
	if (field === "channel") return CHANNEL[String(value)] ?? String(value);
	if (field === "priority") return PRIORITY[String(value)] ?? String(value);
	if ((field === "due" || field === "occurredAt") && typeof value === "string") return localWhen(value);
	if (field === "recurrence" && typeof value === "string") return repeats(value);
	if (field === "relatedTo" && typeof value === "string" && UUID.test(value)) return "A linked record";
	if (field === "result") return RESULT_LABEL[value as InterviewResult] ?? String(value);
	if (field === "kind") return KIND_LABEL[String(value)] ?? String(value);
	if (field === "commitment") return COMMITMENT_LABEL[String(value)] ?? String(value);
	if (typeof value === "object") return judgmentText(value) ?? JSON.stringify(value);
	return String(value);
}

const SHARED = new Set<string>(SHARING_CATEGORIES);
const WORDS: Record<string, Record<string, string>> = {
	role: ROLE_LABEL,
	access: { ...ROLE_LABEL, removed: "Removed" },
	invitation: { pending: "Waiting", sent_again: "Sent again", revoked: "Revoked" },
	connection: {
		connected: "Connected",
		ended: "Ended",
		"sending church": "Asked to be your sending church",
		network: "Asked to connect as your network",
	},
	account: { active: "Active", deletion_requested: "Deletion requested" },
};
const zoneText = (zone: string) => (ZONE_NAME[zone] ? `${ZONE_NAME[zone]} (${zone})` : zone);

export const isSettings = (operation: Operation): operation is SettingsOperation =>
	/^(seats|plant|church|privacy|associations|account|organizations|onboarding|discovery)\./.test(operation) ||
	operation === "identity.answerLeadOnboarding";
export function settingsLink(operation: SettingsOperation): { href: string; label: string } {
	if (operation.startsWith("seats.")) return { href: "/settings/seats", label: "Open Seats" };
	if (operation.startsWith("plant.") || operation.startsWith("church."))
		return { href: "/settings/church", label: "Open Church settings" };
	if (operation.startsWith("account.")) return { href: "/settings/account", label: "Open your account" };
	if (/^(onboarding|discovery)\./.test(operation) || operation === "identity.answerLeadOnboarding")
		return { href: "/onboarding", label: "Open setup" };
	if (operation.startsWith("organizations."))
		return { href: "/settings/organization", label: "Open Organization profile" };
	return { href: "/settings/sharing", label: "Open Sharing" };
}

export const isPhoto = (operation: Operation) =>
	operation === "people.setPersonPhoto" || operation === "account.finalizeAvatar";
export const savedPhotoSrc = (target: { kind: string; id: string }, version: string) =>
	target.kind === "account" ? `/api/accounts/${target.id}/avatar/${version}` : `/people/${target.id}/photo/${version}`;

const ITEM_FIELD: Partial<Record<Operation, string>> = {
	"tasks.bulkComplete": "status",
	"tasks.bulkReschedule": "due",
	"tasks.createSubtask": "status",
	"tasks.setSubtaskCompletion": "status",
	"tasks.removeSubtask": "status",
	"tasks.assignFollowUp": "owners",
};
export const itemField = (operation: Operation) => ITEM_FIELD[operation] ?? null;
const CREATES = new Set<Operation>([
	"people.createPerson",
	"tasks.create",
	"tasks.createFollowUp",
	"followups.recordOutcome",
]);
const NO_BEFORE = new Set(["reason", "contactNote", "nextOccurrence"]);
export const showsBefore = (review: Pick<Review, "operation">, change: Change) =>
	!afterOnly(review, change.field) &&
	!NO_BEFORE.has(change.field) &&
	!(
		(isMeetings(review.operation) ||
			isLaunch(review.operation) ||
			review.operation === "development.draftNextVersion") &&
		(change.before === null || change.before === undefined)
	) &&
	!(isDocument(review.operation) && change.before === null) &&
	!(
		isIntelligence(review.operation) &&
		(change.before === null || JSON.stringify(change.before) === JSON.stringify(change.after))
	) &&
	(change.before !== null && change.before !== undefined
		? true
		: !CREATES.has(review.operation) && !itemField(review.operation));

export const isTasks = (operation: Operation) => operation.startsWith("tasks.") || operation.startsWith("followups.");

export function subjectName(review: Review): string {
	const { target, changes } = review.review;
	if (target) return target.label;
	if (review.operation === "tasks.create") return String(changes.find((c) => c.field === "title")?.after ?? "New task");
	const n = changes.length;
	if (review.operation === "tasks.assignFollowUp")
		return `${n.toLocaleString()} ${n === 1 ? "follow-up" : "follow-ups"}`;
	return `${n.toLocaleString()} ${n === 1 ? "task" : "tasks"}`;
}

export function savedText(review: Review): string {
	const who = review.review.target?.label;
	if (!isTasks(review.operation)) return who ? `Saved. ${who} is updated.` : "Saved.";
	const name = subjectName(review);
	const status = review.review.changes.find((c) => c.field === "status")?.after;
	switch (review.operation) {
		case "tasks.create":
			return `Saved. ${name} is in Tasks.`;
		case "tasks.complete":
		case "tasks.completeOccurrence":
			return `Saved. ${name} is complete.`;
		case "tasks.reopen":
		case "tasks.reopenObligation":
			return `Saved. ${name} is open again.`;
		case "tasks.waive":
			return `Saved. ${name} is closed as no longer needed.`;
		case "tasks.changeStatus":
			return `Saved. ${name} is now ${(valueText("status", status) ?? "updated").toLowerCase()}.`;
		case "tasks.delete":
			return `Saved. ${name} is deleted.`;
		case "tasks.bulkComplete":
			return `Saved. ${name} ${review.review.changes.length === 1 ? "is" : "are"} complete.`;
		case "tasks.bulkReschedule":
			return `Saved. ${name} ${review.review.changes.length === 1 ? "has" : "have"} a new due date.`;
		case "tasks.createSubtask":
		case "tasks.setSubtaskCompletion":
		case "tasks.removeSubtask":
			return `Saved. The checklist of ${name} is updated.`;
		case "tasks.configureRecurrence":
			return `Saved. The schedule of ${name} is updated.`;
		case "tasks.createFollowUp":
			return `Saved. ${name} has a new follow-up.`;
		case "tasks.assignFollowUp":
			return "Saved. The follow-up owners are updated.";
		case "followups.recordOutcome":
			return `Saved. The contact with ${name} is logged.`;
		case "followups.correctOutcome":
			return `Saved. The contact log of ${name} is corrected.`;
		default:
			return `Saved. ${name} is updated.`;
	}
}

export function openAfter(review: Review): { href: string; label: string } | null {
	const who = review.review.target;
	if (review.review.withheld || isMail(review.operation)) return null;
	if (!isTasks(review.operation))
		return who?.kind === "person" && review.operation !== "people.deletePerson"
			? { href: targetHref(who), label: `Open ${who.label}` }
			: null;
	if (who?.kind === "person") return { href: `/people/${who.id}`, label: `Open ${who.label}` };
	if (review.operation === "tasks.delete") return { href: "/tasks", label: "Open Tasks" };
	return who?.kind === "task"
		? { href: `/tasks?task=${who.id}`, label: "Open task" }
		: { href: "/tasks", label: "Open Tasks" };
}

export const approvable = (review: Pick<Review, "operation">, uploadShown: boolean) =>
	!isPhoto(review.operation) || uploadShown;

export function emptyText(field: string, after: boolean) {
	if (field === "photo") return "No photo";
	if (field === "feedback") return "No vote";
	if (field === "household" || field === "householdRole") return "None";
	if (after && ["note", "skill", "category", "proficiency", "tag", "removedMilestones"].includes(field))
		return "Removed";
	return "Empty";
}

export const photoRef = (value: unknown) => String(value).slice(0, 8).toUpperCase();

const handedBack = (changes: readonly Change[]) =>
	Number(changes.find((c) => c.field === "openTasksNeedingOwner")?.after ?? 0);

export const shownChanges = (review: Pick<Review, "operation" | "review">) =>
	review.review.changes.filter(
		(c) =>
			c.field !== "openTasksNeedingOwner" &&
			c.field !== "createTag" &&
			!(c.field === "tag" && (review.operation === "people.assignTag" || review.operation === "people.removeTag")),
	);

const TITLE: Record<Operation, string> = {
	...TEAMS_TITLE,
	"communication.saveDraft": "Save an email draft",
	"communication.scheduleReviewed": "Schedule an email",
	"communication.rescheduleReviewed": "Change the send time",
	"communication.cancelScheduledReviewed": "Cancel a scheduled email",
	"communication.replaceScheduledReviewed": "Replace a scheduled email",
	"communication.sendReviewed": "Send an email",
	"communication.executeResend": "Resend an email",
	"communication.retryProvenFailed": "Retry a failed email",
	"communication.deleteDraft": "Delete an email draft",
	"communication.templates.create": "Save an email template",
	"communication.templates.fork": "Copy a system template",
	"communication.templates.update": "Change an email template",
	"people.createPerson": "Add a person",
	"people.updatePerson": "Update a person",
	"people.changeStatus": "Change a stage",
	"people.deletePerson": "Remove a person",
	"people.setPersonPhoto": "Set a photo",
	"people.removePersonPhoto": "Remove a photo",
	"tasks.create": "Create a task",
	"tasks.configureRecurrence": "Repeat a task",
	"tasks.edit": "Edit a task",
	"tasks.complete": "Complete a task",
	"tasks.completeOccurrence": "Complete this occurrence",
	"tasks.reopen": "Reopen a task",
	"tasks.changeStatus": "Change a task's status",
	"tasks.waive": "Close as no longer needed",
	"tasks.delete": "Delete a task",
	"tasks.bulkComplete": "Complete tasks",
	"tasks.bulkReschedule": "Reschedule tasks",
	"tasks.createSubtask": "Update a checklist",
	"tasks.setSubtaskCompletion": "Update a checklist",
	"tasks.removeSubtask": "Update a checklist",
	"tasks.createFollowUp": "Add a follow-up",
	"tasks.assignFollowUp": "Assign follow-ups",
	"tasks.reopenObligation": "Reopen a follow-up",
	"followups.recordOutcome": "Log a contact",
	"followups.correctOutcome": "Correct a contact log entry",
	"people.createInterview": "Record an interview",
	"people.createAssessment": "Record a 4 C's assessment",
	"people.createCommitment": "Record a commitment",
	"people.withdrawCommitment": "Withdraw a commitment",
	"people.reactivateCommitment": "Reactivate a commitment",
	"people.correctCommitmentLifecycle": "Correct a commitment card",
	"people.correctPersonRecord": "Correct a record",
	"people.mergePeople": "Merge two people",
	"people.unmergePeople": "Undo a merge",
	"wiki.bookmarks.set": "Bookmark an article",
	"wiki.feedback.setMine": "Rate an article",
	"seats.invite": "Invite someone",
	"seats.resendInvitation": "Resend an invitation",
	"seats.revokeInvitation": "Revoke an invitation",
	"seats.changeOrdinaryRole": "Change a role",
	"seats.remove": "Remove a seat",
	"plant.updateProfile": "Update the church profile",
	"plant.setTimezone": "Change the church time zone",
	"church.digestSchedule.set": "Change the church digest schedule",
	"privacy.setSharing": "Change what you share",
	"associations.invite": "Ask to connect",
	"associations.end": "End a connection",
	"account.finalizeAvatar": "Change your photo",
	"account.requestDeletion": "Delete your login",
	"organizations.updateProfile": "Update the organization profile",
	"pipeline.proposeStageMove": "Move to another stage",
	"development.saveProgram": "Create a program",
	"launch.schedule": "Set Launch Sunday",
	"launch.postpone": "Postpone the launch",
	"launch.recordOutcome": "Record Launch Sunday",
	"launch.submitDebrief": "Submit the Launch debrief",
	"launch.publishDebriefSummary": "Publish the Launch summary",
	"launch.completeMilestone": "Complete a launch milestone",
	"launch.reopenMilestone": "Reopen a launch milestone",
	"launch.addGuestAttendance": "Name a Launch Sunday guest",
	"launch.correctOutcome": "Correct Launch Sunday",
	"development.draftNextVersion": "Draft the next version",
	"onboarding.declareJourney": "Where your church is",
	"identity.answerLeadOnboarding": "Who leads your church",
	"onboarding.complete": "Finish setup",
	"onboarding.createPlant": "Start a church",
	"discovery.create": "Start a Discovery space",
	"discovery.convertToPlant": "Turn Discovery into a church",
	"documents.createFromTemplate": "New Church Document from a template",
	"documents.exportNative": "Save a file of this document",
	"documents.archive": "Archive a document",
	"documents.designateCoreValues": "Mark as your core values",
	"notifications.markSelectedRead": "Mark notifications read",
	"notifications.markAllVisibleRead": "Mark all notifications read",
	"notifications.setPreferences": "Change notification settings",
	"notifications.digestCadence.set": "Change how often your digest comes",
	"notifications.oversightDigestCadence.set": "Change how often your oversight digest comes",
	"phases.declare": "Record the starting phase",
	"phases.transition": "Move the phase",
	"signals.attest": "Record a signal",
	"signals.correct": "Correct a signal",
	"signals.reaffirm": "Reaffirm a signal",
	"people.addToHousehold": "Add to a household",
	"people.createHouseholdWithHead": "Create a household",
	"people.updateHousehold": "Update a household",
	"people.deleteHousehold": "Delete a household",
	"people.removeFromHousehold": "Take out of a household",
	"people.setHouseholdRole": "Change a household role",
	"people.propagateAddress": "Update a household's address",
	"people.createTag": "Create a tag",
	"people.updateTag": "Update a tag",
	"people.deleteTag": "Delete a tag",
	"people.assignTag": "Tag people",
	"people.removeTag": "Take a tag off people",
	"people.addSkill": "Add a skill",
	"people.updateSkill": "Update a skill",
	"people.removeSkill": "Remove a skill",
	"people.addNote": "Add a note",
	"people.editNote": "Edit a note",
	"people.deleteNote": "Delete a note",
	"people.executeBulkImport": "Import people",
	"meetings.schedule": "Schedule a meeting",
	"meetings.edit": "Change a meeting",
	"meetings.changeStatus": "Change a meeting's status",
	"meetings.delete": "Delete a meeting",
	"meetings.completePractice": "Record a practice as held",
	"meetings.correctPracticeOccurrence": "Correct a practice",
	"meetings.correctOccurrence": "Correct whether it counts",
	"meetings.replaceAgenda": "Replace the agenda",
	"meetings.populateKit": "Add the Vision kit",
	"meetings.updateKitItem": "Update a kit item",
	"meetings.inviteGuest": "Add a guest",
	"meetings.removeGuest": "Remove a guest",
	"meetings.setInviter": "Set who invited a guest",
	"meetings.correctRsvp": "Correct an RSVP",
	"meetings.saveOwnRsvp": "Save your RSVP",
	"meetings.createGuestContact": "Add a new guest",
	"meetings.createWalkInContact": "Add a walk-in",
	"meetings.recordCard": "Record a response card",
	"meetings.clearCard": "Clear a response card",
	"meetings.copyTeamRoster": "Update guests from the ministry",
	"meetings.setAttendance": "Mark attendance",
	"meetings.checkIn": "Check someone in",
	"meetings.clearAttendance": "Clear attendance",
	"meetings.captureAttendanceBatch": "Mark attendance",
	"meetings.finalizeAttendance": "Finalize attendance",
	"meetings.reconcileAttendance": "Correct attendance",
	"meetings.recordEvaluation": "Record your evaluation",
	"meetings.correctEvaluation": "Correct your evaluation",
	"meetings.addAttendeeNote": "Add an attendee note",
	"venues.create": "Save a venue",
	"venues.edit": "Change a venue",
	"venues.correct": "Correct a venue",
	"venues.archive": "Archive a venue",
	"venues.restore": "Restore a venue",
};
export const operationTitle = (operation: Operation) => TITLE[operation];

const MERGE_FACTS = new Set([
	"keeps",
	"keptDetails",
	"mergesIn",
	"moves",
	"staysWithMergedRecord",
	"comesBack",
	"movesBack",
	"detailsGoBack",
]);
export const afterOnly = (review: Pick<Review, "operation">, field: string) =>
	field === "reason" || MERGE_FACTS.has(field) || (ADDS.has(review.operation) && field !== "stage");
export const isIntelligence = (operation: Operation) => /^(phases|signals)\./.test(operation);
export const intelligencePage = (operation: Operation) =>
	operation.startsWith("phases.")
		? { href: "/intelligence", label: "Open the phase journey" }
		: { href: "/intelligence/attestations", label: "Open attestations" };
export const openCriteria = (review: Review) => {
	const value = review.review.changes.find((c) => c.field === "openCriteria")?.after;
	return Array.isArray(value) ? (value as { label: string; status: string }[]) : null;
};

export const isMail = (operation: Operation) => operation.startsWith("communication.");
export const isWiki = (operation: Operation) => operation.startsWith("wiki.");
export const targetHref = (target: NonNullable<Review["review"]["target"]>) => target.href ?? `/people/${target.id}`;
export const isMeetings = (operation: Operation) =>
	operation.startsWith("meetings.") || operation.startsWith("venues.");
type SendTime = { at: string; zone: string };
const asTime = (value: unknown): SendTime | null =>
	value && typeof value === "object" && "at" in value && "zone" in value ? (value as SendTime) : null;
export const sendTimeOf = (review: Review, side: "before" | "after") =>
	asTime(review.review.changes.find((c) => c.field === "sendAt")?.[side]);
const part = (at: string, zone: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone }).format(new Date(at));
const zoneName = (at: string, zone: string, timeZoneName: "short" | "long") =>
	new Intl.DateTimeFormat("en-US", { timeZoneName, timeZone: zone })
		.formatToParts(new Date(at))
		.find((p) => p.type === "timeZoneName")?.value ?? zone;
const sendTime = ({ at, zone }: SendTime) =>
	`${part(at, zone, { weekday: "short" })}, ${part(at, zone, { hour: "numeric", minute: "2-digit" })} ${zoneName(at, zone, "short")}`;
export const sendTimeShort = ({ at, zone }: SendTime) =>
	`${part(at, zone, { weekday: "short", month: "short", day: "numeric" })}, ${part(at, zone, { hour: "numeric", minute: "2-digit" })} ${zoneName(at, zone, "short")}`;
export const sendTimeFull = ({ at, zone }: SendTime) =>
	`${sendTimeShort({ at, zone })} (${zoneName(at, zone, "long")})`;
export const reportTime = (at: string, review: Review) => {
	const zone = sendTimeOf(review, "after")?.zone;
	return zone ? sendTime({ at, zone }) : null;
};

function localTime({ at, zone }: SendTime) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		})
			.formatToParts(new Date(at))
			.map((x) => [x.type, x.value]),
	);
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const GROUP_LABEL: Record<string, string> = {
	all: "Everyone",
	core_group: "Core group",
	launch_team: "Launch team",
	leaders: "Leaders",
	prospects: "Prospects",
};
type AudienceValue = {
	groups: string[];
	teamIds: string[];
	personIds: string[];
	recipients: number;
	noAddress: number;
};
const audienceOf = (value: unknown): AudienceValue | null =>
	value && typeof value === "object" && "recipients" in value ? (value as AudienceValue) : null;
function audienceArgs(value: unknown) {
	const a = audienceOf(value);
	return a && { groups: a.groups, teamIds: a.teamIds, personIds: a.personIds };
}
export function audienceText(value: unknown) {
	const a = audienceOf(value);
	if (!a) return null;
	const who = [
		...a.groups.map((g) => GROUP_LABEL[g] ?? g),
		...(a.teamIds.length ? [`${a.teamIds.length} ${a.teamIds.length === 1 ? "team" : "teams"}`] : []),
		...(a.personIds.length ? [`${a.personIds.length} ${a.personIds.length === 1 ? "person" : "people"}`] : []),
	].join(", ");
	const count = `${a.recipients} with an email address`;
	return [who || "Nobody chosen", count, a.noAddress ? `${a.noAddress} with no email address` : null]
		.filter(Boolean)
		.join(" · ");
}
export const LEFT_OUT_REASON: Record<string, string> = {
	no_address: "No email address",
	blocked: "Blocked after a bounce",
	unsubscribed: "Unsubscribed",
	duplicate_address: "Same address as someone who gets it",
	cannot_be_emailed: "Can't be emailed now",
	still_checking: "Result still being checked",
	opened: "Opened it",
	not_delivered: "Delivery not confirmed",
	too_soon: "Sent less than 24 hours ago",
	delivered: "Already delivered",
	sent: "Sent, delivery not confirmed yet",
	checking: "Result still being checked",
	waiting: "Still waiting to send",
	cancelled: "Cancelled",
};

export const checkable = (review: Review) =>
	review.outcome === "completed" && review.receipt?.report?.confirmation === "not_confirmed";

const MAIL_PENDING: Record<string, string> = {
	"communication.saveDraft": "Review before saving",
	"communication.scheduleReviewed": "Review before scheduling",
	"communication.rescheduleReviewed": "Review the new time",
	"communication.cancelScheduledReviewed": "Review before cancelling",
	"communication.replaceScheduledReviewed": "Review the replacement",
	"communication.sendReviewed": "Review before sending",
	"communication.executeResend": "Review the resend",
	"communication.retryProvenFailed": "Review the retry",
	"communication.deleteDraft": "Review before deleting",
	"communication.templates.create": "Review the new template",
	"communication.templates.fork": "Review the copy",
	"communication.templates.update": "Review the template change",
};
const MAIL_REFUSED: Record<string, string> = {
	"communication.scheduleReviewed": "Can't schedule this email",
	"communication.rescheduleReviewed": "Can't move this email",
	"communication.replaceScheduledReviewed": "Can't replace this email",
	"communication.sendReviewed": "Can't send this email",
	"communication.templates.update": "Can't edit this template",
};
export const MAIL_DISMISSED: Partial<Record<Operation, string>> = {
	"communication.saveDraft": "You closed this review. Nothing was saved.",
	"communication.scheduleReviewed": "You closed this review. The draft stays saved and is not scheduled.",
	"communication.rescheduleReviewed": "You closed this review. The message still sends at its set time.",
	"communication.cancelScheduledReviewed": "You closed this review. The message still sends at its set time.",
	"communication.replaceScheduledReviewed":
		"You closed this review. The message still sends as it was, at its set time.",
	"communication.sendReviewed": "You closed this review. Nothing was sent or saved.",
	"communication.executeResend": "You closed this review. Nothing was resent.",
	"communication.retryProvenFailed": "You closed this review. Nothing was sent again.",
	"communication.deleteDraft": "You closed this review. The draft stays saved.",
	"communication.templates.create": "You closed this review. No template was saved.",
	"communication.templates.fork": "You closed this review. No copy was made.",
	"communication.templates.update": "You closed this review. The template stays as it was.",
};
const LOCAL_ONLY = new Set<Operation>([
	"communication.saveDraft",
	"communication.deleteDraft",
	"communication.templates.create",
	"communication.templates.fork",
	"communication.templates.update",
]);
export function mailHead(
	review: Review,
	phase: string,
): { title: string; tone: "amber" | "green" | "magenta" | "gray" } | null {
	if (!isMail(review.operation)) return null;
	if (phase === "pending")
		return {
			title: review.stale
				? "Message changed"
				: review.review.refusal
					? (MAIL_REFUSED[review.operation] ?? "Can't do this")
					: MAIL_PENDING[review.operation]!,
			tone: "amber",
		};
	if (phase === "running")
		return {
			title: !LOCAL_ONLY.has(review.operation)
				? "Working with the email service…"
				: review.operation === "communication.deleteDraft"
					? "Deleting…"
					: "Saving…",
			tone: "amber",
		};
	if (phase === "refused") return { title: "Refused", tone: "magenta" };
	if (phase === "cancelled") return { title: "Review closed", tone: "gray" };
	if (phase !== "completed") return null;
	const report = review.receipt?.report;
	if (!report)
		return {
			title:
				review.operation === "communication.deleteDraft"
					? "Draft deleted"
					: review.operation.startsWith("communication.templates.")
						? "Template saved"
						: "Saved",
			tone: "green",
		};
	switch (report.kind) {
		case "schedule":
			if (report.confirmation === "confirmed")
				return { title: `Scheduled for ${reportTime(report.scheduledAt, review)}`, tone: "green" };
			return report.confirmation === "refused"
				? { title: "Not scheduled", tone: "magenta" }
				: { title: "Schedule not confirmed", tone: "amber" };
		case "reschedule":
			if (report.confirmation === "confirmed")
				return { title: `Moved to ${reportTime(report.scheduledAt, review)}`, tone: "green" };
			if (report.confirmation === "not_confirmed") return { title: "Time change not confirmed", tone: "amber" };
			return report.sent
				? { title: "Not moved: already sent", tone: "magenta" }
				: { title: "Nothing to move", tone: "gray" };
		case "cancel":
			if (report.confirmation === "not_confirmed") return { title: "Cancel not confirmed", tone: "amber" };
			if (report.cancelled) return { title: report.sent ? "Cancelled, some already sent" : "Cancelled", tone: "green" };
			return report.sent
				? { title: "Not cancelled: already sent", tone: "magenta" }
				: { title: "Nothing to cancel", tone: "gray" };
		case "replace":
			return report.confirmation === "confirmed"
				? { title: `Replacement scheduled for ${reportTime(report.scheduledAt, review)}`, tone: "green" }
				: { title: "Replacement not confirmed", tone: "amber" };
		case "send":
			if (report.confirmation === "confirmed") return { title: "Sent", tone: "green" };
			return report.confirmation === "not_confirmed"
				? { title: "Send not confirmed", tone: "amber" }
				: { title: "Not sent", tone: "magenta" };
		case "replace_stopped":
			return report.confirmation === "not_confirmed"
				? { title: "Not replaced: cancel not confirmed", tone: "amber" }
				: { title: "Not replaced", tone: "magenta" };
	}
}

export const RECIPIENT_OUTCOME: Record<RecipientOutcome, string> = {
	cancelled: "Cancelled",
	sent: "Already sent",
	open: "Cancel not confirmed",
};

export const isDocument = (operation: Operation) => operation.startsWith("documents.");

const DOCUMENT_CONSEQUENCE: Partial<Record<Operation, string>> = {
	"documents.createFromTemplate":
		"The new document opens in Church Documents for your church to edit. A template is starting text, not legal advice.",
	"documents.exportNative": "The file is saved with the document in Church Documents, where it downloads.",
	"documents.archive": "It leaves its list and stays readable. Nothing is deleted.",
	"documents.designateCoreValues": "Evry marks your own document. It never writes core values for your church.",
};

export function documentResult(review: Review): { href: string; label: string } | null {
	const target = review.review.target;
	if (!target || review.review.withheld) return null;
	switch (review.operation) {
		case "documents.createFromTemplate":
			return review.receipt?.receiptId
				? { href: `/documents/church/${review.receipt.receiptId}`, label: "Open the new document" }
				: null;
		case "documents.exportNative":
			return { href: `/documents/church/${target.id}`, label: "Open in Church Documents" };
		case "documents.archive":
			return review.review.changes.find((c) => c.field === "list")?.after === "Church Documents"
				? { href: "/documents/church/archived", label: "Open archived documents" }
				: { href: "/documents", label: "Open Documents" };
		case "documents.designateCoreValues":
			return { href: `/documents/written/${target.id}`, label: `Open ${target.label}` };
		default:
			return null;
	}
}

export function documentRefusalText(code: string | undefined): string {
	switch (code) {
		case "revision_conflict":
		case "conflict":
			return "This changed after Evry prepared the review, so nothing was saved. Ask Evry to prepare it again.";
		case "access_denied":
			return "Your seat no longer allows this change, so nothing was saved.";
		case "render_failed":
			return "The file could not be made, so nothing was saved. Try again later.";
		default:
			return "Documents refused this change, so nothing was saved.";
	}
}

export function consequence(review: Review): string | null {
	if (isDocument(review.operation)) return DOCUMENT_CONSEQUENCE[review.operation] ?? null;
	if (review.operation === "notifications.markSelectedRead" || review.operation === "notifications.markAllVisibleRead")
		return "Marking read doesn't complete or change any task.";
	const tasks = handedBack(review.review.changes);
	const owner =
		tasks > 0 ? `${tasks.toLocaleString()} open ${tasks === 1 ? "task" : "tasks"} will need a new owner.` : null;
	switch (review.operation) {
		case "people.createAssessment":
		case "people.withdrawCommitment":
		case "people.reactivateCommitment":
		case "people.correctCommitmentLifecycle":
		case "people.correctPersonRecord":
			return "Their stage stays as it is.";
		case "people.mergePeople":
			return "The merged record joins the person who stays. You can undo the merge from People while nothing changes since.";
		case "people.unmergePeople":
			return "Both people are separate again, as they were before the merge.";
	}
	if (review.operation === "meetings.delete") return "It leaves Meetings. Its history stays.";
	if (review.operation === "meetings.finalizeAttendance")
		return "Approving finalizes attendance and creates exactly the tasks listed.";
	if (review.operation === "people.deletePerson")
		return ["They leave the current people list. Their history stays.", owner].filter(Boolean).join(" ");
	const direction = review.review.changes.find((c) => c.field === "direction")?.after;
	if (direction === "backward") return "This is a move backward. The phase journey keeps every earlier move.";
	if (review.operation === "phases.transition")
		return "You decide when the church moves. The exit criteria are advisory.";
	const created = review.review.changes.find((c) => c.field === "createTag")?.after;
	if (created) return `The tag ${String(created)} will be created.`;
	switch (review.operation) {
		case "people.updateHousehold":
			return "Members keep their own addresses.";
		case "people.removeFromHousehold":
			return "They keep their own address.";
		case "people.propagateAddress":
			return "Everyone listed gets the household's address. If anyone's record changes before you approve, nothing is changed for anyone.";
		case "people.deleteTag":
			return "It comes off everyone who has it. Their history keeps it.";
		case "people.executeBulkImport":
			return importSummary(review.review.rows ?? []);
	}
	return owner;
}

export function importSummary(rows: readonly ReviewedRow[]) {
	const n = (outcome: ReviewedRow["outcome"][]) => rows.filter((r) => outcome.includes(r.outcome)).length;
	const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
	const add = n(["create", "create_and_review"]);
	return [
		`${plural(add, "person", "people")} will be added`,
		n(["skip"]) ? `${plural(n(["skip"]), "row", "rows")} skipped` : null,
		n(["fail"]) ? `${plural(n(["fail"]), "row fails", "rows fail")}` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

export const ROW_OUTCOME: Record<ReviewedRow["outcome"], string> = {
	create: "Add",
	create_and_review: "Add, review later",
	skip: "Skip",
	fail: "Fails",
};

export function peopleResult(review: Review): string | null {
	const people = review.receipt?.people;
	if (!people?.length) return null;
	const changed = people.filter((p) => p.outcome === "changed").length;
	if (changed === people.length) return people.length === 1 ? "Saved" : `Saved for all ${people.length}`;
	return `${changed} of ${people.length} changed`;
}

export type FieldKind = "text" | "long" | "date" | "email" | "choice";
const KIND: Record<string, FieldKind> = {
	summaryNotes: "long",
	sourceDetails: "long",
	reason: "long",
	birthDate: "date",
	asOf: "date",
	detail: "long",
	email: "email",
	stage: "choice",
	source: "choice",
	adultClassification: "choice",
};
export const fieldKind = (field: string): FieldKind => KIND[field] ?? "text";

export const CHOICES: Record<string, { value: string; label: string }[]> = {
	stage: Object.entries(STAGE_LABEL).map(([value, label]) => ({ value, label })),
	source: Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })),
	adultClassification: Object.entries(CLASSIFICATION_LABEL).map(([value, label]) => ({ value, label })),
};

const FIXED = new Set([
	"photo",
	"state",
	"openTasksNeedingOwner",
	"phase",
	"direction",
	"openCriteria",
	"signal",
	"value",
]);
const REQUIRED = new Set(["displayName", "reason", "stage", "source", "adultClassification", "asOf", "detail"]);
export const isRequired = (field: string, birthDate = false) =>
	field === "adultClassification" ? !birthDate : REQUIRED.has(field);

export function hasBirthDate(review: Review, edits: Record<string, string>) {
	const c = review.review.changes.find((x) => x.field === "birthDate");
	if (!c) return false;
	return c.field in edits ? (edits[c.field] ?? "").trim() !== "" : Boolean(c.after);
}

const ADDS = new Set<Operation>([
	"people.createPerson",
	"people.addNote",
	"people.addSkill",
	"people.createTag",
	"people.createInterview",
	"people.createAssessment",
	"people.createCommitment",
	"seats.invite",
	"associations.invite",
	"onboarding.createPlant",
	"discovery.create",
	"discovery.convertToPlant",
	"development.saveProgram",
]);
export const seatsAccount = (operation: Operation) =>
	operation === "onboarding.createPlant" || operation === "discovery.convertToPlant";

type CarryOver = {
	organizationId: string;
	organization: string;
	kind: string;
	carries: boolean;
	share: string[];
};
export function carryOver(c: Change): CarryOver | null {
	if (!c.field.startsWith("link:")) return null;
	const before = (c.before ?? {}) as { organization?: string; kind?: string };
	const after = (c.after ?? {}) as { carries?: boolean; share?: string[] };
	return {
		organizationId: c.field.slice("link:".length),
		organization: before.organization ?? "Organization",
		kind: before.kind ?? "",
		carries: after.carries === true,
		share: after.share ?? [],
	};
}
export function carryOverText(link: Pick<CarryOver, "carries" | "share">) {
	if (!link.carries) return "Doesn't carry over. The link ends.";
	const shares = SHARING_CATEGORIES.filter((k) => link.share.includes(k)).map((k) => SHARING_CATEGORY_LABEL[k]);
	return shares.length ? `Carries over, sharing ${shares.join(", ")}` : "Carries over, sharing nothing yet";
}
export const SHARE_CHOICES = SHARING_CATEGORIES.map((k) => ({ value: k, label: SHARING_CATEGORY_LABEL[k] }));

const REVISABLE = new Set<Operation>([
	"people.createPerson",
	"people.updatePerson",
	"people.changeStatus",
	"people.deletePerson",
	"people.setPersonPhoto",
	"people.removePersonPhoto",
	"discovery.convertToPlant",
	"phases.declare",
	"phases.transition",
	"signals.attest",
	"signals.correct",
	"signals.reaffirm",
]);
export const editableChanges = (review: Review) =>
	review.review.withheld || !REVISABLE.has(review.operation) || review.operation === "signals.reaffirm"
		? []
		: review.review.changes.filter((c) =>
				review.operation === "discovery.convertToPlant" ? carryOver(c) !== null : !FIXED.has(c.field),
			);

export function reviseInput(review: Review, edits: Record<string, string> = {}): unknown {
	if (!REVISABLE.has(review.operation) && !isMail(review.operation)) return null;
	const { target, changes } = review.review;
	const value = (c: Change) => {
		if (!(c.field in edits)) return c.after;
		const text = edits[c.field]!.trim();
		return text === "" ? null : text;
	};
	const after = (field: string) => {
		const c = changes.find((x) => x.field === field);
		return c ? value(c) : undefined;
	};
	if (review.operation === "people.createPerson")
		return Object.fromEntries(changes.map((c) => [c.field, value(c)]).filter(([, v]) => v !== null));
	if (review.operation === "discovery.convertToPlant") {
		const picks = changes.flatMap((c) => {
			const link = carryOver(c);
			if (!link) return [];
			const edited = c.field in edits ? (JSON.parse(edits[c.field]!) as Pick<CarryOver, "carries" | "share">) : link;
			return edited.carries ? [{ organizationId: link.organizationId, share: edited.share }] : [];
		});
		const place = Object.fromEntries(
			(["city", "stateProvince", "country"] as const).flatMap((f) => (after(f) ? [[f, after(f)]] : [])),
		);
		return { name: after("church"), ...place, carryOver: picks };
	}
	if (review.operation === "communication.saveDraft") {
		const audience = audienceArgs(after("audience"));
		return audience ? { subject: after("subject"), body: after("body"), audience } : null;
	}
	const key = (after("signal") as { key?: string } | undefined)?.key;
	const reference = after("reference");
	const signalFacts = () => ({
		key,
		value: after("value"),
		asOf: after("asOf"),
		detail: after("detail"),
		...(typeof reference === "string" ? { reference } : {}),
	});
	switch (review.operation) {
		case "phases.declare":
			return { phase: (after("phase") as { phase: number }).phase };
		case "phases.transition":
			return { toPhase: (after("phase") as { phase: number }).phase, reason: after("reason") };
		case "signals.attest":
			return signalFacts();
		case "signals.correct":
			return after("value") === "retracted" ? { action: "retract", key } : { action: "correct", ...signalFacts() };
		case "signals.reaffirm":
			return { key };
	}
	if (!target) return null;
	const personId = target.id;
	switch (review.operation) {
		case "wiki.bookmarks.set":
			return target.articleId ? { articleId: target.articleId, desired: after("bookmarked") !== false } : null;
		case "wiki.feedback.setMine":
			return target.articleId ? { articleId: target.articleId, vote: after("feedback") } : null;
		case "people.updatePerson":
			return { personId, patch: Object.fromEntries(changes.map((c) => [c.field, value(c)])) };
		case "people.changeStatus":
			return { personId, stage: after("stage"), reason: after("reason") };
		case "people.deletePerson":
			return { personId, reason: after("reason") };
		case "people.setPersonPhoto":
			return { personId, uploadId: after("photo") };
		case "people.removePersonPhoto":
			return { personId };
		case "communication.scheduleReviewed":
		case "communication.rescheduleReviewed": {
			const at = sendTimeOf(review, "after");
			return at ? { communicationId: target.id, sendAt: localTime(at) } : null;
		}
		case "communication.cancelScheduledReviewed":
			return { communicationId: target.id };
		case "communication.replaceScheduledReviewed": {
			const audience = audienceArgs(after("audience"));
			const body = after("body");
			return {
				communicationId: target.id,
				...(typeof body === "string" ? { body } : {}),
				...(audience ? { audience } : {}),
			};
		}
		case "tasks.complete":
		case "tasks.completeOccurrence":
		case "tasks.reopen":
		case "tasks.delete":
			return target.kind === "task" ? { taskId: target.id } : null;
		case "tasks.changeStatus":
			return target.kind === "task" ? { taskId: target.id, status: after("status") } : null;
		case "tasks.waive": {
			const reason = after("reason");
			return target.kind === "task" ? { taskId: target.id, ...(typeof reason === "string" ? { reason } : {}) } : null;
		}
		default:
			return null;
	}
}

export function missingRequired(review: Review, edits: Record<string, string>) {
	const dated = hasBirthDate(review, edits);
	return (
		editableChanges(review).find((c) => isRequired(c.field, dated) && (edits[c.field] ?? "").trim() === "") ?? null
	);
}

export function settingsRefusalText(code: string | undefined): string {
	switch (code) {
		case "revision_conflict":
		case "conflict":
		case "stale_preview":
			return "This changed after Evry prepared the review, so nothing was saved. Ask Evry to prepare it again.";
		case "access_denied":
		case "unavailable":
		case "invitation_unavailable":
			return "Your seat no longer allows this change, or what it changes is gone, so nothing was saved.";
		case "protected_owner":
			return "The Owner's seat can't be changed here, so nothing was saved.";
		case "invitation_cooldown":
			return "An invitation can go again one minute after the last one, so nothing was sent. Ask again in a minute.";
		case "invitation_rate_limited":
		case "invitation_limit":
			return "This address already had 3 invitations in 30 days, so nothing was sent.";
		case "address_blocked":
			return "Email to this address bounced before, so nothing was sent.";
		case "already_active":
			return "You are already connected with this organization, so nothing was sent.";
		case "pending_invitation":
		case "address_pending":
			return "A request to this organization is already waiting, so nothing was sent.";
		case "already_declared":
			return "Where this church is was already declared, so nothing was saved. It can't be changed in setup.";
		case "active_seat_conflict":
			return "Your account already has a church seat, so no church was started.";
		case "association_resolution_required":
			return "You have a Discovery space, so nothing was started. Ask Evry to turn it into a church instead.";
		case "idempotency_conflict":
			return "A different change already used this review, so nothing was saved. Ask Evry to prepare it again.";
		case "manual_owner_exception_required":
			return "You are an Owner, so your church needs another Owner first. Nothing was changed.";
		case "source_unavailable":
			return "Settings are not available right now, so nothing was saved. Try again later.";
		default:
			return "Settings refused this change, so nothing was saved.";
	}
}

export function pipelineRefusalText(
	code: string | undefined,
	operation: PipelineOperation,
	who: string | null,
): string {
	const area = operation === "pipeline.proposeStageMove" ? "The Pipeline" : "Programs";
	switch (code) {
		case "revision_conflict":
			if (operation === "development.draftNextVersion")
				return "The program changed since Evry prepared this, so nothing was saved over it. Open the program to see it as it is now, or ask Evry to prepare it again.";
			return operation === "development.saveProgram"
				? "Programs changed after Evry prepared this, so nothing was created. Ask Evry to prepare it again."
				: `${who ?? "This person"}'s stage changed after Evry prepared this, so the move couldn't be applied and nothing moved. This is where they are now.`;
		case "access_denied":
			return "Your seat no longer allows this change, or what it changes is gone, so nothing was saved.";
		case "invalid_input":
			return `${area} didn't accept these values, so nothing was saved. Ask Evry to prepare it again.`;
		default:
			return `${area} refused this change, so nothing was saved.`;
	}
}

export function launchRefusalText(code: string | undefined): string {
	switch (code) {
		case "stale_review":
			return "This milestone's prep tasks changed after Evry prepared this, so nothing was saved. This is how they are now. Ask Evry to prepare it again.";
		case "revision_conflict":
			return "The Launch plan changed after Evry prepared this, so nothing was saved. This is how it is now. Ask Evry to prepare it again.";
		case "derived_evidence_only":
			return "This milestone follows the submitted debrief. It can't be checked off by hand.";
		case "access_denied":
			return "Your seat no longer allows this change, so nothing was saved.";
		case "source_unavailable":
			return "This server can't send Launch notifications, so nothing was saved. Mark it complete on the Launch plan.";
		default:
			return "The Launch plan refused this change, so nothing was saved.";
	}
}

export function refusalText(code: string | undefined, target: string | null, operation?: Operation): string {
	if (operation && isTasks(operation)) return taskRefusalText(code, target);
	const meetings = !!operation && isMeetings(operation);
	const who = target ?? (meetings ? "This meeting" : "this person");
	if (meetings)
		switch (code) {
			case "revision_conflict":
			case "conflict":
				return `${who} changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.`;
			case "access_denied":
				return "Your seat no longer allows this change, so nothing was saved.";
			case "status_transition":
				return "The meeting's status no longer allows this change, so nothing was saved.";
			case "not_found":
			case "source_unavailable":
				return `${who} is no longer in Meetings, so nothing was saved.`;
			default:
				return "Meetings refused this change, so nothing was saved.";
		}
	switch (code) {
		case "revision_conflict":
		case "conflict":
			return `${who}'s record changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.`;
		case "access_denied":
			return "Your seat no longer allows this change, so nothing was saved.";
		case "invalid_input":
		case "invalid_subject":
		case "unsupported_field":
			return "People did not accept these values, so nothing was saved. Ask Evry to prepare it again.";
		case "not_found":
		case "source_unavailable":
			return `${who} is no longer available, so nothing was saved.`;
		case "merge_blocked":
			return "This merge cannot run now, so nothing was merged. Ask Evry to review it again.";
		case "inverse_conflict":
			return "Something changed since the merge, so it was not undone. Ask Evry to review it again.";
		case "review_stale":
			return "People changed after Evry checked this file, so nothing was imported. Ask Evry to check it again.";
		case "file_changed":
			return "This file changed after Evry checked it, so nothing was imported. Ask Evry to check it again.";
		default:
			return "People refused this change, so nothing was saved.";
	}
}

function taskRefusalText(code: string | undefined, target: string | null): string {
	switch (code) {
		case "revision_conflict":
		case "conflict":
		case "stale":
			return `${target ?? "This"} changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.`;
		case "access_denied":
		case "unauthorized":
			return "Your seat no longer allows this change, so nothing was saved.";
		case "not_assigned":
		case "owner_ineligible":
		case "assignee_ineligible":
			return `${TASK_REFUSAL[code]} Nothing was saved.`;
		case "open_successor":
			return "Another occurrence of this task is open, so nothing was saved.";
		case "protected_source":
			return "A meeting made this task, so it can't be changed this way. Nothing was saved.";
		case "nonexistent_local_time":
		case "ambiguous_local_time":
			return "A clock change makes that time skip or repeat in your church's time zone, so nothing was saved. Ask Evry for another time.";
		case "invalid_input":
			return "Tasks did not accept these values, so nothing was saved. Ask Evry to prepare it again.";
		case "not_found":
		case "source_unavailable":
			return `${target ?? "This task"} is no longer available, so nothing was saved.`;
		default:
			return "Tasks refused this change, so nothing was saved.";
	}
}

export function wikiRefusalText(code: string | undefined): string {
	switch (code) {
		case "revision_conflict":
			return "Your bookmark changed on the Wiki after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.";
		case "access_denied":
			return "You can no longer read this article here, so nothing was saved.";
		default:
			return "The Wiki refused this change, so nothing was saved.";
	}
}

export function intelligenceRefusalText(code: string | undefined): string {
	switch (code) {
		case "revision_conflict":
		case "not_current":
			return "The phase or signal changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.";
		case "already_declared":
			return "This church already has its starting phase, so nothing was saved. Ask Evry to move the phase instead.";
		case "no_change":
			return "The signal already has that answer, so nothing was saved.";
		case "access_denied":
			return "Your seat no longer allows this change, so nothing was saved. Only an Owner or Admin can change it.";
		case "invalid_input":
		case "invalid_reason":
		case "not_reaffirmable":
			return "Everyfield did not accept these values, so nothing was saved. Ask Evry to prepare it again.";
		default:
			return "Everyfield refused this change, so nothing was saved.";
	}
}

export function mailRefusalText(code: string | undefined): string {
	switch (code) {
		case "revision_conflict":
			return "This message changed since the review, so nothing was done and the email service was not asked. Ask Evry to review it again.";
		case "stale_review":
			return "The recipients or the content changed since the review, so nothing was sent to the email service. Ask Evry to review it again.";
		case "schedule_window_exceeded":
			return "Everyfield can hold an email for up to 30 days and can't send in the past. Pick another time.";
		case "access_denied":
			return "Your seat no longer allows email changes, so nothing was done.";
		case "mail_unavailable":
			return "This server cannot reach the email service, so nothing was done.";
		case "not_found":
			return "This message is no longer in Messages, so nothing was done.";
		case "rsvp_needs_meeting":
			return "This email has an RSVP link and no open meeting, so nothing was done.";
		default:
			return "Messages refused this change, so nothing was done.";
	}
}

export function stoppedReason(code: string | undefined): string {
	switch (code) {
		case "stale_review":
			return "The recipients or the content changed since the review.";
		case "schedule_window_exceeded":
			return "The send time is no longer within the next 30 days.";
		case "rsvp_needs_meeting":
			return "This email has an RSVP link, and its meeting is no longer open.";
		case "access_denied":
			return "Your seat no longer allows email changes.";
		case "provider_refused":
			return "The email service refused every recipient.";
		default:
			return "Messages refused the next step.";
	}
}

export function actionNotice(error: ProjectedError | "lost", mail: boolean): string {
	if (error === "lost") return "Not confirmed. Check your connection, then try again.";
	switch (error.code) {
		case "review_changed":
			if (mail) return "This message changed since the review. Nothing was done. Review it again.";
			return "This review changed in another window. Check it again before you approve.";
		case "review_expired":
			return "This review expired before it was approved. Nothing was changed.";
		case "review_closed":
			return "This review is already closed.";
		case "photo_unavailable":
			return "The uploaded photo is no longer available, so nothing was saved.";
		case "not_assigned":
		case "owner_ineligible":
		case "assignee_ineligible":
			return `${TASK_REFUSAL[error.code]} Nothing was changed.`;
		case "invalid_input":
			return "Some values are not valid. Check them, then update the review.";
		case "not_found":
			if (mail) return "This message is no longer waiting to send, so there is nothing to review again.";
		case "access_denied":
			return "Your seat no longer allows this, so Evry can't show the result.";
		default:
			return "This did not go through. Try again.";
	}
}

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const clock = (iso: string) => time.format(new Date(iso));

export const pollDelay = (attempt: number) => [350, 50, 50, 50, 50, 800, 1200][attempt] ?? 2000;

export const isNotification = (operation: Operation) => operation.startsWith("notifications.");

export type ReviewedNotice = { id: string; title: string; category: string; at: string; zone: string };
const isNotice = (value: unknown): value is ReviewedNotice =>
	!!value && typeof value === "object" && "id" in value && "title" in value && "at" in value;
export const reviewedNotices = (review: Review) =>
	review.review.changes.flatMap((c) => (c.field === "notice" && isNotice(c.before) ? [c.before] : []));
export const noticeWhen = ({ at, zone }: ReviewedNotice) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(at));

const NOTICE_CHANNEL: Record<string, string> = { email: "Email", in_app: "In-app" };
export function settingChanges(review: Review) {
	const groups = new Map<string, { channel: string; before: boolean; after: boolean }[]>();
	for (const c of review.review.changes) {
		const [category, channel] = c.field.split(".");
		if (!category || !channel || typeof c.before !== "boolean" || typeof c.after !== "boolean") continue;
		groups.set(category, [
			...(groups.get(category) ?? []),
			{ channel: NOTICE_CHANNEL[channel] ?? channel, before: c.before, after: c.after },
		]);
	}
	return [...groups].map(([category, channels]) => ({ category, channels }));
}

type DigestSlot = { cadence: string; weekday: number; hour: number };
const isSlot = (value: unknown): value is DigestSlot =>
	!!value && typeof value === "object" && "cadence" in value && "weekday" in value && "hour" in value;
const WEEKDAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const hourText = (hour: number) => `${hour % 12 || 12}:00 ${hour < 12 ? "AM" : "PM"}`;
export const digestSchedule = (value: unknown) =>
	isSlot(value)
		? value.cadence === "daily"
			? `Daily at ${hourText(value.hour)}`
			: `Weekly on ${WEEKDAY[value.weekday] ?? "Sundays"} at ${hourText(value.hour)}`
		: null;
