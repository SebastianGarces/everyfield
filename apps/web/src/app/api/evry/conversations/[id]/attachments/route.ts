import { privateStorage } from "@everyfield/db/schema";
import { stageAttachment } from "@everyfield/evry";
import { evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// POST /api/evry/conversations/{id}/attachments: signs one write-once upload of a CSV into this conversation of the
// request's own actor. The browser then puts the file's exact bytes to the signed URL; no request to the app carries
// the file. The staged file is usable only in this conversation and is deleted 24 hours later.
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) =>
		stageAttachment(db, privateStorage(), actor, id, await request.json().catch(() => null)),
	);
};
