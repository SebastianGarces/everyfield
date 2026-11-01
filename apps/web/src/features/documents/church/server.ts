import { requestDatabase } from "@/server/database";
import { pageBox, type ChurchDocument, type ChurchSummary } from "@everyfield/contracts/documents";
import { privateStorage } from "@everyfield/db/schema";
import type { RequestActor } from "@everyfield/domain/access";
import { documentsWriter, docTemplateSummaries, type DocTemplateSummary } from "@everyfield/domain/documents";
import "server-only";
import { canEditDocuments, documentActor, hasPlantSeat } from "../server.ts";

// The Church Documents reads. The library is one statement; a document page is one statement. The PDF bytes are a
// separate request (file-route.ts), so the page never waits for a render.

export type ChurchView = {
	id: string;
	title: string;
	templateId: string;
	templateVersion: number;
	documentClass: ChurchDocument["documentClass"];
	revision: string;
	formats: ChurchDocument["formats"];
	/** Cards per sheet for a tiled document, else 1. The preview shows the sheet, not one card. */
	perSheet: number;
	page: { width: number; height: number };
};
export type LibraryEntry = Pick<ChurchSummary, "id" | "title" | "templateId" | "templateVersion" | "documentClass" | "updatedAt">;

export type Load<T> = { status: "ok"; value: T } | { status: "refused" } | { status: "failed" };

/** An Owner or Admin of the church plant; a Member reads only. */
export const canManageChurch = (authority: RequestActor) => hasPlantSeat(authority) && canEditDocuments(authority);

export async function loadLibrary(
	authority: RequestActor,
): Promise<Load<{ documents: LibraryEntry[]; templates: DocTemplateSummary[] }>> {
	const db = requestDatabase();
	if (!db || !hasPlantSeat(authority)) return db ? { status: "refused" } : { status: "failed" };
	try {
		const reply = await documentsWriter.listChurch(db, authority, {});
		if (reply.status !== "ok") return { status: "refused" };
		return {
			status: "ok",
			value: {
				documents: reply.value.documents.map((d) => ({
					id: d.id,
					title: d.title,
					templateId: d.templateId,
					templateVersion: d.templateVersion,
					documentClass: d.documentClass,
					updatedAt: d.updatedAt,
				})),
				templates: docTemplateSummaries(),
			},
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

export async function loadChurchDocument(authority: RequestActor, documentId: string): Promise<Load<ChurchView>> {
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		const reply = await documentsWriter.readChurch(db, authority, { documentId });
		if (reply.status !== "ok") return { status: "refused" };
		const d = reply.value;
		const tile = d.body.page.tile;
		const page = pageBox(d.body.page) ?? { width: 612, height: 792 };
		return {
			status: "ok",
			value: {
				id: d.id,
				title: d.title,
				templateId: d.templateId,
				templateVersion: d.templateVersion,
				documentClass: d.documentClass,
				revision: d.revision,
				formats: d.formats,
				perSheet: tile ? tile.across * tile.down : 1,
				page,
			},
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

const FORMATS = new Set(["pdf", "docx", "xlsx"]);
const NO_STORE = { "Cache-Control": "private, no-store" };
const gone = (status = 404) => new Response("This document is not available.", { status, headers: NO_STORE });

/**
 * GET /documents/church/{id}/file?format=pdf[&revision=n][&download=1]. The preview and every download call the same
 * domain read, so the preview is the file Download gives. The actor is read again here.
 */
export async function churchFileResponse(request: Request, documentId: string) {
	const url = new URL(request.url);
	const format = url.searchParams.get("format") ?? "pdf";
	const revisionText = url.searchParams.get("revision");
	const revision = revisionText === null ? undefined : Number(revisionText);
	if (!FORMATS.has(format) || (revision !== undefined && !Number.isInteger(revision))) return gone(400);
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return gone();
	try {
		const reply = await documentsWriter.readChurchFile(
			db,
			actor,
			{ documentId, format, ...(revision === undefined ? {} : { revision }) },
			privateStorage(),
		);
		if (reply.status !== "ok") return gone(reply.error.code === "invalid_input" ? 400 : 404);
		const file = reply.value;
		const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
		return new Response(Buffer.from(file.bytes, "base64"), {
			headers: {
				...NO_STORE,
				"Content-Type": file.mediaType,
				"Content-Disposition": `${disposition}; filename="${file.downloadName}"`,
				"X-Content-SHA256": file.digest,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "file_failed", error: String(error) }));
		return gone(500);
	}
}
