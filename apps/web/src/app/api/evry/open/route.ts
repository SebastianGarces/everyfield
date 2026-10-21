import { latestConversation, readConversation } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// The launcher and the panel reopen the actor's latest conversation in this context; they never create one.
export const GET = () =>
	evryResponse(async (db, actor) => {
		const latest = await latestConversation(db, actor);
		return latest ? readConversation(db, actor, latest.id) : { conversation: null };
	});
