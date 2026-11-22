import type { meetingSummary } from "@everyfield/contracts/meetings";
import type { MeetingsReply } from "@everyfield/contracts/meetings";
import type { Transaction } from "@everyfield/db/client";
import { meetingsReader } from "@everyfield/domain/meetings";
import { z } from "zod";
import type { EvryActor } from "../../context/actor.ts";
import { EvryRefusal } from "../../context/errors.ts";
import { localWhen } from "../../catalog/labels.ts";
import type { SourceRow } from "../../catalog/types.ts";

export const id = z.string().regex(/^[0-9a-f-]{36}$/);
export const meetingId = id;
export const personId = id;
export const venueId = id;
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
export const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

export function value<T>(reply: MeetingsReply<T>): T | null {
	if (reply.status === "ok") return reply.value;
	if (reply.error.code === "invalid_input") throw new EvryRefusal("invalid_input");
	if (reply.error.code === "unavailable") return null;
	throw new EvryRefusal("source_unavailable");
}

export async function meeting(db: Pick<Transaction, "execute">, actor: EvryActor, meetingId: string) {
	const m = value(await meetingsReader.get(db, actor.authority, { meetingId }));
	return m?.status === "available" ? m.meeting : null;
}

export const RSVP: Record<string, string> = { confirmed: "yes", declined: "no", pending: "no answer" };

type Summary = z.infer<typeof meetingSummary>;
export function meetingRow(m: Summary, extra: Record<string, string | boolean | null> = {}): SourceRow {
	return {
		kind: "meeting",
		id: m.id,
		label: m.displayTitle,
		fields: {
			type: m.type,
			status: m.status,
			when: localWhen(m.startsAt, m.zone),
			date: m.localDate,
			time: m.localTime,
			zone: m.zone,
			venue: m.venue?.name ?? null,
			team: m.team?.name ?? null,
			guests: String(m.guestCount),
			rsvpYes: String(m.confirmedCount),
			...extra,
		},
	};
}
