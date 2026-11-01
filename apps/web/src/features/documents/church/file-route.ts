import { recordId } from "@everyfield/contracts/common";
import "server-only";
import { churchFileResponse } from "./server.ts";

// GET /documents/church/{documentId}/file: the bytes of one revision, for the preview and every download.

export async function churchFileRoute(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
	const id = recordId.safeParse((await params).documentId);
	if (!id.success)
		return new Response("This document is not available.", { status: 404, headers: { "Cache-Control": "no-store" } });
	return churchFileResponse(request, id.data);
}
