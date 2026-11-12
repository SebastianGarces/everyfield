import type { OrganizationOperations as Ops } from "@everyfield/contracts/organizations";
import type { Reply } from "@/server/organizations";
import type { RelationshipInvitationRead } from "./handler.ts";

// The browser side of POST /api/connections/invitation. A failed request or a server error throws, so the screen treats
// it as a lost reply; a refusal arrives as data.

type Respond = Ops["associations.respondInvitation"];

async function post<T>(body: unknown): Promise<T> {
	const response = await fetch("/api/connections/invitation", {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error("unavailable");
	return (await response.json()) as T;
}

export const readRelationshipInvitation = (invitationId: string, proof: string) =>
	post<RelationshipInvitationRead>({ op: "read", invitationId, proof });
/** associations.respondInvitation: the command holds the proof, so it rides in the body like the read. */
export const respondRelationshipInvitation = (command: Respond["input"]) =>
	post<Reply<Respond["output"]>>({ op: "respond", command });
