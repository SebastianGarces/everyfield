import { historyQuery } from "@everyfield/contracts/communication";
import { communicationWriter } from "@everyfield/domain/communication";
import { meetingsReader } from "@everyfield/domain/meetings";
import "server-only";
import { z } from "zod";
import { canWrite } from "../../components/seat-role.ts";
import { appOrigin } from "../../server/mail/transport.ts";
import { defineReads } from "../../server/platform/reads.ts";
import { read as readMeeting } from "../meetings/server.ts";
import type {
	Draft,
	HistoryPage,
	MeetingContext,
	MeetingHistory,
	Outcome,
	PersonHistory,
	Recipient,
	SuppressionReport,
	Template,
	TrackingRow,
} from "./model.ts";
import { communicationViewer, deliverAs, read } from "./server.ts";

const HISTORY_PAGE = 50;
const denied = { status: "refused", code: "access_denied" } as const;
const page = { cursor: z.string().optional() };

async function seat() {
	const gate = await communicationViewer();
	return gate.viewer ? { ...gate, viewer: gate.viewer } : null;
}

export const GET = defineReads(seat, "access_denied", (get) => ({
	recipients: get(z.string(), ({ viewer }, query): Promise<Outcome<{ people: Recipient[] }>> =>
		canWrite(viewer)
			? read(viewer, (tx) => communicationWriter.readRecipients(tx, viewer.authority, { query }))
			: Promise.resolve(denied),
	),
	draft: get(z.strictObject({ communicationId: z.string() }), ({ viewer }, v): Promise<Outcome<Draft>> =>
		canWrite(viewer)
			? read(viewer, (tx) => communicationWriter.get(tx, viewer.authority, { id: v.communicationId }))
			: Promise.resolve(denied),
	),
	template: get(z.strictObject({ meetingType: z.string() }), ({ viewer }, v): Promise<Outcome<Template>> =>
		canWrite(viewer)
			? read(viewer, (tx) => communicationWriter.readMeetingTemplate(tx, viewer.authority, v))
			: Promise.resolve(denied),
	),
	suppression: get(z.undefined(), async (gate): Promise<Outcome<SuppressionReport>> => {
		if (!canWrite(gate.viewer)) return denied;
		const address = gate.email;
		if (!address) return denied;
		const result = await deliverAs(gate, (db, viewer, mail) =>
			communicationWriter.listForSelf(db, viewer.authority, { address }, mail.keys),
		);
		if (result.status !== "ok") return result;
		const { active, restores } = result.value;
		return { status: "ok", value: { address: result.value.address, active, restores } };
	}),
	history: get(historyQuery, ({ viewer }, query): Promise<Outcome<HistoryPage>> =>
		read(viewer, (tx) => communicationWriter.listHistory(tx, viewer.authority, query)),
	),
	person: get(z.strictObject({ personId: z.string(), ...page }), ({ viewer }, v): Promise<Outcome<PersonHistory>> =>
		read(viewer, (tx) => communicationWriter.listForPerson(tx, viewer.authority, { ...v, limit: HISTORY_PAGE })),
	),
	meeting: get(z.strictObject({ meetingId: z.string(), ...page }), ({ viewer }, v): Promise<Outcome<MeetingHistory>> =>
		read(viewer, (tx) => communicationWriter.listForMeeting(tx, viewer.authority, { ...v, limit: HISTORY_PAGE })),
	),
	tracking: get(
		z.strictObject({ meetingId: z.string() }),
		({ viewer }, v): Promise<Outcome<{ items: TrackingRow[] }>> =>
			read(viewer, async (tx) => {
				const result = await communicationWriter.listMeetingTracking(tx, viewer.authority, v);
				if (result.status !== "ok") return result;
				return { status: "ok", value: { items: result.value.items } };
			}),
	),
	context: get(z.strictObject({ meetingId: z.string() }), async ({ viewer }, v): Promise<Outcome<MeetingContext>> => {
		if (!canWrite(viewer)) return denied;
		const context = await readMeeting(viewer, (db, a) => meetingsReader.communicationContext(db, a, v));
		if (context.status === "failed") return { status: "lost" };
		if (context.status === "refused") return { status: "refused", code: "not_found" };
		const { meeting: m, guests } = context.value;
		return {
			status: "ok",
			value: {
				id: m.id,
				type: m.type,
				title: m.displayTitle,
				date: m.localDate,
				time: m.localTime,
				place: m.venue?.name ?? null,
				guests: guests.map((g) => ({ id: g.personId, displayName: g.displayName })),
			},
		};
	}),
	preview: get(z.undefined(), async ({ viewer }): Promise<Outcome<{ churchName: string; origin: string }>> => {
		const origin = appOrigin();
		if (origin === null) return { status: "refused", code: "unavailable" };
		return read(viewer, async (tx) => {
			const church = await communicationWriter.readChurchName(tx, viewer.authority);
			if (church.status !== "ok") return church;
			return { status: "ok", value: { churchName: church.value.churchName, origin } };
		});
	}),
}));
