import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { recordId } from "@everyfield/contracts/common";
import {
	type ChurchDocument,
	type ChurchSummary,
	type ChurchTemplateSummary,
	type DocBrands,
	type DocDocument,
	type SavedExport,
} from "@everyfield/contracts/documents";
import { privateStorage } from "@everyfield/db/schema";
import type { RequestActor } from "@everyfield/domain/access";
import { documentsWriter, docTemplateSummaries, sheetOf, type DocTemplateSummary } from "@everyfield/domain/documents";
import "server-only";
import { canEditDocuments, documentActor, hasPlantSeat } from "../server.ts";
import { EXPORT_MESSAGES } from "./refusal.ts";

// The Church Documents reads. The library is one statement; a document page is three, run together: the document, its
// saved exports and its revisions.
// The PDF bytes are a separate request (churchFileRoute), so the page never waits for a render.

export type ChurchView = {
	id: string;
	title: string;
	templateId: string;
	templateVersion: number;
	/** The church template's name when the document was made from one; null for a built-in template. */
	templateName: string | null;
	documentClass: ChurchDocument["documentClass"];
	revision: string;
	formats: ChurchDocument["formats"];
	/** The stored branding switch: later previews and exports paint the church theme when it is on and a kit exists. */
	useChurchBranding: boolean;
	/** The sheet the preview shows (not one card) and its cards per sheet. */
	page: { width: number; height: number; perSheet: number };
};
/** Where an Owner or Admin's document stands against its template; null when there is nothing to compare with. */
export type TemplateState = "behind" | "current" | null;
/**
 * One saved revision as the Revisions list shows it: its number, when it was saved, who saved it and the formats that
 * revision offers. `savedBy` is null once the saver no longer holds a seat in this church plant (D-105).
 */
export type RevisionRow = {
	number: number;
	recordedAt: string;
	savedBy: string | null;
	formats: readonly ChurchDocument["formats"][number][];
};
export type Load<T> = { status: "ok"; value: T } | { status: "refused" } | { status: "failed" };

/** An Owner or Admin of the church plant; a Member reads only. */
export const canManageChurch = (authority: RequestActor) => hasPlantSeat(authority) && canEditDocuments(authority);

export async function loadLibrary(
	authority: RequestActor,
): Promise<
	Load<{ documents: ChurchSummary[]; templates: DocTemplateSummary[]; churchTemplates: ChurchTemplateSummary[] }>
> {
	const db = requestDatabase();
	if (!db || !hasPlantSeat(authority)) return db ? { status: "refused" } : { status: "failed" };
	try {
		const reply = await documentsWriter.listChurch(db, authority, {});
		if (reply.status !== "ok") return { status: "refused" };
		return {
			status: "ok",
			value: {
				documents: reply.value.documents,
				templates: docTemplateSummaries(),
				churchTemplates: reply.value.templates,
			},
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

export async function loadChurchDocument(
	authority: RequestActor,
	documentId: string,
): Promise<
	Load<{
		view: ChurchView;
		document: DocDocument;
		brands: DocBrands | null;
		mergeValues: Record<string, string>;
		template: TemplateState;
		exports: SavedExport[];
		/** The newest 1000 revisions, newest first. */
		revisions: RevisionRow[];
		/** True when the document has older revisions than `revisions` holds. */
		revisionsTruncated: boolean;
	}>
> {
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		// An Owner or Admin reads the document with both looks the PDF can paint (church and plain) in the same statement;
		// a Member reads the document alone, with its branding value, and gets no editor and no template status, so a
		// Member's page never learns of a template update. Every seat reads the saved exports and the revisions (D-141).
		const [reply, saved, history] = await Promise.all([
			canManageChurch(authority)
				? documentsWriter.readChurchForEdit(db, authority, { documentId })
				: documentsWriter
						.readChurch(db, authority, { documentId })
						.then((r) =>
							r.status === "ok" ? { ...r, value: { ...r.value, brands: null, mergeValues: {}, template: null } } : r,
						),
			documentsWriter.listExports(db, authority, { documentId }),
			documentsWriter["history.list"](db, authority, { documentId }),
		]);
		if (reply.status !== "ok" || saved.status !== "ok" || history.status !== "ok") return { status: "refused" };
		const d = reply.value;
		return {
			status: "ok",
			value: {
				view: {
					id: d.id,
					title: d.title,
					templateId: d.templateId,
					templateVersion: d.templateVersion,
					templateName: d.templateName,
					documentClass: d.documentClass,
					revision: d.revision,
					formats: d.formats,
					useChurchBranding: d.useChurchBranding,
					page: sheetOf(d.body.page),
				},
				document: d.body,
				brands: d.brands,
				mergeValues: d.mergeValues,
				exports: saved.value.exports,
				revisions: history.value.revisions
					.map((r) => ({ number: r.number, recordedAt: r.recordedAt, savedBy: r.authorName, formats: r.formats }))
					.toSorted((a, b) => b.number - a.number),
				revisionsTruncated: history.value.truncated,
				template: d.template,
			},
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

const NO_STORE = { "Cache-Control": "private, no-store" };
const gone = (status = 404) => new Response("This document is not available.", { status, headers: NO_STORE });

/**
 * GET /documents/church/{id}/file?format=pdf[&revision=n]: the live preview, a fresh render that saves nothing (D-78).
 * Download saves an export instead and serves its stored bytes (`savedExportRoute`). The actor is read again here.
 */
export async function churchFileRoute(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
	const id = recordId.safeParse((await params).documentId);
	if (!id.success) return gone();
	const documentId = id.data;
	const url = new URL(request.url);
	const format = url.searchParams.get("format") ?? "pdf";
	const revision = url.searchParams.get("revision");
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return gone();
	try {
		const reply = await documentsWriter.readChurchFile(
			db,
			actor,
			{ documentId, format, ...(revision === null ? {} : { revision: Number(revision) }) },
			privateStorage(),
		);
		if (reply.status !== "ok") return gone(reply.error.code === "invalid_input" ? 400 : 404);
		const file = reply.value;
		return new Response(Buffer.from(file.bytes, "base64"), {
			headers: {
				...NO_STORE,
				"Content-Type": file.mediaType,
				"Content-Disposition": `inline; filename="${file.downloadName}"`,
				"X-Content-SHA256": file.digest,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "file_failed", error: String(error) }));
		return gone(500);
	}
}

/**
 * GET /documents/church/{id}/exports/{exportId}: the stored bytes of one saved export, never rendered again (DOC-003).
 * Another church plant, a seatless account and an unknown id get not found. The actor is read again here.
 */
export async function savedExportRoute(
	_request: Request,
	{ params }: { params: Promise<{ documentId: string; exportId: string }> },
) {
	const raw = await params;
	const documentId = recordId.safeParse(raw.documentId);
	const exportId = recordId.safeParse(raw.exportId);
	if (!documentId.success || !exportId.success) return gone();
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return gone();
	try {
		const reply = await documentsWriter.readExportFile(
			db,
			actor,
			{ documentId: documentId.data, exportId: exportId.data },
			privateStorage(),
		);
		if (reply.status !== "ok") return gone();
		const file = reply.value;
		return new Response(Buffer.from(file.bytes, "base64"), {
			headers: {
				...NO_STORE,
				"Content-Type": file.mediaType,
				"Content-Disposition": `attachment; filename="${file.downloadName}"`,
				"X-Content-SHA256": file.digest,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		console.error(
			JSON.stringify({ component: "church-documents", outcome: "export_file_failed", error: String(error) }),
		);
		return gone(500);
	}
}

export type ExportResult =
	{ status: "saved"; saved: SavedExport } | { status: "refused"; message: string } | { status: "lost" };
const BODY_MAX = 4 * 1024;
const answer = (result: ExportResult) => Response.json(result, { headers: NO_STORE });

/**
 * POST /documents/church/{id}/exports {revision, format, requestKey}: Download saves one export of the shown revision
 * (D-78, DOC-023) and answers with its record; the browser then downloads that record's stored bytes. Any seat that
 * reads the document exports (D-80). The same request key answers with the same export, so a double click or a retry
 * after a lost reply makes one. A route handler, not a server action: the action bundle serves the PDF fonts as web
 * assets, not files, so a render there fails. Only a same-origin request is accepted.
 */
export async function saveExportRoute(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return gone(403);
	if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return answer(refused("invalid_input"));
	const documentId = recordId.safeParse((await params).documentId);
	if (!documentId.success) return answer(refused("unavailable"));
	const body = (await request.json().catch(() => null)) as {
		revision?: unknown;
		format?: unknown;
		requestKey?: unknown;
	} | null;
	if (!body || typeof body.revision !== "string" || !/^[0-9]{1,7}$/.test(body.revision))
		return answer(refused("invalid_input"));
	const [actor, viewer] = await Promise.all([documentActor(), getViewer()]);
	const db = requestDatabase();
	if (!actor || !db) return answer({ status: "lost" });
	try {
		const reply = await documentsWriter.exportNative(
			db,
			actor,
			{
				documentId: documentId.data,
				revision: Number(body.revision),
				format: body.format,
				requestKey: body.requestKey,
			},
			privateStorage(),
		);
		if (reply.status !== "ok") return answer(refused(reply.error.code));
		const done = reply.value;
		return answer({
			status: "saved",
			saved: {
				id: done.id,
				documentId: documentId.data,
				revision: done.source?.revision ?? Number(body.revision),
				format: done.format,
				generatedAt: done.generatedAt,
				creatorName: viewer?.displayName || null,
				digest: done.digest,
				byteCount: done.byteCount,
				downloadName: done.downloadName,
			},
		});
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "export_failed", error: String(error) }));
		return answer({ status: "lost" });
	}
}

function refused(code: string): ExportResult {
	return { status: "refused", message: EXPORT_MESSAGES[code] ?? EXPORT_MESSAGES.unavailable! };
}
