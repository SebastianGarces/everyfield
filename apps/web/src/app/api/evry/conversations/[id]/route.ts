import { readConversation } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
export const GET = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse((db, actor) =>
		readConversation(db, actor, id, Number(new URL(request.url).searchParams.get("after") ?? 0)),
	);
};
