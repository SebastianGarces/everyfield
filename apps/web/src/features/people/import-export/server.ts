import "server-only";
import { requestDatabase } from "@/server/database";
import { drainPeopleImports } from "./drain";
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

function crossSite(request: Request) {
	const site = request.headers.get("sec-fetch-site");
	return site !== null && site !== "same-origin";
}

async function viewer(): Promise<Viewer | null> {
	return (await getViewer())?.people ?? null;
}
const BODY_LIMIT = importLimits.rows * 48 + 64 * 1024;
async function boundedBody(request: Request, limit = BODY_LIMIT): Promise<Uint8Array<ArrayBuffer> | null> {
	if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body)
		for await (const chunk of request.body) {
			size += chunk.byteLength;
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

async function jsonBody(request: Request): Promise<unknown> {
	const body = await boundedBody(request);
	if (!body) return undefined;
	try {
		return JSON.parse(new TextDecoder().decode(body)) as unknown;
	} catch {
		return undefined;
	}
}

async function importDeps(request: Request) {
	if (crossSite(request)) return refused("access_denied");
	const v = await viewer();
	const db = requestDatabase();
	if (!v || !db) return refused("access_denied");
	const storage = privateStorage();
	if (!storage) return refused("storage_unavailable");
	return { v, db, storage };
}

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

export function readReceipt(v: Viewer, requestKey: unknown) {
	const input = importReceiptRequest.safeParse({ requestKey });
	return input.success ? read(v, (tx, ctx) => peopleCsv.getImportReceipt(tx, ctx, input.data)) : null;
}

export async function receiptRoute(request: Request) {
	const v = await viewer();
	if (!v) return refused("access_denied");
	const reply = await readReceipt(v, new URL(request.url).searchParams.get("key"));
	if (!reply) return refused("unavailable");
	if (reply.status === "ok" && reply.value.status === "in_progress") drainPeopleImports();
	return answer(reply);
}

function exportFilters(search: URLSearchParams) {
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
