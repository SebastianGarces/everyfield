import { openLatestConversation, pipelineListsPeople } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// The launcher and the panel reopen the actor's latest conversation in this context, in one statement; they never
// create one. An organization seat whose Pipeline page lists people also hears so, in one more statement, and its empty
// panel suggests a pipeline question.
export const GET = () =>
	evryResponse(async (db, actor) => ({
		...((await openLatestConversation(db, actor)) ?? { conversation: null }),
		pipeline: await pipelineListsPeople(db, actor),
	}));
