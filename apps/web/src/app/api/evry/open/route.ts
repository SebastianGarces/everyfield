import { openLatestConversation } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// The launcher and the panel reopen the actor's latest conversation in this context, in one statement; they never
// create one.
export const GET = () =>
	evryResponse(async (db, actor) => (await openLatestConversation(db, actor)) ?? { conversation: null });
