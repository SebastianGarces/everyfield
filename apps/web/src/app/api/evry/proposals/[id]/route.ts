import { readReview } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const GET = async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse((db, actor) => readReview(db, actor, id));
};
