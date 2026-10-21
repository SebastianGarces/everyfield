import { retryTurn } from "@everyfield/evry";
import { drainTurns, evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const submitted = await retryTurn(db, actor, id, await request.json().catch(() => null));
		if (!submitted.replayed) drainTurns();
		return submitted;
	});
};
