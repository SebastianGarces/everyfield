import "server-only";
import { call, notificationsMount } from "./server.ts";
import { tokenRoute } from "../../server/platform/boundary.ts";

const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export const POST = tokenRoute(async function POST(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const body = new URLSearchParams(await request.text());
	if (body.get("List-Unsubscribe") !== "One-Click") return reply(400);
	if (!notificationsMount()?.optOut) return reply(404);
	const token = (await params).token;
	const r = await call(({ db, producer }) => producer.applyEmailOptOut(db, { token }));
	if (r.status === "lost") return reply(503);
	if (r.status === "refused") return reply(r.code === "invalid_input" ? 400 : 403);
	return reply(r.value.expired ? 410 : 200);
});
