import type { OrganizationOperations as Ops } from "@everyfield/contracts/organizations";
import type { Reply } from "@/server/organizations";
import type { RelationshipInvitationRead } from "./handler.ts";

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
export const respondRelationshipInvitation = (command: Respond["input"]) =>
	post<Reply<Respond["output"]>>({ op: "respond", command });
