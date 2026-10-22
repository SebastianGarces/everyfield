"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { redirect } from "next/navigation";
import { listPeopleRequest } from "@everyfield/contracts/people";
import {
	answerRsvpToken,
	attendanceReader,
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	venuesReader,
	venuesWriter,
	type AttendanceWriter,
	type MeetingsContext,
	withMeetingsWrite,
} from "@everyfield/domain/meetings";
import { tasksMount } from "@/server/tasks";
import { peopleReader } from "@everyfield/domain/people";
import type { MeetingsReply } from "@everyfield/contracts/meetings";
import type { Transaction } from "@everyfield/db/client";
import { read as readPeople } from "../people/server.ts";
import type { Finalization, Outcome } from "./model.ts";
import { loadCheckIn, loadMeeting, loadReport, outcome, read, readAnalytics, write, type Viewer } from "./server.ts";

// Server actions behind the meetings screens: the browser boundary. Each one rebuilds the viewer from the request and
// hands the browser's values to the producer, which parses them with the WP-020 contract (strict objects: no owner,
// actor or authority can be sent). A lost answer may be retried with the same request key; the producer replays a
// write that did commit instead of acting twice.

const noSeat = { status: "refused", code: "unavailable" } as const;
type Run<T> = (tx: Transaction, ctx: MeetingsContext) => Promise<MeetingsReply<T>>;

async function act<T>(run: Run<T>): Promise<Outcome<T>> {
	const v = await getViewer();
	if (!v?.people) return noSeat;
	return write(v.people, run);
}
async function look<T>(run: (viewer: Viewer) => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const v = await getViewer();
	if (!v?.people) return noSeat;
	return run(v.people);
}
const command = (requestKey: string, expectedRevision: string, input: unknown) => ({
	requestKey,
	expectedRevision,
	input,
});

// Meetings ------------------------------------------------------------------------------------------------------

/**
 * Plans a meeting and opens its page. The redirect returns the new page in the same response as the write, so the
 * browser makes one round trip instead of a write and then a page load. A refusal comes back as an Outcome.
 */
export async function scheduleMeeting(requestKey: string, input: unknown) {
	const r = await act((tx, ctx) => meetingsWriter.schedule(tx, ctx, { requestKey, input }));
	if (r.status === "ok") redirect(`/meetings/${r.value.meeting.id}`);
	return r;
}
export async function editMeeting(requestKey: string, expectedRevision: string, meetingId: string, patch: unknown) {
	return act((tx, ctx) => meetingsWriter.edit(tx, ctx, command(requestKey, expectedRevision, { meetingId, patch })));
}
export async function changeStatus(requestKey: string, expectedRevision: string, meetingId: string, to: string) {
	return act((tx, ctx) =>
		meetingsWriter.changeStatus(tx, ctx, command(requestKey, expectedRevision, { meetingId, to })),
	);
}
export async function deleteMeeting(requestKey: string, expectedRevision: string, meetingId: string, reason: string) {
	return act((tx, ctx) => meetingsWriter.delete(tx, ctx, command(requestKey, expectedRevision, { meetingId, reason })));
}
export async function completePractice(
	requestKey: string,
	expectedRevision: string,
	meetingId: string,
	occurredAt: string,
) {
	return act((tx, ctx) =>
		meetingsWriter.completePractice(tx, ctx, command(requestKey, expectedRevision, { meetingId, occurredAt })),
	);
}
export async function correctPractice(requestKey: string, expectedRevision: string, input: unknown) {
	return act((tx, ctx) =>
		meetingsWriter.correctPracticeOccurrence(tx, ctx, command(requestKey, expectedRevision, input)),
	);
}
export async function correctOccurrence(
	requestKey: string,
	expectedRevision: string,
	meetingId: string,
	voided: boolean,
	reason: string,
) {
	return act((tx, ctx) =>
		meetingsWriter.correctOccurrence(tx, ctx, command(requestKey, expectedRevision, { meetingId, voided, reason })),
	);
}
export async function replaceAgenda(
	requestKey: string,
	expectedRevision: string,
	meetingId: string,
	sections: unknown,
) {
	return act((tx, ctx) =>
		meetingsWriter.replaceAgenda(tx, ctx, command(requestKey, expectedRevision, { meetingId, sections })),
	);
}

/** The meeting page's data again, after a change was refused as out of date. Only this meeting is read. */
export async function reloadMeeting(meetingId: string) {
	return look(async (v) => ({ status: "ok" as const, value: await loadMeeting(v, meetingId) }));
}

/** The Vision report on the meetings list, read once when the list first shows (REQ-MTG-016). */
export async function visionReport() {
	return look(async (v) => ({ status: "ok" as const, value: await loadReport(v) }));
}

/** The check-in screen's data again, after a change was refused as out of date or its answer was lost. */
export async function reloadCheckIn(meetingId: string) {
	return look(async (v) => ({ status: "ok" as const, value: await loadCheckIn(v, meetingId) }));
}

// Vision kit ----------------------------------------------------------------------------------------------------

/** Adds the reviewed kit, then reads it, so the card shows the new items without reloading the page. */
export async function populateKit(requestKey: string, expectedRevision: string, meetingId: string) {
	const v = await getViewer();
	if (!v?.people) return noSeat;
	const done = await write(v.people, (tx, ctx) =>
		meetingsWriter.populateKit(tx, ctx, command(requestKey, expectedRevision, { meetingId })),
	);
	if (done.status !== "ok") return done;
	const kit = outcome(await read(v.people, (db, a) => meetingsReader.listKit(db, a, { meetingId })));
	return kit.status === "ok" ? { status: "ok" as const, value: { meeting: done.value.meeting, kit: kit.value } } : kit;
}
export async function updateKitItem(
	requestKey: string,
	expectedRevision: string,
	meetingId: string,
	itemId: string,
	patch: unknown,
) {
	return act((tx, ctx) =>
		meetingsWriter.updateKitItem(tx, ctx, command(requestKey, expectedRevision, { meetingId, itemId, patch })),
	);
}

// Guests --------------------------------------------------------------------------------------------------------

export async function inviteGuest(requestKey: string, input: unknown) {
	return act((tx, ctx) => guestsWriter.inviteGuest(tx, ctx, { requestKey, input }));
}
export async function createGuestContact(requestKey: string, input: unknown) {
	return act((tx, ctx) => guestsWriter.createGuestContact(tx, ctx, { requestKey, input }));
}
export async function removeGuest(requestKey: string, expectedRevision: string, meetingId: string, personId: string) {
	return act((tx, ctx) =>
		guestsWriter.removeGuest(tx, ctx, command(requestKey, expectedRevision, { meetingId, personId })),
	);
}
export async function setInviter(
	requestKey: string,
	expectedRevision: string,
	meetingId: string,
	personId: string,
	inviterPersonId: string | null,
) {
	return act((tx, ctx) =>
		guestsWriter.setInviter(tx, ctx, command(requestKey, expectedRevision, { meetingId, personId, inviterPersonId })),
	);
}
/** An Admin's RSVP correction (REQ-MTG-008). Null resets the answer to Pending. */
export async function correctRsvp(
	requestKey: string,
	expectedRevision: string,
	meetingId: string,
	personId: string,
	rsvp: string | null,
) {
	return act((tx, ctx) =>
		guestsWriter.correctRsvp(tx, ctx, command(requestKey, expectedRevision, { meetingId, personId, rsvp })),
	);
}
/** The signed-in guest's own answer (REQ-MTG-009). The producer finds their Person from the session. */
export async function saveOwnRsvp(requestKey: string, meetingId: string, rsvp: string) {
	return act((tx, ctx) => guestsWriter.saveOwnRsvp(tx, ctx, { requestKey, input: { meetingId, rsvp } }));
}
export async function recordCard(requestKey: string, expectedRevision: string, input: unknown) {
	return act((tx, ctx) => guestsWriter.recordCard(tx, ctx, command(requestKey, expectedRevision, input)));
}
export async function clearCard(
	requestKey: string,
	expectedRevision: string,
	meetingId: string,
	personId: string,
	reason: string,
) {
	return act((tx, ctx) =>
		guestsWriter.clearCard(tx, ctx, command(requestKey, expectedRevision, { meetingId, personId, reason })),
	);
}

/** People to add as a guest or name as an inviter: live people of this church whose name, email or phone match. */
export async function searchPeople(search: unknown): Promise<Outcome<{ id: string; name: string; detail: string }[]>> {
	const v = await getViewer();
	if (!v?.people) return noSeat;
	const request = listPeopleRequest.safeParse({ search, limit: 8 });
	if (!request.success) return { status: "refused", code: "invalid_input" };
	const r = await readPeople(v.people, (tx, ctx) => peopleReader.listPeople(tx, ctx, request.data));
	if (r.status === "failed") return { status: "lost" };
	if (r.status === "refused") return { status: "refused", code: r.error.code };
	return {
		status: "ok",
		value: r.value.items.map((p) => ({ id: p.id, name: p.displayName, detail: p.email ?? p.phone ?? "" })),
	};
}

// Attendance, finalization, evaluation (WP-022) -----------------------------------------------------------------

// Finalization and evaluation settle generated tasks, so their writer queues those tasks' reminders through the tasks
// mount in the same transaction. A deployment without it cannot settle work, so these writes are unavailable there.
let attendanceWriter: AttendanceWriter | undefined;
async function settle<T>(run: (w: AttendanceWriter) => Run<T>): Promise<Outcome<T>> {
	const mount = tasksMount();
	if (!mount) return noSeat;
	attendanceWriter ??= createAttendanceWriter({ reminders: mount.reminders });
	return act(run(attendanceWriter));
}
type Presence = "attended" | "absent" | "excused";

/** A guest's presence before finalization. Attended for someone not on the list adds them as a walk-in. */
export async function setPresence(requestKey: string, meetingId: string, personId: string, presence: Presence) {
	return settle(
		(w) => (tx, ctx) =>
			presence === "attended"
				? w.checkIn(tx, ctx, { requestKey, input: { meetingId, personId } })
				: presence === "absent"
					? w.clearAttendance(tx, ctx, { requestKey, input: { meetingId, personId } })
					: w.setAttendance(tx, ctx, { requestKey, input: { meetingId, personId, presence } }),
	);
}
/** Someone new at the door: their Person and their attended guest row in one write (REQ-MTG-011). */
export async function addWalkIn(requestKey: string, input: unknown) {
	return act((tx, ctx) => guestsWriter.createWalkInContact(tx, ctx, { requestKey, input }));
}
/**
 * Finalize or correct (reconcile) the attended set at the revision the person reviewed. The answer carries the
 * meeting's report as it is after the change, read in the same request, so the page shows the generated work at once.
 */
export async function settleAttendance(
	mode: "finalize" | "reconcile",
	requestKey: string,
	expectedRevision: string,
	input: unknown,
) {
	if (mode !== "finalize" && mode !== "reconcile") return { status: "refused", code: "invalid_input" } as const;
	const v = await getViewer();
	if (!v?.people) return noSeat;
	const done = await settle(
		(w) => (tx, ctx) =>
			(mode === "finalize" ? w.finalizeAttendance : w.reconcileAttendance)(tx, ctx, {
				requestKey,
				expectedRevision,
				input,
			}),
	);
	if (done.status !== "ok") return done;
	const report = await readAnalytics(v.people, done.value.meetingId);
	return {
		status: "ok" as const,
		value: { result: done.value, analytics: report.status === "ok" ? report.value : null },
	};
}
/** Carries a finalize or correction result out of its transaction, so the transaction rolls back. */
class Preview extends Error {
	constructor(readonly value: unknown) {
		super("preview");
	}
}
/**
 * The exact effects of a finalize or correction before the person confirms it (REQ-MTG-012, C73): each follow-up call
 * with its person and owner, each advance to Attendee and the evaluation task. It runs the real producer in a
 * transaction and rolls it back, so the review shows what the same command would do now, with nothing saved. Task
 * reminders join the same transaction and roll back with it.
 */
export async function previewSettlement(
	mode: "finalize" | "reconcile",
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<Finalization>> {
	if (mode !== "finalize" && mode !== "reconcile") return { status: "refused", code: "invalid_input" } as const;
	const v = await getViewer();
	const mount = tasksMount();
	const db = requestDatabase();
	if (!v?.people || !mount || !db) return noSeat;
	attendanceWriter ??= createAttendanceWriter({ reminders: mount.reminders });
	const w = attendanceWriter;
	try {
		const r = await withMeetingsWrite(db, v.people.authority, async (tx, ctx) => {
			const real = await (mode === "finalize" ? w.finalizeAttendance : w.reconcileAttendance)(tx, ctx, {
				requestKey: crypto.randomUUID(),
				expectedRevision,
				input,
			});
			if (real.status !== "ok") return real;
			throw new Preview(real.value);
		});
		// Only a refusal returns here; a computed result leaves as a Preview and rolls the transaction back.
		return r.status === "refused" ? outcome(r) : { status: "lost" };
	} catch (error) {
		if (error instanceof Preview) return { status: "ok" as const, value: error.value as Finalization };
		console.error(JSON.stringify({ component: "meetings", outcome: "preview_failed", error: String(error) }));
		return { status: "lost" } as const;
	}
}
export async function recordEvaluation(requestKey: string, input: unknown) {
	return settle((w) => (tx, ctx) => w.recordEvaluation(tx, ctx, { requestKey, input }));
}
export async function correctEvaluation(requestKey: string, expectedRevision: string, input: unknown) {
	return settle((w) => (tx, ctx) => w.correctEvaluation(tx, ctx, { requestKey, expectedRevision, input }));
}
/** The evaluation's original record and every correction, read when the person opens its history. */
export async function evaluationHistory(meetingId: string) {
	return look(async (v) => outcome(await read(v, (db, a) => attendanceReader.evaluationHistory(db, a, { meetingId }))));
}
/** A note about an attendee, kept in the person's history with this meeting as its source (REQ-MTG-017). */
export async function addAttendeeNote(requestKey: string, meetingId: string, personId: string, text: string) {
	return settle((w) => (tx, ctx) => w.addAttendeeNote(tx, ctx, { requestKey, input: { meetingId, personId, text } }));
}

// Places (venues) -----------------------------------------------------------------------------------------------

export async function listVenues(request: unknown) {
	return look(async (v) => outcome(await read(v, (db, a) => venuesReader.list(db, a, request))));
}
/** One place with its correction history. */
export async function getVenue(venueId: string) {
	return look(async (v) => outcome(await read(v, (db, a) => venuesReader.get(db, a, { venueId }))));
}
export async function createVenue(requestKey: string, input: unknown) {
	return act((tx, ctx) => venuesWriter.create(tx, ctx, { requestKey, input }));
}
/** Edit, correct (with a reason), archive or restore one place, at the revision the screen last saw. */
export async function changeVenue(
	op: "edit" | "correct" | "archive" | "restore",
	requestKey: string,
	expectedRevision: string,
	input: unknown,
) {
	if (!["edit", "correct", "archive", "restore"].includes(op))
		return { status: "refused", code: "invalid_input" } as const;
	return act((tx, ctx) => venuesWriter[op](tx, ctx, command(requestKey, expectedRevision, input)));
}

// Public RSVP link ----------------------------------------------------------------------------------------------

/** An explicit answer through a personal link (COM-010). No session is read or granted. */
export async function answerRsvp(token: unknown, rsvp: unknown): Promise<Outcome<{ rsvp: string }>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		const r = await answerRsvpToken(db, { token, rsvp });
		return r.status === "ok" ? r : { status: "refused", code: r.error.code };
	} catch (error) {
		console.error(JSON.stringify({ component: "meetings", outcome: "rsvp_failed", error: String(error) }));
		return { status: "lost" };
	}
}
