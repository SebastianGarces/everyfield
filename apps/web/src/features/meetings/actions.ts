"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { redirect } from "next/navigation";
import {
	answerRsvpToken,
	attendanceReader,
	describeRsvpToken,
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	venuesWriter,
	type AttendanceWriter,
	type MeetingsContext,
	previewMeetingsWrite,
	rosterWriter,
} from "@everyfield/domain/meetings";
import { tasksMount } from "../tasks/mount.ts";
import type { MeetingsReply, rsvpTokenView } from "@everyfield/contracts/meetings";
import { z } from "zod";
import type { Finalization, Outcome } from "./model.ts";
import { loadCheckIn, loadMeeting, loadReport, outcome, read, readAnalytics, write, type Viewer } from "./server.ts";
import { logFailure } from "@everyfield/domain/log";
import type { WriteTx } from "@everyfield/domain/access";

const noSeat = { status: "refused", code: "unavailable" } as const;
type Run<T> = (tx: WriteTx, ctx: MeetingsContext) => Promise<MeetingsReply<T>>;

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

export async function updateRoster(requestKey: string, meetingId: string, add: unknown, remove: unknown) {
	return act((tx, ctx) => rosterWriter.copyTeamRoster(tx, ctx, { requestKey, input: { meetingId, add, remove } }));
}

export async function reloadMeeting(meetingId: string) {
	return look(async (v) => ({ status: "ok" as const, value: await loadMeeting(v, meetingId) }));
}

export async function visionReport() {
	return look(async (v) => ({ status: "ok" as const, value: await loadReport(v) }));
}

export async function reloadCheckIn(meetingId: string) {
	return look(async (v) => ({ status: "ok" as const, value: await loadCheckIn(v, meetingId) }));
}

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

export async function addGuests(requestKey: string, input: unknown) {
	return act((tx, ctx) => guestsWriter.addGuests(tx, ctx, { requestKey, input }));
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

let attendanceWriter: AttendanceWriter | undefined;
async function settle<T>(run: (w: AttendanceWriter) => Run<T>): Promise<Outcome<T>> {
	const mount = tasksMount();
	if (!mount) return noSeat;
	attendanceWriter ??= createAttendanceWriter({ reminders: mount.reminders });
	return act(run(attendanceWriter));
}
export async function setPresence(requestKey: string, meetingId: string, personId: string, presence: unknown) {
	return settle(
		(w) => (tx, ctx) =>
			presence === "attended"
				? w.checkIn(tx, ctx, { requestKey, input: { meetingId, personId } })
				: presence === "absent"
					? w.clearAttendance(tx, ctx, { requestKey, input: { meetingId, personId } })
					: w.setAttendance(tx, ctx, { requestKey, input: { meetingId, personId, presence } }),
	);
}
export async function addWalkIn(requestKey: string, input: unknown) {
	return act((tx, ctx) => guestsWriter.createWalkInContact(tx, ctx, { requestKey, input }));
}
export async function settleAttendance(mode: unknown, requestKey: string, expectedRevision: string, input: unknown) {
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
export async function previewSettlement(
	mode: unknown,
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
		return outcome(
			await previewMeetingsWrite(db, v.people.authority, (tx, ctx) =>
				(mode === "finalize" ? w.finalizeAttendance : w.reconcileAttendance)(tx, ctx, {
					requestKey: crypto.randomUUID(),
					expectedRevision,
					input,
				}),
			),
		);
	} catch (error) {
		logFailure({ component: "meetings", outcome: "preview_failed" }, error);
		return { status: "lost" } as const;
	}
}
export async function recordEvaluation(requestKey: string, input: unknown) {
	return settle((w) => (tx, ctx) => w.recordEvaluation(tx, ctx, { requestKey, input }));
}
export async function correctEvaluation(requestKey: string, expectedRevision: string, input: unknown) {
	return settle((w) => (tx, ctx) => w.correctEvaluation(tx, ctx, { requestKey, expectedRevision, input }));
}
export async function evaluationHistory(meetingId: string) {
	return look(async (v) => outcome(await read(v, (db, a) => attendanceReader.evaluationHistory(db, a, { meetingId }))));
}
export async function addAttendeeNote(requestKey: string, meetingId: string, personId: string, text: string) {
	return settle((w) => (tx, ctx) => w.addAttendeeNote(tx, ctx, { requestKey, input: { meetingId, personId, text } }));
}

export async function createVenue(requestKey: string, input: unknown) {
	return act((tx, ctx) => venuesWriter.create(tx, ctx, { requestKey, input }));
}
export async function changeVenue(op: unknown, requestKey: string, expectedRevision: string, input: unknown) {
	if (op !== "edit" && op !== "correct" && op !== "archive" && op !== "restore")
		return { status: "refused", code: "invalid_input" } as const;
	return act((tx, ctx) => venuesWriter[op](tx, ctx, command(requestKey, expectedRevision, input)));
}

export async function answerRsvp(token: unknown, rsvp: unknown): Promise<Outcome<{ rsvp: string }>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		const r = await answerRsvpToken(db, { token, rsvp });
		return r.status === "ok" ? r : { status: "refused", code: r.error.code };
	} catch (error) {
		logFailure({ component: "meetings", outcome: "rsvp_failed" }, error);
		return { status: "lost" };
	}
}
export async function readRsvpLink(token: unknown): Promise<Outcome<z.infer<typeof rsvpTokenView>>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return { status: "ok", value: await describeRsvpToken(db, { token }) };
	} catch (error) {
		logFailure({ component: "meetings", outcome: "rsvp_read_failed" }, error);
		return { status: "lost" };
	}
}
