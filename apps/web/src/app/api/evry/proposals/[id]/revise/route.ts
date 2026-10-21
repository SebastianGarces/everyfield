import { reviseProposal } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => reviseProposal(db, actor, id, await request.json().catch(() => null)));
};
