import { retryUnresolvedEffects } from "@everyfield/evry";
import { drainEffects, evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const POST = async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const retried = await retryUnresolvedEffects(db, actor, id);
		if (retried.retried) drainEffects();
		return retried;
	});
};
