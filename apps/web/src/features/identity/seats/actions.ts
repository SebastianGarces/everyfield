"use server";

import { z } from "zod";
import { invitationService } from "@/server/invitations";
import { tasksMount } from "../../tasks/mount.ts";
import { answer, refused, type Reply } from "../server";
import { loadSeats, workspaceViewer, type SeatsRead } from "./server";

export async function readSeats(): Promise<SeatsRead> {
	return loadSeats();
}

export async function readSeatsPage(list: "seats" | "invitations", after: string): Promise<Reply> {
	const w = await workspaceViewer();
	const service = invitationService();
	if (!w || !service) return refused("unavailable");
	const { mount, selected, authority } = w;
	return list === "seats"
		? answer(() => mount.seats.list(authority, { workspace: selected, after }))
		: answer(() => service.list(authority, { workspace: selected, after }));
}

export async function readRemovalReview(seatId: string): Promise<Reply> {
	const w = await workspaceViewer();
	if (!w) return refused("unavailable");
	return answer(() => w.mount.seats.readRemoval(w.viewer.session, w.selected, { seatId }));
}

const operation = z.enum(["invite", "resend", "revoke", "appointAdmin", "demote", "remove"]);
export type SeatOperation = z.infer<typeof operation>;

export async function runSeatCommand(name: SeatOperation, command: unknown): Promise<Reply> {
	const op = operation.safeParse(name);
	const w = await workspaceViewer();
	const service = invitationService();
	if (!op.success || !w || !service) return refused("unavailable");
	const { mount, selected } = w;
	const s = w.authority;
	switch (op.data) {
		case "invite":
			return answer(() => service.invite(s, command));
		case "resend":
			return answer(() => service.resend(s, command));
		case "revoke":
			return answer(() => service.revoke(s, command));
		case "appointAdmin":
			return answer(() => mount.seats.appointAdmin(s, selected, command));
		case "demote":
			return answer(() => mount.seats.demote(s, selected, command));
		case "remove": {
			const reminders = tasksMount()?.reminders;
			if (!reminders) return refused("unavailable");
			return answer(() => mount.seats.remove(s, selected, command, reminders));
		}
	}
}
