import "server-only";

import { applyMessagesOptOut } from "@everyfield/domain/communication";
import { unsubscribeCall } from "./unsubscribe.ts";

// POST /unsubscribe/[token]/one-click: a mail client's one-click unsubscribe (RFC 8058) for a Messages email. It sends
// "List-Unsubscribe=One-Click" as a form body to the List-Unsubscribe URL; a GET never reaches this handler, so a
// scanner that follows links changes nothing. The token is the only authority (REQ-NTF-016).

const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
	const body = new URLSearchParams(await request.text());
	if (body.get("List-Unsubscribe") !== "One-Click") return reply(400);
	const token = (await params).token;
	const r = await unsubscribeCall(({ db, ring }) => applyMessagesOptOut(db, ring, () => new Date(), { token }));
	if (r.status === "lost") return reply(503);
	if (r.status === "refused") return reply(r.code === "unavailable" ? 404 : r.code === "invalid_input" ? 400 : 403);
	return reply(200);
}
