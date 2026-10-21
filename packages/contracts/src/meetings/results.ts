import { z } from "zod";
import { instant, localDate, timeZone } from "../common/time.ts";
import { accountId, correlationId, operationId, personId, recordId, revision } from "../common/values.ts";
import {
	agendaSection,
	cardResponse,
	kitCategory,
	meetingId,
	meetingStatus,
	meetingType,
	presence,
	reminderSlot,
	rsvp,
	rsvpSource,
	venueId,
} from "./values.ts";

const issue = z.strictObject({ path: z.string().max(200), problem: z.string().max(200) });
const error = <C extends string, D extends z.ZodRawShape>(
	code: C,
	details: D,
	retry: "never" | "refresh" | "same_request",
) =>
	z.strictObject({ code: z.literal(code), details: z.strictObject(details), correlationId, retry: z.literal(retry) });
const occurrence = z.strictObject({ instant, offsetSeconds: z.int() });
/** Every refusal a meetings operation can return. Missing, foreign and inaccessible records share "unavailable". */
export const meetingsError = z.discriminatedUnion("code", [
	error("invalid_input", { issues: z.array(issue).max(50) }, "never"),
	error("unavailable", {}, "never"),
	error("invalid_subject", {}, "never"),
	error("conflict", {}, "refresh"),
	error("venue_archived", {}, "never"),
	error("wrong_meeting_type", {}, "never"),
	error("status_transition", {}, "never"),
	error("nonexistent_local_time", {}, "never"),
	error("ambiguous_local_time", { choices: z.array(occurrence).min(2).max(2) }, "never"),
	error("token_closed", {}, "never"),
]);
export type MeetingsError = z.infer<typeof meetingsError>;
export type MeetingsReply<T> = { status: "ok"; value: T } | { status: "refused"; error: MeetingsError };

const receipt = { receiptId: operationId, outcome: z.enum(["changed", "noop"]) };
const copiedVenue = z.strictObject({ id: venueId.nullable(), name: z.string(), address: z.string() });
export const meetingSummary = z.strictObject({
	id: meetingId,
	revision,
	type: meetingType,
	status: meetingStatus,
	/** The one title every screen shows: the entered title, or the type with its Vision number. */
	displayTitle: z.string().min(1),
	title: z.string().nullable(),
	startsAt: instant,
	localDate,
	localTime: z.string().regex(/^\d{2}:\d{2}$/),
	zone: timeZone,
	visionNumber: z.int().min(1).nullable(),
	venue: copiedVenue.nullable(),
	guestCount: z.int().min(0),
	confirmedCount: z.int().min(0),
	/** Vision kit readiness; other types have no kit. */
	preparation: z.enum(["complete", "incomplete", "not_applicable"]),
});
export const meetingPage = z.strictObject({
	items: z.array(meetingSummary).max(100),
	page: z.int().min(1),
	total: z.int().min(0),
	next: z.int().min(2).nullable(),
});
export const agendaResult = z.strictObject({
	meetingId,
	revision,
	sections: z.array(agendaSection).max(40),
	totalMinutes: z.int().min(0),
	defaultVersion: z.int().min(1).nullable(),
});
export const meetingDetail = z.strictObject({
	...meetingSummary.shape,
	notes: z.string().nullable(),
	agenda: agendaResult,
	kit: z.strictObject({ version: z.int().min(1), checked: z.int().min(0), total: z.int().min(0) }).nullable(),
	occurrence: z.strictObject({ heldAt: instant.nullable(), voidedAt: instant.nullable() }),
	retiredAt: instant.nullable(),
});
export const meetingResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("available"), meeting: meetingDetail }),
]);
export const meetingMutationResult = z.strictObject({ ...receipt, meeting: meetingDetail });
export const historyResult = z.strictObject({ hasHistory: z.boolean(), types: z.array(meetingType) });
export const completedPractices = z.strictObject({
	meetingIds: z.array(meetingId),
	count: z.int().min(0),
	/** Three distinct held practices meet the Launch criterion; more still meet it. */
	criterion: z.enum(["met", "not_met"]),
});

const personRef = z.strictObject({
	personId,
	displayName: z.string(),
	state: z.enum(["live", "retired", "merged"]),
});
export const guest = z.strictObject({
	id: recordId,
	revision,
	person: personRef,
	inviter: personRef.nullable(),
	rsvp,
	rsvpSource: rsvpSource.nullable(),
	rsvpAt: instant.nullable(),
	presence,
	hasCard: z.boolean(),
});
export const guestList = z.strictObject({ meetingId, guests: z.array(guest).max(1000) });
export const guestMutationResult = z.strictObject({ ...receipt, guest });
export const guestContactResult = z.strictObject({ ...receipt, guest, personCreated: z.boolean() });
export const ownRsvp = z.strictObject({
	meetingId,
	guestId: recordId,
	rsvp,
	responseAllowed: z.boolean(),
	revision,
});
export const rsvpTokenIssued = z.strictObject({ token: z.string(), expiresAt: instant, guestId: recordId });
/** What a public RSVP link may disclose: the invitation's meeting basics and the guest's own answer. */
export const rsvpTokenView = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("unavailable") }),
	z.strictObject({
		state: z.enum(["pending", "answered", "expired"]),
		meeting: z.strictObject({
			displayTitle: z.string(),
			startsAt: instant,
			localDate,
			localTime: z.string(),
			zone: timeZone,
			venue: z.strictObject({ name: z.string(), address: z.string() }).nullable(),
		}),
		guestFirstName: z.string(),
		rsvp,
	}),
]);
/** A link answer always records the response and closes the link. */
export const rsvpTokenAnswer = z.strictObject({ rsvp });

export const kitItem = z.strictObject({
	id: recordId,
	revision,
	key: z.string(),
	category: kitCategory,
	text: z.string(),
	assignee: personRef.nullable(),
	checked: z.boolean(),
	notes: z.string().nullable(),
});
export const kitResult = z.strictObject({
	meetingId,
	version: z.int().min(1).nullable(),
	items: z.array(kitItem).max(100),
	checked: z.int().min(0),
	total: z.int().min(0),
});
export const kitMutationResult = z.strictObject({
	...receipt,
	meetingId,
	items: z.array(kitItem).max(100),
	checked: z.int().min(0),
	total: z.int().min(0),
});

export const card = z.strictObject({
	guestId: recordId,
	personId,
	response: cardResponse,
	/** Prayer and question notes: only Owner/Admin reads see them. */
	notes: z.string().nullable(),
	occurredAt: instant,
	recordedAt: instant,
	attended: z.boolean(),
	revision,
});
export const cardList = z.strictObject({ meetingId, cards: z.array(card).max(1000) });
const breakdown = z.record(cardResponse, z.int().min(0));
/** Attended guests are the denominator; cards from absent guests are reported apart. No card is unknown, not negative. */
export const cardBreakdown = z.strictObject({
	meetingId,
	attended: z.strictObject({
		total: z.int().min(0),
		withCard: z.int().min(0),
		unknown: z.int().min(0),
		responses: breakdown,
	}),
	absentWithCard: z.strictObject({ total: z.int().min(0), responses: breakdown }),
});
export const cardMutationResult = z.strictObject({ ...receipt, guestId: recordId, card: card.nullable() });
export const attribution = z.strictObject({
	meetingId,
	guests: z.array(
		z.strictObject({
			guestId: recordId,
			person: personRef,
			inviter: personRef.nullable(),
			rsvp,
			rsvpSource: rsvpSource.nullable(),
		}),
	),
});
export const communicationContext = z.strictObject({
	meeting: meetingSummary,
	agenda: z.array(agendaSection),
	guests: z.array(
		z.strictObject({ guestId: recordId, personId, displayName: z.string(), hasEmail: z.boolean(), rsvp }),
	),
});
export const notificationPlan = z.strictObject({
	meetingId,
	revision,
	slots: z.array(
		z.strictObject({
			slot: reminderSlot,
			eligibleAt: instant,
			state: z.enum(["planned", "passed", "suppressed"]),
			recipients: z.array(accountId),
		}),
	),
});

export const venue = z.strictObject({
	id: venueId,
	revision,
	name: z.string(),
	address: z.string(),
	contactName: z.string().nullable(),
	phone: z.string().nullable(),
	email: z.string().nullable(),
	costDescription: z.string().nullable(),
	capacity: z.int().min(1).nullable(),
	notes: z.string().nullable(),
	active: z.boolean(),
});
export const venuePage = z.strictObject({
	items: z.array(venue).max(100),
	page: z.int().min(1),
	total: z.int().min(0),
	next: z.int().min(2).nullable(),
});
export const venueHistoryEntry = z.strictObject({
	id: operationId,
	kind: z.string(),
	occurredAt: instant,
	actorId: accountId.nullable(),
	before: z.record(z.string(), z.unknown()).nullable(),
	after: z.record(z.string(), z.unknown()).nullable(),
	reason: z.string().nullable(),
});
export const venueResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("available"), venue, history: z.array(venueHistoryEntry).max(100) }),
]);
export const venueHistory = z.strictObject({
	venueId,
	items: z.array(venueHistoryEntry).max(100),
	page: z.int().min(1),
	next: z.int().min(2).nullable(),
});
export const venueMutationResult = z.strictObject({ ...receipt, venue });
