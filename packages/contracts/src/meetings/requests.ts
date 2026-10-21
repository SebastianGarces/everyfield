import { z } from "zod";
import { instant } from "../common/time.ts";
import { personId, recordId, requestKey } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { displayName } from "../people/values.ts";
import {
	agenda,
	cardResponse,
	enteredTime,
	meetingId,
	meetingStatus,
	meetingType,
	meetingWindow,
	pageInput,
	preparation,
	reason,
	rsvpAnswer,
	schedulableType,
	venueFields,
	venueId,
	venuePatchFields,
} from "./values.ts";

// No owner, account, creator, actor, Vision number or authority in any body: the server derives them.
const create = <T extends z.ZodType>(input: T) => z.strictObject({ requestKey, input });

/** A new meeting's location: none, an active saved venue (its name and address are copied), or a venue created with it. */
export const venueChoice = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("none") }),
	z.strictObject({ kind: z.literal("existing"), venueId }),
	z.strictObject({ kind: z.literal("new"), venue: z.strictObject(venueFields) }),
]);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const scheduleMeetingRequest = create(
	z.strictObject({
		type: schedulableType,
		title: optionalText(200),
		notes: optionalText(5000),
		...enteredTime,
		venue: venueChoice.default({ kind: "none" }),
		guests: z
			.array(personId)
			.max(200)
			.refine((ids) => new Set(ids).size === ids.length, "duplicate_guest")
			.default([]),
	}),
);
// Type and team are fixed at creation, so an edit cannot name them.
export const editMeetingRequest = commandEnvelope(
	z.strictObject({
		meetingId,
		patch: z
			.strictObject({
				title: optionalText(200),
				notes: optionalText(5000),
				date: enteredTime.date.optional(),
				time: enteredTime.time.optional(),
				offsetSeconds: enteredTime.offsetSeconds,
				venue: venueChoice.optional(),
			})
			.refine((p) => (p.date === undefined) === (p.time === undefined), "date_and_time_together"),
	}),
);
export const changeStatusRequest = commandEnvelope(z.strictObject({ meetingId, to: meetingStatus }));
export const deleteMeetingRequest = commandEnvelope(z.strictObject({ meetingId, reason }));
export const completePracticeRequest = commandEnvelope(z.strictObject({ meetingId, occurredAt: instant }));
export const correctPracticeRequest = commandEnvelope(
	z
		.strictObject({
			meetingId,
			state: z.enum(["completed", "not_completed"]),
			occurredAt: instant.optional(),
			reason,
		})
		.refine((v) => (v.state === "completed") === (v.occurredAt !== undefined), "occurred_at_with_completed"),
);
/** Void marks an invalid held occurrence; restoring clears the void. Archiving a genuine one is delete. */
export const correctOccurrenceRequest = commandEnvelope(z.strictObject({ meetingId, voided: z.boolean(), reason }));
export const replaceAgendaRequest = commandEnvelope(z.strictObject({ meetingId, sections: agenda }));
export const populateKitRequest = commandEnvelope(z.strictObject({ meetingId }));
/** The expected revision is the item's own. */
export const updateKitItemRequest = commandEnvelope(
	z.strictObject({
		meetingId,
		itemId: recordId,
		patch: z
			.strictObject({
				checked: z.boolean().optional(),
				assigneePersonId: personId.nullable().optional(),
				notes: z.string().trim().max(1000).nullable().optional(),
			})
			.refine((p) => Object.keys(p).length > 0, "empty_patch"),
	}),
);

export const inviteGuestRequest = create(
	z
		.strictObject({ meetingId, personId, inviterPersonId: personId.nullable().default(null) })
		.refine((v) => v.inviterPersonId !== v.personId, "self_inviter"),
);
/** Guest writes below name the guest by Person; the expected revision is the guest row's. */
const guest = { meetingId, personId };
export const removeGuestRequest = commandEnvelope(z.strictObject(guest));
export const setInviterRequest = commandEnvelope(
	z
		.strictObject({ ...guest, inviterPersonId: personId.nullable() })
		.refine((v) => v.inviterPersonId !== v.personId, "self_inviter"),
);
/** Null resets the answer to Pending. */
export const correctRsvpRequest = commandEnvelope(z.strictObject({ ...guest, rsvp: rsvpAnswer.nullable() }));
export const saveOwnRsvpRequest = create(z.strictObject({ meetingId, rsvp: rsvpAnswer }));
const contact = {
	meetingId,
	displayName,
	email: z.string().trim().pipe(z.email().max(320)).nullable().default(null),
	phone: z.string().trim().max(40).nullable().default(null),
	country: z.string().trim().max(255).nullable().default(null),
};
export const createGuestContactRequest = create(
	z.strictObject({ ...contact, attendance: z.enum(["attended", "not_recorded"]).default("not_recorded") }),
);
export const createWalkInContactRequest = create(z.strictObject(contact));
export const recordCardRequest = commandEnvelope(
	z.strictObject({
		...guest,
		response: cardResponse,
		notes: z.string().trim().max(2000).nullable().default(null),
		occurredAt: instant.optional(),
	}),
);
export const clearCardRequest = commandEnvelope(z.strictObject({ ...guest, reason }));
/** Internal: the invitation send or guest transaction that already holds the reviewed intent mints the token. */
export const createRsvpTokenRequest = z.strictObject(guest);
export const rsvpToken = z
	.string()
	.regex(/^[A-Za-z0-9_-]{43}$/)
	.brand<"RsvpToken">();
export const describeRsvpTokenRequest = z.strictObject({ token: rsvpToken });
export const answerRsvpTokenRequest = z.strictObject({ token: rsvpToken, rsvp: rsvpAnswer });

export const createVenueRequest = create(z.strictObject(venueFields));
const venuePatch = z
	.strictObject(venuePatchFields)
	.partial()
	.refine((p) => Object.keys(p).length > 0, "empty_patch");
export const editVenueRequest = commandEnvelope(z.strictObject({ venueId, patch: venuePatch }));
export const correctVenueRequest = commandEnvelope(z.strictObject({ venueId, patch: venuePatch, reason }));
export const archiveVenueRequest = commandEnvelope(z.strictObject({ venueId, reason: reason.optional() }));
export const restoreVenueRequest = commandEnvelope(z.strictObject({ venueId }));

export const listMeetingsRequest = z.strictObject({
	window: meetingWindow.default("all"),
	// An empty list means every type. Repeated values count once.
	types: z.array(meetingType).max(8).default([]),
	statuses: z.array(meetingStatus).max(10).default([]),
	preparation: preparation.default("any"),
	...pageInput,
});
export const meetingRequest = z.strictObject({ meetingId });
export const hasHistoryRequest = z.strictObject({ types: z.array(meetingType).max(8).default([]) });
export const listVenuesRequest = z.strictObject({
	archived: z.enum(["exclude", "include", "only"]).default("exclude"),
	search: z.string().trim().max(120).optional(),
	minCapacity: z.int().min(1).max(100_000).optional(),
	...pageInput,
});
export const venueRequest = z.strictObject({ venueId });
export const venueHistoryRequest = z.strictObject({ venueId, ...pageInput });
export const planNotificationsRequest = z.strictObject({ meetingId, asOf: instant });
