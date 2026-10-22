import "server-only";
import { requestDatabase } from "@/server/database";
import { drainPeopleImports } from "@/server/people/imports";
import { getViewer } from "@/server/request-context";
import { exportPeopleRequest, importReceiptRequest, type PeopleReply } from "@everyfield/contracts/people";
import { executeBulkImport, peopleCsv } from "@everyfield/domain/people";
import { listRequest, parseQuery } from "../model.ts";
import { read, type Viewer } from "../server.ts";
import { MAX_BYTES } from "./model.ts";

// The CSV routes under /api/people (REQ-PPL-018, REQ-PPL-019). They sit outside the /people proxy, which would cut a
// request body at 10 MB, so a 10 MiB file reaches the producer whole. Each rebuilds the viewer from the session; the
// producer rechecks the seat's authority in its own statement. Answers are JSON: ok with the value, refused with the
// producer's code (and the bad line for quoting), both with status 200 because the request itself worked, or 503 for a
// failed database call, which the screen reads as a lost reply. The CSV downloads answer 403 or 503 without a body. Import and receipt start the import worker after the answer, until the shared job executor exists (WP-050).

const NO_STORE = { "Cache-Control": "private, no-store" };
type Answer = { status: "ok"; value: unknown } | { status: "refused"; code: string; line?: number };
const json = (body: Answer) => Response.json(body, { headers: NO_STORE });
const lost = () => Response.json({ status: "lost" }, { status: 503, headers: NO_STORE });
const refused = (code: string) => json({ status: "refused", code });

function answer<T>(reply: PeopleReply<T> | { status: "failed" }, ok: (value: T) => unknown = (v) => v) {
	if (reply.status === "failed") return lost();
	if (reply.status === "refused") {
		const line = (reply.error.details as { line?: number } | undefined)?.line;
		return json({ status: "refused", code: reply.error.code, ...(line ? { line } : {}) });
	}
	return json({ status: "ok", value: ok(reply.value) });
}

async function viewer(): Promise<Viewer | null> {
	return (await getViewer())?.people ?? null;
}
/** The file limit plus form overhead. */
const BODY_LIMIT = MAX_BYTES + 64 * 1024;
/**
 * The request body, read from its stream and counted as it arrives: null once it passes `limit`, before the rest is
 * read into memory. A declared Content-Length above the limit is refused without reading at all.
 */
export async function boundedBody(request: Request, limit = BODY_LIMIT): Promise<Uint8Array<ArrayBuffer> | null> {
	if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body)
		for await (const chunk of request.body) {
			size += chunk.byteLength;
			// Leaving the loop early cancels the stream: the rest of the body is never read.
			if (size > limit) return null;
			chunks.push(chunk);
		}
	const body = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}

/** GET /api/people/import/template: the 12 import columns, header only. It holds no church data. */
export async function templateRoute() {
	if (!(await viewer())) return new Response(null, { status: 403, headers: NO_STORE });
	const file = peopleCsv.generateCsvTemplate();
	return new Response(file.text, {
		headers: {
			...NO_STORE,
			"Content-Type": file.mediaType,
			"Content-Disposition": `attachment; filename="${file.filename}"`,
		},
	});
}

/** POST /api/people/import/preview: the raw file bytes. Every row's outcome and duplicates; it writes nothing. */
export async function previewRoute(request: Request) {
	const v = await viewer();
	if (!v) return refused("access_denied");
	const file = await boundedBody(request);
	if (!file) return json({ status: "refused", code: "file_too_large" });
	return answer(await read(v, (tx, ctx) => peopleCsv.previewImport(tx, ctx, { file })));
}

/**
 * POST /api/people/import: a form with the same file and the reviewed choices under one request key. Repeating it
 * after a lost reply returns the saved receipt; after a partial import it retries the remaining rows.
 */
export async function importRoute(request: Request) {
	const v = await viewer();
	const db = requestDatabase();
	if (!v || !db) return refused("access_denied");
	const body = await boundedBody(request);
	if (!body) return json({ status: "refused", code: "file_too_large" });
	const type = request.headers.get("content-type") ?? "";
	const form = await new Response(body, { headers: { "content-type": type } }).formData().catch(() => null);
	const file = form?.get("file");
	const review = form?.get("review");
	if (!(file instanceof Blob) || typeof review !== "string") return json({ status: "refused", code: "invalid_input" });
	let parsed: unknown;
	try {
		parsed = JSON.parse(review);
	} catch {
		return json({ status: "refused", code: "invalid_input" });
	}
	const input = { ...(parsed as object), file: new Uint8Array(await file.arrayBuffer()) };
	try {
		const reply = await executeBulkImport(db, v.authority, input);
		if (reply.status === "ok") drainPeopleImports();
		return answer(reply);
	} catch (error) {
		console.error(JSON.stringify({ component: "people-import", outcome: "import_failed", error: String(error) }));
		return lost();
	}
}

/** The receipt for one import key, for the page and for the screen's polling. Null when the key is malformed. */
export function readReceipt(v: Viewer, requestKey: unknown) {
	const input = importReceiptRequest.safeParse({ requestKey });
	return input.success ? read(v, (tx, ctx) => peopleCsv.getImportReceipt(tx, ctx, input.data)) : null;
}

/** GET /api/people/import?key=: the import's outcome for each row, read again while it runs or after a lost reply. */
export async function receiptRoute(request: Request) {
	const v = await viewer();
	if (!v) return refused("access_denied");
	const reply = await readReceipt(v, new URL(request.url).searchParams.get("key"));
	if (!reply) return refused("unavailable");
	if (reply.status === "ok" && reply.value.status === "in_progress") drainPeopleImports();
	return answer(reply);
}

/** The export request for a People address: the directory's own filters, without paging or view. */
export function exportFilters(search: URLSearchParams) {
	const r = listRequest(parseQuery(search));
	return exportPeopleRequest.parse({
		...(r.search ? { search: r.search } : {}),
		stages: r.stages,
		sources: r.sources,
		tags: r.tags,
		tagOperator: r.tagOperator,
		...(r.adultClassification ? { adultClassification: r.adultClassification } : {}),
		commitment: r.commitment,
		archived: r.archived,
	});
}

/**
 * GET /api/people/export?<People address>: every person the directory's current filters match, as formula-safe CSV.
 * The receipt's counts and filters travel in headers, so the screen can say what the file holds.
 */
export async function exportRoute(request: Request) {
	const v = await viewer();
	if (!v) return new Response(null, { status: 403, headers: NO_STORE });
	const filters = exportFilters(new URL(request.url).searchParams);
	const reply = await read(v, (tx, ctx) => peopleCsv.exportPeople(tx, ctx, filters));
	if (reply.status !== "ok")
		return new Response(null, { status: reply.status === "failed" ? 503 : 403, headers: NO_STORE });
	const { text, filename, mediaType, receipt } = reply.value;
	return new Response(text, {
		headers: {
			...NO_STORE,
			"Content-Type": mediaType,
			"Content-Disposition": `attachment; filename="${filename}"`,
			"X-Export-Matched": String(receipt.matched),
			"X-Export-Returned": String(receipt.returned),
			"X-Export-Completeness": receipt.completeness,
		},
	});
}
