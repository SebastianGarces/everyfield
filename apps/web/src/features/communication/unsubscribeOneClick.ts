import "server-only";

import { applyMessagesOptOut } from "@everyfield/domain/communication";
import { unsubscribeCall } from "./unsubscribe.ts";
import { tokenRoute } from "../../server/platform/boundary.ts";

const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export const POST = tokenRoute(async function POST(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const body = new URLSearchParams(await request.text());
	if (body.get("List-Unsubscribe") !== "One-Click") return reply(400);
	const token = (await params).token;
	const r = await unsubscribeCall(({ db, ring }) => applyMessagesOptOut(db, ring, () => new Date(), { token }));
	if (r.status === "lost") return reply(503);
	if (r.status === "refused") return reply(r.code === "unavailable" ? 404 : r.code === "invalid_input" ? 400 : 403);
	return reply(200);
});
