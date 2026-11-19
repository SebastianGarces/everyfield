import "server-only";
import { invitationService } from "@/server/invitations";
import { namesFor, subjectFacts, viewerOf } from "../../organizations/mount";
import { answer } from "../server";

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

export type Workspace = NonNullable<Awaited<ReturnType<typeof workspaceViewer>>>;

export async function workspaceViewer() {
	const who = await viewerOf();
	if (who.kind !== "viewer") return null;
	const { viewer, mount } = who;
	if (viewer.selected.kind !== "plant" && viewer.selected.kind !== "organization") return null;
	if (viewer.kind !== "plant" && viewer.kind !== "sending_church" && viewer.kind !== "sending_network") return null;
	return { viewer, mount, authority: who.authority, kind: viewer.kind, selected: viewer.selected };
}

export async function loadSeats(w: Workspace | null): Promise<SeatsRead> {
	const service = invitationService();
	if (!w) return { status: "unavailable" };
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
