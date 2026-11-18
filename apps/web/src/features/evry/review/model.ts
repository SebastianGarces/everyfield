import type { MailReport, RecipientOutcome } from "@everyfield/contracts/communication";
import { ROLE_LABEL, SHARING_CATEGORIES, SHARING_CATEGORY_LABEL, ZONE_NAME } from "@everyfield/evry/labels";
import { SOURCE_LABEL, STAGE_LABEL, type SourceValue, type StageValue } from "../../people/model.ts";
import type { ProjectedError } from "../conversation/model.ts";

export type Operation =
	| "people.createPerson"
	| "people.updatePerson"
	| "people.changeStatus"
	| "people.deletePerson"
	| "people.setPersonPhoto"
	| "people.removePersonPhoto"
	| OrganizationOperation
	| "communication.saveDraft"
	| "communication.scheduleReviewed"
	| "communication.rescheduleReviewed"
	| "communication.cancelScheduledReviewed"
	| "communication.replaceScheduledReviewed"
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
	| "notifications.markSelectedRead"
	| "notifications.markAllVisibleRead"
	| "notifications.setPreferences"
	| "notifications.digestCadence.set"
	| "notifications.oversightDigestCadence.set"
	| TeamsOperation
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
				| "team"
				| "role"
				| "training"
				| "responsibility"
				| "household"
				| "tag"
				| "meeting"
				| "venue"
				| "church"
				| "seat"
				| "invitation"
				| "connection"
				| "organization"
				| "account"
				| "program";
			id: string;
			label: string;
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
	title: "Title",
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
	type: "Type",
	when: "When",
	venue: "Venue",
	status: "Status",
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
	feedback: "Your feedback",
	yourRole: "Your role",
	page: "Page",
	...SHARING_CATEGORY_LABEL,
};
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
			field);

const TEAM_STATE: Record<string, string> = { forming: "Forming", active: "Active", paused: "Paused" };
const DATE_FIELDS = new Set(["birthDate", "date", "completedOn", "completedAgainOn"]);

const CAPITALIZED = new Set(["householdRole", "category", "proficiency", "color"]);
const CLASSIFICATION_LABEL: Record<string, string> = { adult: "Adult", child: "Child", unknown: "Not recorded" };
const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

export function valueText(field: string, value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
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
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (Array.isArray(value)) return value.map(String).join(", ");
	if (CAPITALIZED.has(field) && typeof value === "string") return value.charAt(0).toUpperCase() + value.slice(1);
	if (DATE_FIELDS.has(field) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
		return dateFormat.format(new Date(`${value}T00:00:00Z`));
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

export const approvable = (review: Pick<Review, "operation">, uploadShown: boolean) =>
	!isPhoto(review.operation) || uploadShown;

export function emptyText(field: string, after: boolean) {
	if (field === "photo") return "No photo";
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
	"people.createPerson": "Add a person",
	"people.updatePerson": "Update a person",
	"people.changeStatus": "Change a stage",
	"people.deletePerson": "Remove a person",
	"people.setPersonPhoto": "Set a photo",
	"people.removePersonPhoto": "Remove a photo",
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
	"notifications.markSelectedRead": "Mark notifications read",
	"notifications.markAllVisibleRead": "Mark all notifications read",
	"notifications.setPreferences": "Change notification settings",
	"notifications.digestCadence.set": "Change how often your digest comes",
	"notifications.oversightDigestCadence.set": "Change how often your oversight digest comes",
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

export const isMail = (operation: Operation) => operation.startsWith("communication.");
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
};

export const checkable = (review: Review) =>
	review.outcome === "completed" && review.receipt?.report?.confirmation === "not_confirmed";

const MAIL_PENDING: Record<string, string> = {
	"communication.saveDraft": "Review before saving",
	"communication.scheduleReviewed": "Review before scheduling",
	"communication.rescheduleReviewed": "Review the new time",
	"communication.cancelScheduledReviewed": "Review before cancelling",
	"communication.replaceScheduledReviewed": "Review the replacement",
};
const MAIL_REFUSED: Record<string, string> = {
	"communication.scheduleReviewed": "Can't schedule this email",
	"communication.rescheduleReviewed": "Can't move this email",
	"communication.replaceScheduledReviewed": "Can't replace this email",
};
export const MAIL_DISMISSED: Partial<Record<Operation, string>> = {
	"communication.saveDraft": "You closed this review. Nothing was saved.",
	"communication.scheduleReviewed": "You closed this review. The draft stays saved and is not scheduled.",
	"communication.rescheduleReviewed": "You closed this review. The message still sends at its set time.",
	"communication.cancelScheduledReviewed": "You closed this review. The message still sends at its set time.",
	"communication.replaceScheduledReviewed":
		"You closed this review. The message still sends as it was, at its set time.",
};
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
			title: review.operation === "communication.saveDraft" ? "Saving…" : "Working with the email service…",
			tone: "amber",
		};
	if (phase === "refused") return { title: "Refused", tone: "magenta" };
	if (phase === "cancelled") return { title: "Review closed", tone: "gray" };
	if (phase !== "completed") return null;
	const report = review.receipt?.report;
	if (!report) return { title: "Saved", tone: "green" };
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

export function consequence(review: Review): string | null {
	if (review.operation === "notifications.markSelectedRead" || review.operation === "notifications.markAllVisibleRead")
		return "Marking read doesn't complete or change any task.";
	const tasks = handedBack(review.review.changes);
	const owner =
		tasks > 0 ? `${tasks.toLocaleString()} open ${tasks === 1 ? "task" : "tasks"} will need a new owner.` : null;
	if (review.operation === "meetings.delete") return "It leaves Meetings. Its history stays.";
	if (review.operation === "meetings.finalizeAttendance")
		return "Approving finalizes attendance and creates exactly the tasks listed.";
	if (review.operation === "people.deletePerson")
		return ["They leave the current people list. Their history stays.", owner].filter(Boolean).join(" ");
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

const FIXED = new Set(["photo", "state", "openTasksNeedingOwner"]);
const REQUIRED = new Set(["displayName", "reason", "stage", "source", "adultClassification"]);
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
	"seats.invite",
	"associations.invite",
	"onboarding.createPlant",
	"discovery.create",
	"discovery.convertToPlant",
	"development.saveProgram",
]);
export const addsOnly = (operation: Operation) => ADDS.has(operation);
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
]);
export const editableChanges = (review: Review) =>
	review.review.withheld || !REVISABLE.has(review.operation)
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
	if (!target) return null;
	const personId = target.id;
	switch (review.operation) {
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

export function refusalText(code: string | undefined, target: string | null, meetings = false): string {
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
		case "review_stale":
			return "People changed after Evry checked this file, so nothing was imported. Ask Evry to check it again.";
		case "file_changed":
			return "This file changed after Evry checked it, so nothing was imported. Ask Evry to check it again.";
		default:
			return "People refused this change, so nothing was saved.";
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
		case "mailing_address_missing":
			return "Sending is held until your church has a mailing address, so nothing was sent. Add it in Church profile.";
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
		case "mailing_address_missing":
			return "Your church has no mailing address in Church profile yet.";
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

const CHANNEL_LABEL: Record<string, string> = { email: "Email", in_app: "In-app" };
export function settingChanges(review: Review) {
	const groups = new Map<string, { channel: string; before: boolean; after: boolean }[]>();
	for (const c of review.review.changes) {
		const [category, channel] = c.field.split(".");
		if (!category || !channel || typeof c.before !== "boolean" || typeof c.after !== "boolean") continue;
		groups.set(category, [
			...(groups.get(category) ?? []),
			{ channel: CHANNEL_LABEL[channel] ?? channel, before: c.before, after: c.after },
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
