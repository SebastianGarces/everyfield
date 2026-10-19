"use server";

import { describeInvitationRequest, invitationDescriptionResult } from "@everyfield/contracts/identity";
import { invitationService } from "@/server/invitations";
import { answer, currentSession, refused, type Reply } from "../server";

// The invitation page's only doors to the WP-008/api invitation service (ruling U1). Each re-reads the session.

export type InvitationRead = {
	/** The domain's own observation of the proof. Invalid, unrelated, expired, revoked and used proofs all read the same. */
	description: unknown;
	/** Who is looking on this device. Never says anything about the invited address. */
	session: "signed_out" | "pending_domain" | "active" | "unavailable";
};

const UNAVAILABLE = invitationDescriptionResult.parse({ status: "unavailable" });

/** What the proof shows: the inviter, the workspace or organization, the role and the expiry (REQ-IDN-003). */
export async function readInvitation(proof: string): Promise<InvitationRead> {
	const service = invitationService();
	const input = describeInvitationRequest.safeParse({ proof });
	const [description, session] = await Promise.all([
		service && input.success ? service.describe(input.data) : Promise.resolve(UNAVAILABLE),
		currentSession(),
	]);
	return {
		description,
		session: !session ? "unavailable" : session.status === "unauthenticated" ? "signed_out" : session.status,
	};
}

async function asSelf(call: (sessionId: string) => Promise<unknown>): Promise<Reply> {
	const service = invitationService();
	if (!service) return refused("unavailable");
	const session = await currentSession();
	if (!session) return refused("unavailable");
	if (session.status === "unauthenticated") return refused("unauthenticated");
	return answer(() => call(session.sessionId));
}

/** seats.acceptInvitation for the signed-in account. The domain checks the address, proof, revision and seat. */
export async function acceptSeatInvitation(command: unknown): Promise<Reply> {
	return asSelf((session) => invitationService()!.accept(session, command));
}

/** residency.respondInvitation for the signed-in account: accept with the chosen sharing, or decline. */
export async function respondResidentInvitation(command: unknown): Promise<Reply> {
	return asSelf((session) => invitationService()!.respondResident(session, command));
}
