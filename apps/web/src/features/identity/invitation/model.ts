import {
	acceptSeatInvitationRequest,
	invitationDescriptionResult,
	respondResidentInvitationRequest,
	type InvitationSubject,
} from "@everyfield/contracts/identity";
import type { z } from "zod";

// Words and storage for the invitation page. Pure values only, so the screens and their checks share one source.

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

/** "Nov 18, 4:12 PM EST": the expiry is one instant, shown in the reader's own zone with the zone named. */
export function formatExpiry(instant: string): string {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(instant));
}

/** The words that name what the invitation gives, used in headings and buttons. */
export function joinTitle(d: Description): string {
	return d.subject.purpose === "seat" ? `Join ${d.workspaceName}` : `Link your account to ${d.workspaceName}`;
}

// The proof arrives in the fragment and stays in this tab only, so the page can remove it from the address bar and
// still find it after sign-in.
const PROOF = "ef-invitation-proof";
// An answer that was sent but not confirmed: the exact command, so a reload can resend it unchanged.
const HELD = "ef-invitation-held";
// Set after this page created the account, so the signed-in page can accept at once and knows the address.
const JOINING = "ef-invitation-joining";

export type Held = { proof: string; workspaceName: string } & (
	{ kind: "seat"; command: SeatCommand } | { kind: "resident"; command: ResidentCommand }
);

export const tabStore = {
	/** Keeps the link's proof in this tab and removes it from the address bar and history. */
	/** The proof from the link's fragment (#proof=...), or the one this tab kept after it cleaned the address. */
	proof(): string | null {
		return new URLSearchParams(window.location.hash.slice(1)).get("proof") ?? sessionStorage.getItem(PROOF);
	},
	/** Keeps the fragment's proof in this tab and removes it from the address bar and history. */
	keepProof() {
		const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("proof");
		if (!fromLink) return;
		sessionStorage.setItem(PROOF, fromLink);
		history.replaceState(null, "", window.location.pathname + window.location.search);
	},
	held(proof: string): Held | null {
		// The server render has no tab; it shows the loading state, and the tab's value is read on the client.
		if (typeof window === "undefined") return null;
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
