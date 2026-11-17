import {
	acceptSeatInvitationRequest,
	invitationDescriptionResult,
	respondResidentInvitationRequest,
	type InvitationSubject,
} from "@everyfield/contracts/identity";
import type { z } from "zod";

export type Description = Extract<z.infer<typeof invitationDescriptionResult>, { status: "pending" }>;
export type SeatCommand = ReturnType<typeof acceptSeatInvitationRequest.parse>;
export type ResidentCommand = ReturnType<typeof respondResidentInvitationRequest.parse>;
export type Role = Extract<InvitationSubject, { purpose: "seat" }>["role"];

export const ROLE_TEXT: Record<Role, { name: string; withArticle: string; detail: string }> = {
	admin: {
		name: "Admin",
		withArticle: "an Admin",
		detail: "You can see people, meetings and tasks, and make changes.",
	},
	member: {
		name: "Member",
		withArticle: "a Member",
		detail: "You can read what your seat allows and work on tasks assigned to you.",
	},
};

export function formatExpiry(instant: string): string {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(instant));
}

export function joinTitle(d: Description): string {
	return d.subject.purpose === "seat" ? `Join ${d.workspaceName}` : `Link your account to ${d.workspaceName}`;
}

const HELD = "ef-invitation-held";
const JOINING = "ef-invitation-joining";

export type Held = { proof: string; workspaceName: string } & (
	{ kind: "seat"; command: SeatCommand } | { kind: "resident"; command: ResidentCommand }
);

export const tabStore = {
	held(proof: string): Held | null {
		try {
			const raw = sessionStorage.getItem(HELD);
			const value = raw ? (JSON.parse(raw) as Held) : null;
			return value && value.proof === proof ? value : null;
		} catch {
			return null;
		}
	},
	hold(value: Held) {
		sessionStorage.setItem(HELD, JSON.stringify(value));
	},
	release() {
		sessionStorage.removeItem(HELD);
	},
	joining(): string | null {
		return sessionStorage.getItem(JOINING);
	},
	setJoining(email: string | null) {
		if (email) sessionStorage.setItem(JOINING, email);
		else sessionStorage.removeItem(JOINING);
	},
};
