import "server-only";
import { describeInvitationRequest, invitationDescriptionResult } from "@everyfield/contracts/identity";
import { z } from "zod";
import { invitationService } from "@/server/invitations";
import { answer, currentSession, refused, type Reply } from "../server";

// POST /api/invitation, the invitation page's only door to the WP-008/api invitation service (rulings U1, D54). The
// proof travels in the request body, never in an address or a server-function argument, so no request log, framework
// trace or development function log holds it. Every call re-reads the session from the cookie.

export type InvitationRead = {
	/** The domain's own observation of the proof. Invalid, unrelated, expired, revoked and used proofs all read the same. */
	description: unknown;
	/** Who is looking on this device. Never says anything about the invited address. */
	session: "signed_out" | "pending_domain" | "active" | "unavailable";
};

const request = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("read"), proof: z.string() }),
	z.strictObject({ op: z.literal("accept_seat"), command: z.unknown() }),
	z.strictObject({ op: z.literal("respond_resident"), command: z.unknown() }),
]);
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

async function read(proof: string): Promise<InvitationRead> {
	const service = invitationService();
	const input = describeInvitationRequest.safeParse({ proof });
	const [description, session] = await Promise.all([
		service && input.success
			? service.describe(input.data)
			: Promise.resolve(invitationDescriptionResult.parse({ status: "unavailable" })),
		currentSession(),
	]);
	return {
		description,
		session: !session ? "unavailable" : session.status === "unauthenticated" ? "signed_out" : session.status,
	};
}

/** seats.acceptInvitation or residency.respondInvitation for the signed-in account. The domain checks everything. */
async function asSelf(call: (sessionId: string) => Promise<unknown>): Promise<Reply> {
	const session = await currentSession();
	if (!session) return refused("unavailable");
	if (session.status === "unauthenticated") return refused("unauthenticated");
	return answer(() => call(session.sessionId));
}

export async function invitationRoute(incoming: Request): Promise<Response> {
	// A route handler has no built-in cross-site guard: only this site's own pages may call it.
	const origin = process.env.IDENTITY_ORIGIN;
	if (!origin || incoming.headers.get("origin") !== new URL(origin).origin) return json(refused("access_denied"), 403);
	if (incoming.headers.get("content-type")?.split(";")[0] !== "application/json")
		return json(refused("invalid_input"), 415);
	const text = await incoming.text();
	if (text.length > 24576) return json(refused("invalid_input"), 413);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return json(refused("invalid_input"), 400);
	}
	const body = request.safeParse(raw);
	if (!body.success) return json(refused("invalid_input"), 400);
	const service = invitationService();
	if (!service) return json(refused("unavailable"), 503);
	const v = body.data;
	if (v.op === "read") return json(await read(v.proof));
	return json(
		await asSelf((session) =>
			v.op === "accept_seat" ? service.accept(session, v.command) : service.respondResident(session, v.command),
		),
	);
}
