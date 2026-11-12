import "server-only";
import { requestDatabase } from "@/server/database";
import { drainPeopleImports } from "@/server/people/imports";
import { getViewer } from "@/server/request-context";
import {
	exportPeopleRequest,
	importLimits,
	importReceiptRequest,
	type PeopleReply,
} from "@everyfield/contracts/people";
import { privateStorage } from "@everyfield/db/schema";
import {
	executeStoredImport,
	peopleCsv,
	previewStoredImport,
	retryStoredImport,
	signPeopleImport,
} from "@everyfield/domain/people";
import { listRequest, parseQuery } from "../model.ts";
import { read, type Viewer } from "../server.ts";

// The CSV routes under /api/people (REQ-PPL-018, REQ-PPL-019). No request here carries the import file: the browser puts
// it once into the private bucket with the URL the upload route signs, and the preview and the import name that upload,
// so the server reads the stored object itself (REQ-PPL-014's private-file flow). A function's request and reply bodies
// are capped well under 10 MiB on the host, so the preview, which lists every row, streams its reply. Each route rebuilds
// the viewer from the session; the producer rechecks the seat's authority in its own statement. Answers are JSON: ok
// with the value, refused with the producer's code (and the bad line for quoting), both with status 200 because the
// request itself worked, or 503 for a failed database call, which the screen reads as a lost reply. The CSV downloads
// answer 403 or 503 without a body. Import and receipt start the import worker after the answer, until the shared job
// executor exists (WP-050).

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

/**
 * Whether a browser sent this request from another site. The import posts write and read church data, so only a
 * same-origin request is accepted; a request without the header (an older browser or a script) is allowed, as in
 * saveExportRoute.
 */
function crossSite(request: Request) {
	const site = request.headers.get("sec-fetch-site");
	return site !== null && site !== "same-origin";
}

async function viewer(): Promise<Viewer | null> {
	return (await getViewer())?.people ?? null;
}
/** The reviewed choice of every row the contract allows (about 31 bytes each as JSON) and the rest of the request. */
const BODY_LIMIT = importLimits.rows * 48 + 64 * 1024;
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

/** A JSON reply sent in pieces: the host caps a reply it holds whole, and a full preview is about the file's size. */
function streamed(body: Answer) {
	const text = new TextEncoder().encode(JSON.stringify(body));
	const PIECE = 256 * 1024;
	let at = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= text.length) return controller.close();
			controller.enqueue(text.subarray(at, (at += PIECE)));
		},
	});
	return new Response(stream, { headers: { ...NO_STORE, "Content-Type": "application/json" } });
}

/** A small JSON request body (an upload id, or the reviewed choices), read within BODY_LIMIT; undefined when not JSON. */
async function jsonBody(request: Request): Promise<unknown> {
	const body = await boundedBody(request);
	if (!body) return undefined;
	try {
		return JSON.parse(new TextDecoder().decode(body)) as unknown;
	} catch {
		return undefined;
	}
}

/** The viewer, database and private bucket an import route needs, or the refusal the screen shows without them. */
async function importDeps(request: Request) {
	if (crossSite(request)) return refused("access_denied");
	const v = await viewer();
	const db = requestDatabase();
	if (!v || !db) return refused("access_denied");
	const storage = privateStorage();
	if (!storage) return refused("storage_unavailable");
	return { v, db, storage };
}

/**
 * POST /api/people/import/upload: `{ byteLength }`. A five-minute URL that puts this one file straight into the private
 * bucket; a file over the limit is refused before anything is uploaded.
 */
export async function uploadRoute(request: Request) {
	const deps = await importDeps(request);
	if (deps instanceof Response) return deps;
	const input = await jsonBody(request);
	try {
		return answer(await signPeopleImport(deps.db, deps.storage, deps.v.authority, input));
	} catch (error) {
		console.error(JSON.stringify({ component: "people-import", outcome: "sign_failed", error: String(error) }));
		return lost();
	}
}

/** POST /api/people/import/preview: `{ uploadId }`. Every row's outcome and duplicates in the stored file; it writes nothing. */
export async function previewRoute(request: Request) {
	const deps = await importDeps(request);
	if (deps instanceof Response) return deps;
	const input = await jsonBody(request);
	try {
		const reply = await previewStoredImport(deps.db, deps.storage, deps.v.authority, input);
		if (reply.status !== "ok") return answer(reply);
		return streamed({ status: "ok", value: reply.value });
	} catch (error) {
		console.error(JSON.stringify({ component: "people-import", outcome: "preview_failed", error: String(error) }));
		return lost();
	}
}

/**
 * POST /api/people/import: the same upload and the reviewed choices under one request key, as JSON. Repeating it
 * after a lost reply returns the saved receipt.
 */
export async function importRoute(request: Request) {
	const deps = await importDeps(request);
	if (deps instanceof Response) return deps;
	const input = await jsonBody(request);
	try {
		const reply = await executeStoredImport(deps.db, deps.storage, deps.v.authority, input);
		if (reply.status === "ok") drainPeopleImports();
		return answer(reply);
	} catch (error) {
		console.error(JSON.stringify({ component: "people-import", outcome: "import_failed", error: String(error) }));
		return lost();
	}
}

/**
 * POST /api/people/import/retry: `{ requestKey, uploadId? }`. "Try N rows again" for a partial import: from the server's
 * kept copy, or, once that is deleted, from the same file uploaded again.
 */
export async function retryRoute(request: Request) {
	const deps = await importDeps(request);
	if (deps instanceof Response) return deps;
	const input = await jsonBody(request);
	try {
		const reply = await retryStoredImport(deps.db, deps.storage, deps.v.authority, input);
		if (reply.status === "ok") drainPeopleImports();
		return answer(reply);
	} catch (error) {
		console.error(JSON.stringify({ component: "people-import", outcome: "retry_failed", error: String(error) }));
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
