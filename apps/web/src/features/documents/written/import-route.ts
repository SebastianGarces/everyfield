import { requestDatabase } from "@/server/database";
import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE } from "@everyfield/contracts/documents";
import { privateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import "server-only";
import type { DocumentOutcome } from "../actions.ts";
import { writtenView, type WrittenView } from "../model.ts";
import { documentActor } from "../server.ts";

// POST /documents/written/import?title=&format=&expectedRevision=&requestKey=[&documentId=] with the file's raw bytes as
// the body. A server action caps its body at the host's action limit, so import has its own route, as preview and
// export do. The original bytes stay private; the reply is the written document as its new saved revision.

const NO_STORE = { "Cache-Control": "private, no-store" };
const answer = (outcome: DocumentOutcome<WrittenView>) => Response.json(outcome, { headers: NO_STORE });
const tooLarge = () => answer({ status: "refused", code: "invalid_input", problem: IMPORT_TOO_LARGE });

/** The body's bytes, or null once it passes `max`: a body with no length header is counted as it arrives. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = request.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}

export async function importRoute(request: Request) {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return new Response(null, { status: 403, headers: NO_STORE });
	if (Number(request.headers.get("content-length") ?? 0) > IMPORT_BYTES_MAX) return tooLarge();
	let bytes: Uint8Array | null;
	try {
		bytes = await readCapped(request, IMPORT_BYTES_MAX);
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
}
