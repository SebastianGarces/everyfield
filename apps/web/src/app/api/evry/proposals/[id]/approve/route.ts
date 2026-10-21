import { approveProposal } from "@everyfield/evry";
import { drainEffects, evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// The approved effect runs after the response, inside this function's lifetime.
export const maxDuration = 60;
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const approved = await approveProposal(db, actor, id, await request.json().catch(() => null));
		if (!approved.replayed) drainEffects();
		return approved;
	});
};
