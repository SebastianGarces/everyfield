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
import { LOST, transient } from "@/server/platform/transient";

const NO_STORE = { "Cache-Control": "private, no-store" };
const answer = (outcome: DocumentOutcome<WrittenView>) => Response.json(outcome, { headers: NO_STORE });
const tooLarge = () => answer({ status: "refused", code: "invalid_input", problem: IMPORT_TOO_LARGE });

export const importRoute = mutatingRoute(async function importRoute(request: Request) {
	const bytes = await readBoundedBody(request, IMPORT_BYTES_MAX);
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
	if (!actor) return answer({ status: "refused", code: "access_denied" });
	const reply = await transient(
		{ component: "documents", outcome: "import_failed" },
		() => documentsWriter.importTextOrWord(requestDatabase(), actor, input, storage),
		LOST,
	);
	if (reply.status === "lost") return answer(reply);
	if (reply.status === "refused") {
		const error = reply.error;
		const problem = error.code === "invalid_input" ? error.details.issues[0]?.problem : undefined;
		return answer(problem ? { status: "refused", code: error.code, problem } : { status: "refused", code: error.code });
	}
	return answer({ status: "ok", value: writtenView(reply.value) });
});
