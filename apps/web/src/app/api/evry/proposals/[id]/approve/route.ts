import { privateStorage } from "@everyfield/db/schema";
import { approveProposal } from "@everyfield/evry";
import { drainEffects, evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// The approved effect runs after the response, inside this function's lifetime.
export const maxDuration = 60;
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const approved = await approveProposal(db, actor, id, await request.json().catch(() => null), privateStorage());
		// A first approval starts its effect. Its projection cannot see the job its own statement queued, so it does not
		// say executing. A replay starts it too while it is still running: the first request's drain may never have run.
		if (!approved.replayed || approved.proposal.executing) drainEffects();
		return approved;
	});
};
