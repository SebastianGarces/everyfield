import { submitTurn } from "@everyfield/evry";
import { drainTurns, evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// The turn runs after the response, inside this function's lifetime.
export const maxDuration = 300;
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => {
		const submitted = await submitTurn(db, actor, id, await request.json().catch(() => null));
		if (!submitted.replayed) drainTurns();
		return submitted;
	});
};
