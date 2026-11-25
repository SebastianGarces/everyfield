import { requestDatabase } from "@/server/database";
import { viewerActor } from "@/server/request-context";
import { recordId } from "@everyfield/contracts/common";
import { privateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import "server-only";
import { transient } from "../../server/platform/transient.ts";

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const gone = (status = 404) => new Response("This file is not available.", { status, headers: NO_STORE });

export async function savedFileRoute(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
	const documentId = recordId.safeParse((await params).documentId);
	const actor = documentId.success ? await viewerActor() : null;
	if (!actor) return gone();
	return transient(
		{ component: "documents", outcome: "file_download_failed" },
		async () => {
			const reply = await documentsWriter.download(
				requestDatabase(),
				actor,
				{ documentId: documentId.data },
				privateStorage(),
			);
			if (reply.status !== "ok") return gone();
			return new Response(null, { status: 303, headers: { ...NO_STORE, Location: reply.value.url } });
		},
		gone(503),
	);
}
