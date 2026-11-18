import { tenantOwner } from "@everyfield/contracts/access";
import { invitationListResult, seatListResult } from "@everyfield/contracts/identity";
import type { z } from "zod";
import type { SeatsRead } from "./actions";
import { formatDay } from "../../../components/dates.ts";

export type Roster = z.infer<typeof seatListResult>;
export type Seat = Roster["items"][number];
export type Invitations = z.infer<typeof invitationListResult>;
export type PendingInvitation = Invitations["items"][number];
export type WorkspaceKind = "plant" | "sending_church" | "sending_network";

export const ROLE_NAME: Record<Seat["role"], string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function formatMoment(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(instant));
}

export function joinedText(seat: Seat, zone: string): string {
	return seat.joined.source === "accepted_invitation"
		? `Joined ${formatDay(seat.joined.at, zone)}`
		: `Original account · created ${formatDay(seat.joined.at, zone)}`;
}

export function invitationText(invitation: PendingInvitation, zone: string): string {
	const what = invitation.subject.purpose === "seat" ? ROLE_NAME[invitation.subject.role] : "Residency link";
	return `${what} · expires ${formatDay(invitation.expiresAt, zone)}`;
}

export function emailProblem(value: string, valid: boolean): string | undefined {
	if (!value.trim()) return "Enter the email address of the person you are inviting.";
	if (value.trim().length > 320 || !valid) return "Enter a full email address, like name@church.org.";
	return undefined;
}

export function placeWord(kind: WorkspaceKind): string {
	return kind === "sending_network" ? "network" : "church";
}

export type SeatsData = {
	workspace: z.infer<typeof tenantOwner>;
	kind: WorkspaceKind;
	workspaceName: string;
	canManage: boolean;
	revision: string;
	zone: string;
	roster: Roster;
	invitations: Invitations | null;
};

export function parseSeats(read: Extract<SeatsRead, { status: "ready" }>): SeatsData {
	return {
		workspace: tenantOwner.parse(read.workspace),
		kind: read.kind,
		workspaceName: read.workspaceName,
		canManage: read.canManage,
		revision: read.revision,
		zone: read.zone,
		roster: seatListResult.parse(read.roster),
		invitations: read.invitations === null ? null : invitationListResult.parse(read.invitations),
	};
}

const mapSeat = (d: SeatsData, seatId: string, change: (s: Seat) => Seat): SeatsData => ({
	...d,
	roster: { ...d.roster, items: d.roster.items.map((s) => (s.seatId === seatId ? change(s) : s)) },
});

export function withRole(
	d: SeatsData,
	seatId: string,
	role: "admin" | "member",
	revision: Seat["revision"],
): SeatsData {
	return mapSeat(d, seatId, (s) => ({
		...s,
		role,
		revision,
		allowedActions: s.allowedActions.length
			? role === "admin"
				? ["demote", "remove"]
				: ["appoint_admin", "remove"]
			: [],
	}));
}

export function withOwnDemotion(d: SeatsData, seatId: string, revision: Seat["revision"]): SeatsData {
	return {
		...d,
		canManage: false,
		invitations: null,
		roster: {
			...d.roster,
			items: d.roster.items.map((s) =>
				s.seatId === seatId ? { ...s, role: "member", revision, allowedActions: [] } : { ...s, allowedActions: [] },
			),
		},
	};
}

export function withRemoved(d: SeatsData, seatId: string, revision: Seat["revision"]): SeatsData {
	return mapSeat(d, seatId, (s) => ({ ...s, status: "removed", revision, allowedActions: [] }));
}

export function withInvitation(d: SeatsData, invitation: PendingInvitation): SeatsData {
	if (!d.invitations) return d;
	const items = d.invitations.items;
	const known = items.some((i) => i.invitationId === invitation.invitationId);
	return {
		...d,
		invitations: {
			...d.invitations,
			items: known
				? items.map((i) => (i.invitationId === invitation.invitationId ? invitation : i))
				: [invitation, ...items],
		},
	};
}

export function withoutInvitation(d: SeatsData, invitationId: string): SeatsData {
	if (!d.invitations) return d;
	return {
		...d,
		invitations: { ...d.invitations, items: d.invitations.items.filter((i) => i.invitationId !== invitationId) },
	};
}

export function withPage(
	d: SeatsData,
	page: { list: "seats"; value: Roster } | { list: "invitations"; value: Invitations },
) {
	const add = <T>(held: T[], more: T[], id: (t: T) => string) => {
		const ids = new Set(held.map(id));
		return [...held, ...more.filter((t) => !ids.has(id(t)))];
	};
	if (page.list === "seats")
		return {
			...d,
			roster: { ...page.value, items: add(d.roster.items, page.value.items, (s) => s.seatId) },
		};
	if (!d.invitations) return d;
	return {
		...d,
		invitations: { ...page.value, items: add(d.invitations.items, page.value.items, (i) => i.invitationId) },
	};
}
