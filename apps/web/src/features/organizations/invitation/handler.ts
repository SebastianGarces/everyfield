import "server-only";
import { command, invitationFor, namesFor, subjectFacts, viewerOf, type Reply } from "../mount";
import { z } from "zod";

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

async function read(invitationId: string, proof: string): Promise<RelationshipInvitationRead> {
	const w = await viewerOf();
	if (w.kind === "signed_out") return { kind: "signed_out" };
	if (w.kind !== "viewer") return { kind: "unavailable" };
	const invitation = await invitationFor(w.mount, w.authority, w.viewer, invitationId, proof);
	if (!invitation) return { kind: "unavailable" };
	const p = invitation.pair;
	const [names, facts] = await Promise.all([
		namesFor(w.mount.db, w.viewer, [p.organization.id, p.kind === "discovery" ? p.accountId : p.subject.id]),
		subjectFacts(w.mount.db, w.viewer),
	]);
	return { kind: "invitation", invitation, names, zone: facts.zone };
}

async function respond(input: unknown): Promise<Reply<unknown>> {
	const w = await viewerOf();
	if (w.kind !== "viewer") return refused("unavailable");
	return command(w.mount, w.authority, w.viewer.selected, (tx, s, o) =>
		w.mount.adapter["associations.respondInvitation"](tx, s, o, input as never),
	);
}

export async function relationshipInvitationRoute(incoming: Request): Promise<Response> {
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
