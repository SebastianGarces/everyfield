import "server-only";
import { requestDatabase } from "@/server/database";
import * as c from "@everyfield/contracts/people";
import { privateStorage } from "@everyfield/db/schema";
import { commitments, uploadCommitmentDocument } from "@everyfield/domain/people";
import { boundary, invalid, outcome } from "../boundary.ts";
import { peopleContext } from "../fields/server.ts";
import type { Outcome } from "../model.ts";
import { write } from "../server.ts";

// POST /api/people/{personId}/commitment-document: the raw bytes of a signed commitment card's document, typed by its
// Content-Type (REQ-PPL-014, C29). It asks for an upload, then verifies and stores the bytes privately, and answers with
// the upload the card attaches. A failed upload attaches nothing; the pending object is cleaned up on its own. The
// browser keeps the upload, so a retried save never uploads the file twice.
//
// A route handler, not a server action: a server action body stops at 1 MB, and the /people proxy cuts a body at 10 MB,
// so a 10 MiB file could never arrive whole. Answers are JSON with status 200 for ok and refused, or 503 for a failed
// database or storage call, which the card reads as a lost upload.

export async function POST(request: Request, { params }: { params: Promise<{ personId: string }> }) {
	const answer = await store(request, (await params).personId);
	return Response.json(answer, {
		status: answer.status === "lost" ? 503 : 200,
		headers: { "Cache-Control": "private, no-store" },
	});
}

async function store(request: Request, personId: string): Promise<Outcome<{ uploadId: string }>> {
	const mime = c.commitmentMime.safeParse(request.headers.get("content-type"));
	// A declared size over the limit is refused before the body is read into memory.
	if (!mime.success || Number(request.headers.get("content-length") ?? 0) > c.COMMITMENT_MAX_BYTES) return invalid;
	return boundary(c.personRequest, { personId }, async (v) => {
		const storage = privateStorage();
		const db = requestDatabase();
		if (!storage || !db) return { status: "refused", code: "storage_unavailable" };
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.length < 1 || bytes.length > c.COMMITMENT_MAX_BYTES) return invalid;
		const staged = outcome(
			await write(v, (tx, ctx) =>
				commitments.requestCommitmentUpload(tx, ctx, { personId, mime: mime.data, byteLength: bytes.length }),
			),
			(r) => r,
		);
		if (staged.status !== "ok") return staged;
		const stored = await uploadCommitmentDocument(db, storage, peopleContext(v), {
			uploadId: staged.value.uploadId,
			bytes,
		}).catch(() => ({ status: "failed" }) as const);
		if (stored.status === "failed") return { status: "lost" };
		if (stored.status === "refused") return { status: "refused", code: stored.error.code };
		return { status: "ok", value: { uploadId: staged.value.uploadId } };
	});
}
