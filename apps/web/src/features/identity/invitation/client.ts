import type { Reply } from "../server";
import type { InvitationRead } from "./handler";

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
