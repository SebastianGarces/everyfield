import { requestDatabase } from "@/server/database";
import { recordId } from "@everyfield/contracts/common";
import { type ChurchDocument, type ChurchSummary } from "@everyfield/contracts/documents";
import { privateStorage } from "@everyfield/db/schema";
import type { RequestActor } from "@everyfield/domain/access";
import { documentsWriter, docTemplateSummaries, sheetOf, type DocTemplateSummary } from "@everyfield/domain/documents";
import "server-only";
import { canEditDocuments, documentActor, hasPlantSeat } from "../server.ts";

// The Church Documents reads. The library is one statement; a document page is one statement. The PDF bytes are a
// separate request (churchFileRoute), so the page never waits for a render.

export type ChurchView = {
	id: string;
	title: string;
	templateId: string;
	templateVersion: number;
	documentClass: ChurchDocument["documentClass"];
	revision: string;
	formats: ChurchDocument["formats"];
	/** The sheet the preview shows (not one card) and its cards per sheet. */
	page: { width: number; height: number; perSheet: number };
};
export type Load<T> = { status: "ok"; value: T } | { status: "refused" } | { status: "failed" };

/** An Owner or Admin of the church plant; a Member reads only. */
export const canManageChurch = (authority: RequestActor) => hasPlantSeat(authority) && canEditDocuments(authority);

export async function loadLibrary(
	authority: RequestActor,
): Promise<Load<{ documents: ChurchSummary[]; templates: DocTemplateSummary[] }>> {
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
				page: sheetOf(d.body.page),
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
 * GET /documents/church/{id}/file?format=pdf[&revision=n][&download=1]. The preview and every download call the same
 * domain read, so the preview is the file Download gives. The actor is read again here.
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
