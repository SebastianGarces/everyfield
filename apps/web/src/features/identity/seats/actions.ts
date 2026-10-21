"use server";

import { z } from "zod";
import { invitationService } from "@/server/invitations";
import { namesFor, subjectFacts, viewerOf } from "@/server/organizations";
import { answer, refused, type Reply } from "../server";

// The Seats and invitations page's only doors (WP-008/ui ruling U1). The session and the one current seat come from
// the server for every call. Reads take the request actor (D59); every command goes through the shipped seat and
// invitation services, which check the actor's own authority again. The page never decides who may see or change a seat.

export type SeatsRead =
	| { status: "unavailable" }
	| {
			status: "ready";
			/** The current workspace, exactly as the commands take it. */
			workspace: unknown;
			kind: "plant" | "sending_church" | "sending_network";
			workspaceName: string;
			canManage: boolean;
			/** The workspace revision an invitation must carry, and its time zone for dates. */
			revision: string;
			zone: string;
			roster: unknown;
			/** Owners and Admins only: the pending invitations. */
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

/** The next page of the roster or of the pending invitations, after the last ID the screen holds. */
export async function readSeatsPage(list: "seats" | "invitations", after: string): Promise<Reply> {
	const w = await workspaceViewer();
	const service = invitationService();
	if (!w || !service) return refused("unavailable");
	const { mount, selected, authority } = w;
	return list === "seats"
		? answer(() => mount.seats.list(authority, { workspace: selected, after }))
		: answer(() => service.list(authority, { workspace: selected, after }));
}

/** What removing one seat needs (ruling D52): its open duties and who may take them, from the seat service. */
export async function readRemovalReview(seatId: string): Promise<Reply> {
	const w = await workspaceViewer();
	if (!w) return refused("unavailable");
	return answer(() => w.mount.seats.readRemoval(w.viewer.session, w.selected, { seatId }));
}

const operation = z.enum(["invite", "resend", "revoke", "appointAdmin", "demote", "remove"]);
export type SeatOperation = z.infer<typeof operation>;

/** One seat or invitation command for the current workspace, through its shipped service. */
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
		case "remove":
			return answer(() => mount.seats.remove(s, selected, command));
	}
}
