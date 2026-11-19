import { requestDatabase } from "@/server/database";
import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE } from "@everyfield/contracts/documents";
import { privateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import { readBoundedBody } from "@everyfield/domain/operations";
import "server-only";
import type { DocumentOutcome } from "../outcome.ts";
import { writtenView, type WrittenView } from "../model.ts";
import { documentActor } from "../server.ts";
import { mutatingRoute } from "../../../server/platform/boundary.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const answer = (outcome: DocumentOutcome<WrittenView>) => Response.json(outcome, { headers: NO_STORE });
const tooLarge = () => answer({ status: "refused", code: "invalid_input", problem: IMPORT_TOO_LARGE });

export const importRoute = mutatingRoute(async function importRoute(request: Request) {
	let bytes: Uint8Array | null;
	try {
		bytes = await readBoundedBody(request, IMPORT_BYTES_MAX);
	} catch {
		return answer({ status: "lost" });
	}
	if (!bytes) return tooLarge();
	const query = new URL(request.url).searchParams;
	const documentId = query.get("documentId");
	const input = {
		title: query.get("title"),
		format: query.get("format"),
		bytes,
		expectedRevision: query.get("expectedRevision"),
		requestKey: query.get("requestKey"),
		...(documentId ? { documentId } : {}),
	};
	const storage = privateStorage();
	if (!storage)
		return answer({ status: "refused", code: "unavailable", problem: "Saving is not available right now." });
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return answer({ status: "lost" });
	try {
		const reply = await documentsWriter.importTextOrWord(db, actor, input, storage);
		if (reply.status === "refused") {
			const error = reply.error;
			const problem = error.code === "invalid_input" ? error.details.issues[0]?.problem : undefined;
			return answer(
				problem ? { status: "refused", code: error.code, problem } : { status: "refused", code: error.code },
			);
		}
		return answer({ status: "ok", value: writtenView(reply.value) });
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "import_failed", error: String(error) }));
		return answer({ status: "lost" });
	}
});
