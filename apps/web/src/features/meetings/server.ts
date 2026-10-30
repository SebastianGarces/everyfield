import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { MeetingsContext } from "@everyfield/domain/meetings";
import { attendanceReader, meetingsReader, withMeetingsWrite } from "@everyfield/domain/meetings";
import type { MeetingsReply } from "@everyfield/contracts/meetings";
import type { Database, Transaction } from "@everyfield/db/client";
import "server-only";
import { isFiltered, listRequest, pageCount, type MeetingsQuery, type Outcome } from "./model.ts";

// The meetings screens' data access. Every producer read is one statement without locks, so a page sends its reads
// side by side on the request's pool instead of one after another in a transaction: the page waits for one round trip,
// not five. Writes run in their own transaction through the producer's native write.

type Peopled = NonNullable<NonNullable<Awaited<ReturnType<typeof getViewer>>>["people"]>;
export type Viewer = Peopled;
export const canWrite = (v: Viewer) => v.role === "owner" || v.role === "admin";

type Reply<T> = MeetingsReply<T> | { status: "failed" };

/** One producer read. A thrown database error reads as failed, never as a crash or as an empty list. */
export async function read<T>(
	viewer: Viewer,
	run: (db: Database, authority: Viewer["authority"]) => Promise<MeetingsReply<T>>,
): Promise<Reply<T>> {
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		return await run(db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "meetings", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

/** One native write in its own transaction. The actor comes from the request, never from the browser. */
export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: MeetingsContext) => Promise<MeetingsReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await withMeetingsWrite(db, viewer.authority, run));
	} catch (error) {
		console.error(JSON.stringify({ component: "meetings", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** A producer reply as the browser sees it. An ambiguous local time carries its two choices. */
export function outcome<T>(reply: Reply<T>): Outcome<T> {
	if (reply.status === "failed") return { status: "lost" };
	if (reply.status === "refused") {
		const e = reply.error;
		return e.code === "ambiguous_local_time"
			? { status: "refused", code: e.code, choices: e.details.choices }
			: e.code === "invalid_input"
				? { status: "refused", code: e.code, issues: e.details.issues }
				: { status: "refused", code: e.code };
	}
	return { status: "ok", value: reply.value };
}

const value = <T>(r: Reply<T>): T | null => (r.status === "ok" ? r.value : null);

/** The viewer when they hold a plant seat; null otherwise. */
export async function plantViewer() {
	const v = await getViewer();
	return { viewer: v?.people ?? null, signedOut: !v || v.status === "unauthenticated", ok: v !== null };
}

export type MeetingsView = Awaited<ReturnType<typeof loadMeetings>>;

/**
 * The list page: the filtered page and the next upcoming meeting side by side. A page past the end reads the last page
 * (D67). An empty filtered page also asks whether any meeting exists, so it never claims there is no history.
 */
export async function loadMeetings(viewer: Viewer, query: MeetingsQuery) {
	const list = (q: MeetingsQuery) => read(viewer, (db, a) => meetingsReader.list(db, a, listRequest(q)));
	const [first, upcoming] = await Promise.all([
		list(query),
		read(viewer, (db, a) => meetingsReader.list(db, a, { window: "upcoming", limit: 1 })),
	]);
	let page = first;
	if (page.status === "ok" && page.value.items.length === 0 && query.page > pageCount(page.value.total)) {
		query = { ...query, page: pageCount(page.value.total) };
		page = await list(query);
	}
	const items = value(page);
	const history =
		items && items.total === 0 && isFiltered(query)
			? value(await read(viewer, (db, a) => meetingsReader.hasHistory(db, a, {})))?.hasHistory === true
			: (items?.total ?? 0) > 0;
	return {
		query,
		page: items,
		next: value(upcoming)?.items[0] ?? null,
		hasHistory: history,
		now: new Date().toISOString(),
	};
}

/**
 * The meeting page: the meeting, guests, kit, cards and the viewer's own RSVP, read side by side. Only the meeting
 * itself decides found or not found; a part that fails to load shows its own error in place. The card summary is
 * counted from the guests and cards on screen, so a recorded card updates it without another read.
 */
export async function loadMeeting(viewer: Viewer, meetingId: string) {
	const request = { meetingId };
	// The evaluation exists only for a Vision meeting, so it is read right after the meeting, while the other reads run.
	const meetingRead = read(viewer, (db, a) => meetingsReader.get(db, a, request));
	const [meeting, guests, kit, cards, own, attendance, analytics, evaluation] = await Promise.all([
		meetingRead,
		read(viewer, (db, a) => meetingsReader.listGuests(db, a, request)),
		read(viewer, (db, a) => meetingsReader.listKit(db, a, request)),
		read(viewer, (db, a) => meetingsReader.listCards(db, a, request)),
		read(viewer, (db, a) => meetingsReader.getOwnRsvp(db, a, request)),
		readAttendance(viewer, meetingId),
		// The meeting's report is for Owners and Admins; a Member's read would only be refused.
		canWrite(viewer) ? readAnalytics(viewer, meetingId) : null,
		meetingRead.then((m) =>
			m.status === "ok" && m.value.status !== "unavailable" && m.value.meeting.type === "vision_meeting"
				? read(viewer, (db, a) => attendanceReader.getEvaluation(db, a, request))
				: null,
		),
	]);
	if (meeting.status === "failed") return { status: "failed" } as const;
	if (meeting.status === "refused" || meeting.value.status === "unavailable") return { status: "missing" } as const;
	return {
		status: "found",
		meeting: meeting.value.meeting,
		guests: value(guests)?.guests ?? null,
		kit: value(kit),
		cards: value(cards)?.cards ?? null,
		own: value(own),
		attendance: value(attendance),
		analytics: analytics ? value(analytics) : null,
		evaluation: evaluation ? value(evaluation) : null,
		now: new Date().toISOString(),
	} as const;
}

/** Presence, classification and the attendance revision of every guest (up to the 500 a meeting can finalize). */
export const readAttendance = (viewer: Viewer, meetingId: string) =>
	read(viewer, (db, a) => attendanceReader.listAttendance(db, a, { meetingId, limit: 500 }));
/** Attended, growth, the evaluation comparison and the generated work of one meeting. */
export const readAnalytics = (viewer: Viewer, meetingId: string) =>
	read(viewer, (db, a) => attendanceReader.readAnalytics(db, a, { meetingId }));

export type MeetingsReport = Awaited<ReturnType<typeof loadReport>>;
/**
 * The Vision report on the meetings list (REQ-MTG-016): the summary, attendance and evaluation trends of the last 12
 * finalized Vision meetings, read side by side. A report may take longer than a simple read; each part that fails
 * shows its own error.
 */
export async function loadReport(viewer: Viewer) {
	const window = { types: ["vision_meeting"], limit: 12 };
	const [stats, attendance, evaluation] = await Promise.all([
		read(viewer, (db, a) => attendanceReader.summaryStats(db, a, window)),
		read(viewer, (db, a) => attendanceReader.attendanceTrend(db, a, window)),
		read(viewer, (db, a) => attendanceReader.evaluationTrend(db, a, window)),
	]);
	return { stats: value(stats), attendance: value(attendance), evaluation: value(evaluation) };
}
export type MeetingPageData = Extract<Awaited<ReturnType<typeof loadMeeting>>, { status: "found" }>;

/** Door check-in: the meeting, its guests and their attendance, read side by side. */
export async function loadCheckIn(viewer: Viewer, meetingId: string) {
	const request = { meetingId };
	const [meeting, guests, attendance] = await Promise.all([
		read(viewer, (db, a) => meetingsReader.get(db, a, request)),
		read(viewer, (db, a) => meetingsReader.listGuests(db, a, request)),
		readAttendance(viewer, meetingId),
	]);
	if (meeting.status === "failed" || guests.status === "failed") return { status: "failed" } as const;
	if (meeting.status === "refused" || meeting.value.status === "unavailable") return { status: "missing" } as const;
	if (guests.status !== "ok") return { status: "failed" } as const;
	return {
		status: "found",
		meeting: meeting.value.meeting,
		guests: guests.value.guests,
		attendance: value(attendance),
		now: new Date().toISOString(),
	} as const;
}
export type CheckInData = Extract<Awaited<ReturnType<typeof loadCheckIn>>, { status: "found" }>;
