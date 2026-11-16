"use server";

import { z } from "zod";
import { invitationService } from "@/server/invitations";
import { namesFor, subjectFacts, viewerOf } from "@/server/organizations";
import { tasksMount } from "@/server/tasks";
import { answer, refused, type Reply } from "../server";

export type SeatsRead =
	| { status: "unavailable" }
	| {
			status: "ready";
			workspace: unknown;
			kind: "plant" | "sending_church" | "sending_network";
			workspaceName: string;
			canManage: boolean;
			revision: string;
			zone: string;
			roster: unknown;
			invitations: unknown;
	  };

async function workspaceViewer() {
	const who = await viewerOf();
	if (who.kind !== "viewer") return null;
	const { viewer, mount } = who;
	if (viewer.selected.kind !== "plant" && viewer.selected.kind !== "organization") return null;
	if (viewer.kind !== "plant" && viewer.kind !== "sending_church" && viewer.kind !== "sending_network") return null;
	return { viewer, mount, authority: who.authority, kind: viewer.kind, selected: viewer.selected };
}

export async function readSeats(): Promise<SeatsRead> {
	const w = await workspaceViewer();
	const service = invitationService();
	if (!w || !service) return { status: "unavailable" };
	const { viewer, mount, selected, authority } = w;
	const [roster, invitations, facts, names] = await Promise.all([
		answer(() => mount.seats.list(authority, { workspace: selected })),
		viewer.canManage ? answer(() => service.list(authority, { workspace: selected })) : Promise.resolve(null),
		subjectFacts(mount.db, viewer),
		namesFor(mount.db, viewer, [selected.id]),
	]);
	if (roster.status !== "ok") return { status: "unavailable" };
	return {
		status: "ready",
		workspace: selected,
		kind: w.kind,
		workspaceName: names[selected.id] ?? "your workspace",
		canManage: viewer.canManage && invitations?.status === "ok",
		revision: facts.revision,
		zone: facts.zone,
		roster: roster.value,
		invitations: invitations?.status === "ok" ? invitations.value : null,
	};
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
