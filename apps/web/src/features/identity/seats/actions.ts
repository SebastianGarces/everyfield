"use server";

import { z } from "zod";
import { invitationService } from "@/server/invitations";
import { tasksMount } from "../../tasks/mount.ts";
import { answer, refused, type Reply } from "../server";
import { workspaceViewer } from "./server";

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
