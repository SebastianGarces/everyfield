import { openLatestConversation, pipelineListsPeople } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const GET = () =>
	evryResponse(async (db, actor) => ({
		...((await openLatestConversation(db, actor)) ?? { conversation: null }),
		pipeline: await pipelineListsPeople(db, actor),
	}));
