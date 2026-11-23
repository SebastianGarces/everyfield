import type { Reply } from "../server";
import type { InvitationRead } from "./handler";
import type { Held } from "./model";

async function post<T>(body: unknown): Promise<T> {
	const response = await fetch("/api/invitation", {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error("unavailable");
	return (await response.json()) as T;
}

export const readInvitation = (proof: string) => post<InvitationRead>({ op: "read", proof });
export const acceptSeatInvitation = (command: unknown) => post<Reply>({ op: "accept_seat", command });
export const respondResidentInvitation = (command: unknown) => post<Reply>({ op: "respond_resident", command });

const HELD = "ef-invitation-held";
const JOINING = "ef-invitation-joining";

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
