"use server";

import { requestDatabase } from "@/server/database";
import {
	saveChurchRequest,
	type ChurchCompare,
	type ChurchTemplateSummary,
	type DocDocument,
} from "@everyfield/contracts/documents";
import { documentsWriter } from "@everyfield/domain/documents";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { documentActor } from "../server.ts";
import { refusedWith } from "./refusal.ts";

// New from template and Delete. The actor is read again here; the server refuses a Member, whatever the page showed.
// A success moves to the next page on the server, so the library is fresh without a client refresh.

export type ChurchActionResult = { status: "refused"; message: string } | { status: "lost" };

/**
 * Creates a Church Document from a built-in or church template, then opens its page. The same request key opens the same one.
 * `mergeFields` are the values typed on the Documents template page; each wins over the church's own value.
 */
export async function createChurchDocument(
	templateId: string,
	requestKey: string,
	mergeFields?: Record<string, string>,
): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	let id: string;
	try {
		const reply = await documentsWriter.createFromTemplate(db, actor, { templateId, requestKey, mergeFields });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		id = reply.value.id;
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "create_failed", error: String(error) }));
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect(`/documents/church/${id}`);
}

export type SaveResult =
	{ status: "saved"; revision: string } | { status: "refused"; code: string; message: string } | { status: "lost" };

/**
 * Saves the edited document as the next revision. The actor is read again here and the write statement checks the seat
 * and the expected revision, so a Member, a stale tab or an archived document is refused with nothing written.
 */
export async function saveChurchDocument(
	documentId: string,
	expectedRevision: string,
	body: unknown,
): Promise<SaveResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	const request = saveChurchRequest.safeParse({ documentId, expectedRevision, body });
	if (!request.success) {
		const first = request.error.issues[0]?.message ?? "";
		return { status: "refused", code: "invalid_input", message: `The document is not valid: ${first}` };
	}
	try {
		const reply = await documentsWriter.saveNative(db, actor, request.data);
		if (reply.status !== "ok") {
			const refused = refusedWith(reply.error.code);
			return {
				status: "refused",
				code: reply.error.code,
				message: refused.message,
			};
		}
		return { status: "saved", revision: reply.value.revision };
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "save_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export type BrandingResult =
	{ status: "saved"; useChurchBranding: boolean } | { status: "refused"; message: string } | { status: "lost" };

/**
 * Turns church branding on or off for one Church Document: one audited write and no new revision, so later previews and
 * exports follow it and saved exports keep their bytes. The actor is read again here and the write statement checks
 * the seat, so a Member or a deleted document is refused with nothing written.
 */
export async function setChurchBranding(documentId: string, useChurchBranding: boolean): Promise<BrandingResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.setBranding(db, actor, { documentId, useChurchBranding });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		return { status: "saved", useChurchBranding: reply.value.useChurchBranding };
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "branding_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** Deletes a Church Document after the person confirmed, then returns to the library without it. */
export async function deleteChurchDocument(documentId: string, expectedRevision: string): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.deleteChurch(db, actor, { documentId, expectedRevision });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "delete_failed", error: String(error) }));
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect("/documents/church?deleted=1");
}

export type TemplateSaveResult =
	{ status: "saved"; template: ChurchTemplateSummary } | { status: "refused"; message: string } | { status: "lost" };

/**
 * Save as template: the saved revision the person sees becomes the church's own template. The same request key makes
 * one template, so a double click or a resend after a dropped connection does not make two.
 */
export async function saveChurchTemplate(input: {
	documentId: string;
	revision: number;
	name: string;
	description: string;
	requestKey: string;
}): Promise<TemplateSaveResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.saveChurchTemplate(db, actor, input);
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		revalidatePath("/documents/church");
		return { status: "saved", template: reply.value };
	} catch (error) {
		console.error(
			JSON.stringify({ component: "church-documents", outcome: "template_save_failed", error: String(error) }),
		);
		return { status: "lost" };
	}
}

/** Deletes a church template after the person confirmed. Documents made from it keep their content. */
export async function deleteChurchTemplate(
	templateId: string,
): Promise<{ status: "deleted" } | { status: "refused"; message: string } | { status: "lost" }> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.deleteChurchTemplate(db, actor, { templateId });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		revalidatePath("/documents/church");
		return { status: "deleted" };
	} catch (error) {
		console.error(
			JSON.stringify({ component: "church-documents", outcome: "template_delete_failed", error: String(error) }),
		);
		return { status: "lost" };
	}
}

export type DeleteExportResult = { status: "deleted" } | { status: "refused"; message: string } | { status: "lost" };

/** An Owner or Admin deletes one saved export after confirming (D-79). The server refuses a Member. */
export async function deleteSavedExport(documentId: string, exportId: string): Promise<DeleteExportResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.deleteExport(db, actor, { documentId, exportId });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		return { status: "deleted" };
	} catch (error) {
		console.error(
			JSON.stringify({ component: "church-documents", outcome: "export_delete_failed", error: String(error) }),
		);
		return { status: "lost" };
	}
}

export type CompareResult =
	{ status: "ok"; compare: ChurchCompare } | { status: "refused"; code: string; message: string } | { status: "lost" };

/** The differences between the document's saved revision and the current template. An Owner or Admin only. */
export async function compareWithTemplate(documentId: string): Promise<CompareResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.readTemplateCompare(db, actor, { documentId });
		if (reply.status !== "ok")
			return { status: "refused", code: reply.error.code, message: refusedWith(reply.error.code).message };
		return { status: "ok", compare: reply.value };
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "compare_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export type AcceptResult =
	| { status: "accepted"; revision: string; document: DocDocument }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

/**
 * Accepts the chosen differences (or all of them) as the next revision. The write checks the seat, the revision the
 * compare read and the template it compared with, so a Member, a stale compare or a newer template writes nothing.
 */
export async function acceptTemplateChanges(
	documentId: string,
	expectedRevision: string,
	templateHash: string,
	accept: number[] | "all",
): Promise<AcceptResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.acceptTemplateChanges(db, actor, {
			documentId,
			expectedRevision,
			templateHash,
			accept,
		});
		if (reply.status !== "ok")
			return { status: "refused", code: reply.error.code, message: refusedWith(reply.error.code).message };
		return { status: "accepted", revision: reply.value.revision, document: reply.value.body };
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "accept_failed", error: String(error) }));
		return { status: "lost" };
	}
}
