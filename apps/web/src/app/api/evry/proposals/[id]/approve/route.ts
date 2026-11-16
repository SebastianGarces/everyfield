import { privateStorage } from "@everyfield/db/schema";
import { approveProposal } from "@everyfield/evry";
import { drainEffects, evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const approved = await approveProposal(db, actor, id, await request.json().catch(() => null), privateStorage());
		if (!approved.replayed || approved.proposal.executing) drainEffects();
		return approved;
	});
};
