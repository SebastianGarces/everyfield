import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { MeetingsContext } from "@everyfield/domain/meetings";
import { documentsReader } from "@everyfield/domain/documents";
import { attendanceReader, meetingsReader, withMeetingsWrite } from "@everyfield/domain/meetings";
import type { MeetingsReply } from "@everyfield/contracts/meetings";
import type { Database } from "@everyfield/db/client";
import "server-only";
import { isFiltered, listRequest, NEXT_REQUEST, pageCount, type MeetingsQuery, type Outcome } from "./model.ts";
import { canWrite } from "../../components/seat-role.ts";
import { LOST, transient } from "../../server/platform/transient.ts";
import type { WriteTx } from "@everyfield/domain/access";

type Peopled = NonNullable<Awaited<ReturnType<typeof getViewer>>["people"]>;
export type Viewer = Peopled;

type Reply<T> = MeetingsReply<T> | { status: "failed" };

export async function read<T>(
	viewer: Viewer,
	run: (db: Database, authority: Viewer["authority"]) => Promise<MeetingsReply<T>>,
): Promise<Reply<T>> {
	const db = requestDatabase();
	return transient({ component: "meetings", outcome: "read_failed" }, () => run(db, viewer.authority), {
		status: "failed",
	});
}

export async function write<T>(
	viewer: Viewer,
	run: (tx: WriteTx, context: MeetingsContext) => Promise<MeetingsReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	return transient(
		{ component: "meetings", outcome: "write_failed" },
		async () => {
			return outcome(await withMeetingsWrite(db, viewer.authority, run));
		},
		LOST,
	);
}

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

export async function plantViewer() {
	const v = await getViewer();
	return { viewer: v.people ?? null, signedOut: v.status === "unauthenticated" };
}

export type MeetingsView = Awaited<ReturnType<typeof loadMeetings>>;

export async function loadMeetings(viewer: Viewer, query: MeetingsQuery) {
	const list = (q: MeetingsQuery) => read(viewer, (db, a) => meetingsReader.list(db, a, listRequest(q)));
	const [first, upcoming] = await Promise.all([
		list(query),
		read(viewer, (db, a) => meetingsReader.list(db, a, NEXT_REQUEST)),
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

async function readAgendaTemplate(viewer: Viewer, meetingId: string) {
	const db = requestDatabase();
	return transient(
		{ component: "meetings", outcome: "agenda_template_failed" },
		async () => {
			const reply = await documentsReader["templates.contextual"](db, viewer.authority, { meetingId });
			return reply.status === "ok" ? (reply.value.templates[0]?.id ?? null) : null;
		},
		null,
	);
}

export async function loadMeeting(viewer: Viewer, meetingId: string) {
	const request = { meetingId };
	const meetingRead = read(viewer, (db, a) => meetingsReader.get(db, a, request));
	const [meeting, people, kit, own, analytics, evaluation, agendaTemplate] = await Promise.all([
		meetingRead,
		read(viewer, (db, a) => meetingsReader.pageGuests(db, a, request)),
		read(viewer, (db, a) => meetingsReader.listKit(db, a, request)),
		read(viewer, (db, a) => meetingsReader.getOwnRsvp(db, a, request)),
		canWrite(viewer) ? readAnalytics(viewer, meetingId) : null,
		meetingRead.then((m) =>
			m.status === "ok" && m.value.status !== "unavailable" && m.value.meeting.type === "vision_meeting"
				? read(viewer, (db, a) => attendanceReader.getEvaluation(db, a, request))
				: null,
		),
		readAgendaTemplate(viewer, meetingId),
	]);
	if (meeting.status === "failed") return { status: "failed" } as const;
	if (meeting.status === "refused" || meeting.value.status === "unavailable") return { status: "missing" } as const;
	const page = value(people);
	return {
		status: "found",
		meeting: meeting.value.meeting,
		agendaTemplate,
		guests: page?.guests.guests ?? null,
		emailOpens: page?.guests.emailOpens ?? [],
		photos: page?.guests.photos ?? [],
		kit: value(kit),
		cards: page?.cards.cards ?? null,
		own: value(own),
		attendance: page?.attendance ?? null,
		analytics: analytics ? value(analytics) : null,
		evaluation: evaluation ? value(evaluation) : null,
		now: new Date().toISOString(),
	} as const;
}

const readAttendance = (viewer: Viewer, meetingId: string) =>
	read(viewer, (db, a) => attendanceReader.listAttendance(db, a, { meetingId, limit: 500 }));
export const readAnalytics = (viewer: Viewer, meetingId: string) =>
	read(viewer, (db, a) => attendanceReader.readAnalytics(db, a, { meetingId }));

export type MeetingsReport = Awaited<ReturnType<typeof loadReport>>;
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
