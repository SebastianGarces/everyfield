import "server-only";
import { call, notificationsMount } from "./server.ts";

// POST /email-preferences/[token]/one-click: the provider one-click unsubscribe (RFC 8058). A mail client sends
// "List-Unsubscribe=One-Click" as a form body to the List-Unsubscribe URL; a GET never reaches this handler, so a
// scanner that follows links changes nothing. The token is the only authority (REQ-NTF-012).

const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
	const body = new URLSearchParams(await request.text());
	if (body.get("List-Unsubscribe") !== "One-Click") return reply(400);
	// A deployment without opt-out keys has no email preferences: the link is not found here, and nothing changes.
	if (!notificationsMount()?.optOut) return reply(404);
	const token = (await params).token;
	const r = await call(({ db, producer }) => producer.applyEmailOptOut(db, { token }));
	if (r.status === "lost") return reply(503);
	if (r.status === "refused") return reply(r.code === "invalid_input" ? 400 : 403);
	return reply(r.value.expired ? 410 : 200);
}
