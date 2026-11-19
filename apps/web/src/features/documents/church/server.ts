import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { recordId } from "@everyfield/contracts/common";
import {
	type ArchivedChurchSummary,
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
import { readBoundedBody } from "@everyfield/domain/operations";
import "server-only";
import { canEditDocuments, documentActor, hasPlantSeat } from "../server.ts";
import { EXPORT_MESSAGES } from "./refusal.ts";
import { logFailure } from "@everyfield/domain/log";
import { mutatingRoute } from "../../../server/platform/boundary.ts";

export type ChurchView = {
	id: string;
	title: string;
	templateId: string;
	templateVersion: number;
	templateName: string | null;
	documentClass: ChurchDocument["documentClass"];
	revision: string;
	formats: ChurchDocument["formats"];
	useChurchBranding: boolean;
	page: { width: number; height: number; perSheet: number };
	archived: ChurchDocument["archived"];
};
export type TemplateState = "behind" | "current" | null;
export type RevisionRow = {
	number: number;
	recordedAt: string;
	savedBy: string | null;
	formats: readonly ChurchDocument["formats"][number][];
};
export type Load<T> = { status: "ok"; value: T } | { status: "refused" } | { status: "failed" };

export const canManageChurch = (authority: RequestActor) => hasPlantSeat(authority) && canEditDocuments(authority);

export async function loadLibrary(
	authority: RequestActor,
): Promise<
	Load<{ documents: ChurchSummary[]; templates: DocTemplateSummary[]; churchTemplates: ChurchTemplateSummary[] }>
> {
	const db = requestDatabase();
	if (!hasPlantSeat(authority)) return { status: "refused" };
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
		logFailure({ component: "church-documents", outcome: "read_failed" }, error);
		return { status: "failed" };
	}
}

export async function loadArchived(authority: RequestActor): Promise<Load<ArchivedChurchSummary[]>> {
	const db = requestDatabase();
	try {
		const reply = await documentsWriter.listArchivedChurch(db, authority, {});
		return reply.status === "ok" ? { status: "ok", value: reply.value.documents } : { status: "refused" };
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "read_failed" }, error);
		return { status: "failed" };
	}
}

export async function loadChurchDocument(
	authority: RequestActor,
	documentId: string,
): Promise<
	| Load<{
			view: ChurchView;
			document: DocDocument;
			brands: DocBrands | null;
			mergeValues: Record<string, string>;
			template: TemplateState;
			exports: SavedExport[];
			revisions: RevisionRow[];
			revisionsTruncated: boolean;
	  }>
	| { status: "deleted" }
> {
	const db = requestDatabase();
	try {
		const readOnly = () =>
			documentsWriter
				.readChurch(db, authority, { documentId })
				.then((r) =>
					r.status === "ok" ? { ...r, value: { ...r.value, brands: null, mergeValues: {}, template: null } } : r,
				);
		const [first, saved, history] = await Promise.all([
			canManageChurch(authority) ? documentsWriter.readChurchForEdit(db, authority, { documentId }) : readOnly(),
			documentsWriter.listExports(db, authority, { documentId }),
			documentsWriter["history.list"](db, authority, { documentId }),
		]);
		if (saved.status !== "ok" && saved.error.code === "deleted") return { status: "deleted" };
		const reply =
			first.status !== "ok" && first.error.code === "unavailable" && saved.status === "ok" && canManageChurch(authority)
				? await readOnly()
				: first;
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
					archived: d.archived,
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
		logFailure({ component: "church-documents", outcome: "read_failed" }, error);
		return { status: "failed" };
	}
}

const NO_STORE = { "Cache-Control": "private, no-store" };
const gone = (status = 404) => new Response("This document is not available.", { status, headers: NO_STORE });

export async function churchFileRoute(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
	const id = recordId.safeParse((await params).documentId);
	if (!id.success) return gone();
	const documentId = id.data;
	const url = new URL(request.url);
	const format = url.searchParams.get("format") ?? "pdf";
	const revision = url.searchParams.get("revision");
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return gone();
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
		logFailure({ component: "church-documents", outcome: "file_failed" }, error);
		return gone(500);
	}
}

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
	if (!actor) return gone();
	try {
		const reply = await documentsWriter.readExportFile(
			db,
			actor,
			{ documentId: documentId.data, exportId: exportId.data },
			privateStorage(),
		);
		if (reply.status !== "ok" && reply.error.code === "deleted") {
			return new Response(null, {
				status: 303,
				headers: { ...NO_STORE, Location: `/documents/church/${documentId.data}` },
			});
		}
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
		logFailure({ component: "church-documents", outcome: "export_file_failed" }, error);
		return gone(500);
	}
}

export type ExportResult =
	{ status: "saved"; saved: SavedExport } | { status: "refused"; message: string } | { status: "lost" };
const BODY_MAX = 4 * 1024;
const answer = (result: ExportResult) => Response.json(result, { headers: NO_STORE });

export const saveExportRoute = mutatingRoute(async function saveExportRoute(
	request: Request,
	{ params }: { params: Promise<{ documentId: string }> },
) {
	const bytes = await readBoundedBody(request, BODY_MAX).catch(() => null);
	if (!bytes) return answer(refused("invalid_input"));
	const documentId = recordId.safeParse((await params).documentId);
	if (!documentId.success) return answer(refused("unavailable"));
	const body = (await new Response(bytes).json().catch(() => null)) as {
		revision?: unknown;
		format?: unknown;
		requestKey?: unknown;
	} | null;
	if (!body || typeof body.revision !== "string" || !/^[0-9]{1,7}$/.test(body.revision))
		return answer(refused("invalid_input"));
	const [actor, viewer] = await Promise.all([documentActor(), getViewer()]);
	const db = requestDatabase();
	if (!actor) return answer({ status: "lost" });
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
				creatorName: viewer.displayName || null,
				digest: done.digest,
				byteCount: done.byteCount,
				downloadName: done.downloadName,
			},
		});
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "export_failed" }, error);
		return answer({ status: "lost" });
	}
});

function refused(code: string): ExportResult {
	return { status: "refused", message: EXPORT_MESSAGES[code] ?? EXPORT_MESSAGES.unavailable! };
}
