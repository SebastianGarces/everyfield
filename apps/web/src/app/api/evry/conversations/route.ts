import { createConversation, listConversations } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const GET = (request: Request) =>
	evryResponse((db, actor) => {
		const url = new URL(request.url);
		return listConversations(db, actor, {
			search: url.searchParams.get("q") ?? undefined,
			page: Number(url.searchParams.get("page") ?? 1),
		});
	});
export const POST = (request: Request) =>
	evryResponse(async (db, actor) => createConversation(db, actor, await request.json().catch(() => null)));
