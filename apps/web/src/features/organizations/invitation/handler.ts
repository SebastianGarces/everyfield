import "server-only";
import { command, invitationFor, namesFor, subjectFacts, viewerOf, type Reply } from "@/server/organizations";
import { z } from "zod";

// POST /api/connections/invitation, the relationship request page's only door to its emailed proof (rulings U1, D54,
// and the 2026-11-10 D54 clarification in decisions.md). The proof travels in the request body, never in an address or
// a server-function argument, so no request log, framework trace, development function log or replay payload holds
// it. Every call re-reads the session from the cookie. The shape follows /api/invitation (identity/invitation).

/** What the page shows for one emailed link. Invalid, unrelated, expired, answered and missing proofs read the same. */
export type RelationshipInvitationRead =
	| { kind: "signed_out" }
	| { kind: "unavailable" }
	| { kind: "invitation"; invitation: unknown; names: Record<string, string>; zone: string };

const request = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("read"), invitationId: z.string().max(200), proof: z.string().max(4096) }),
	z.strictObject({ op: z.literal("respond"), command: z.unknown() }),
]);
const LIMIT = 16384;
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const refused = (code: string): Reply<never> => ({ status: "refused", code });

/** The request behind an emailed link, for a signed-in account. */
async function read(invitationId: string, proof: string): Promise<RelationshipInvitationRead> {
	const w = await viewerOf();
	if (w.kind === "signed_out") return { kind: "signed_out" };
	if (w.kind !== "viewer") return { kind: "unavailable" };
	const invitation = await invitationFor(w.mount, w.authority, w.viewer, invitationId, proof);
	if (!invitation) return { kind: "unavailable" };
	const p = invitation.pair;
	// The receiving organization answers: its own time zone dates the request's expiry.
	const [names, facts] = await Promise.all([
		namesFor(w.mount.db, w.viewer, [p.organization.id, p.kind === "discovery" ? p.accountId : p.subject.id]),
		subjectFacts(w.mount.db, w.viewer),
	]);
	return { kind: "invitation", invitation, names, zone: facts.zone };
}

/** associations.respondInvitation for the signed-in account's selected organization. The adapter checks everything. */
async function respond(input: unknown): Promise<Reply<unknown>> {
	const w = await viewerOf();
	if (w.kind !== "viewer") return refused("unavailable");
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		// The adapter parses the command against the operation's own schema.
		w.mount.adapter["associations.respondInvitation"](tx, s, o, input as never),
	);
}

export async function relationshipInvitationRoute(incoming: Request): Promise<Response> {
	// A route handler has no built-in cross-site guard: only this site's own pages may call it.
	const origin = process.env.IDENTITY_ORIGIN;
	if (!origin || incoming.headers.get("origin") !== new URL(origin).origin) return json(refused("access_denied"), 403);
	if (incoming.headers.get("content-type")?.split(";")[0] !== "application/json")
		return json(refused("invalid_input"), 415);
	const text = await incoming.text();
	if (text.length > LIMIT) return json(refused("invalid_input"), 413);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return json(refused("invalid_input"), 400);
	}
	const body = request.safeParse(raw);
	if (!body.success) return json(refused("invalid_input"), 400);
	const v = body.data;
	return json(v.op === "read" ? await read(v.invitationId, v.proof) : await respond(v.command));
}
