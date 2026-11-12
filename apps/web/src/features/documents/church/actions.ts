"use server";

import { requestDatabase } from "@/server/database";
import {
	type ChurchCompare,
	type CompareView,
	type ChurchTemplateSummary,
	type DocDocument,
} from "@everyfield/contracts/documents";
import { documentsWriter } from "@everyfield/domain/documents";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { documentActor } from "../server.ts";
import { refusedWith } from "./refusal.ts";

// The Church Documents actions: create from a template, save, branding, delete, archive, restore, the church templates (save as,
// list, update, rename, delete), deleting a saved export, and comparing with or accepting a template's changes. The
// actor is read again here; the server refuses a Member, whatever the page showed. Create and delete move to the next
// page on the server, so the library is fresh without a client refresh.

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
	try {
		// The writer parses the request, body included, once; a body it refuses names its first problem.
		const reply = await documentsWriter.saveNative(db, actor, { documentId, expectedRevision, body });
		if (reply.status !== "ok") {
			if (reply.error.code === "invalid_input")
				return {
					status: "refused",
					code: "invalid_input",
					message: `The document is not valid: ${reply.error.details.issues[0]?.problem ?? ""}`,
				};
			return { status: "refused", code: reply.error.code, message: refusedWith(reply.error.code).message };
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

/**
 * Archives a Church Document after the person confirmed, then returns to the library without it. Its page, revisions
 * and saved exports stay readable and downloadable; an Owner or Admin can still delete it later.
 */
export async function archiveChurchDocument(documentId: string, expectedRevision: string): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.archiveChurch(db, actor, { documentId, expectedRevision });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "archive_failed", error: String(error) }));
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect("/documents/church?archived=1");
}

/**
 * Restores an archived Church Document after the person confirmed, then returns to the library, where it is listed and
 * editable again with its revisions and saved exports as they were.
 */
export async function restoreChurchDocument(documentId: string): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.restoreChurch(db, actor, { documentId });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
	} catch (error) {
		console.error(JSON.stringify({ component: "church-documents", outcome: "restore_failed", error: String(error) }));
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect("/documents/church?restored=1");
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

/** The church's templates as they stand now, for "Update a template". Read when the dialog opens, so it is current. */
export async function listChurchTemplates(): Promise<
	{ status: "ok"; templates: ChurchTemplateSummary[] } | { status: "refused"; message: string } | { status: "lost" }
> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.listChurch(db, actor, {});
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		return { status: "ok", templates: reply.value.templates };
	} catch (error) {
		console.error(
			JSON.stringify({ component: "church-documents", outcome: "template_list_failed", error: String(error) }),
		);
		return { status: "lost" };
	}
}

export type TemplateUpdateResult =
	| { status: "updated"; template: ChurchTemplateSummary }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

/**
 * Update a church template: the saved revision the person sees becomes the template's next version. The request names
 * the version it replaces, so a template another person updated first is refused. One request key makes one version.
 */
export async function updateChurchTemplate(input: {
	templateId: string;
	expectedVersion: number;
	documentId: string;
	revision: number;
	requestKey: string;
}): Promise<TemplateUpdateResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.updateChurchTemplate(db, actor, input);
		if (reply.status !== "ok") return { ...refusedWith(reply.error.code), code: reply.error.code };
		revalidatePath("/documents/church");
		return { status: "updated", template: reply.value };
	} catch (error) {
		console.error(
			JSON.stringify({ component: "church-documents", outcome: "template_update_failed", error: String(error) }),
		);
		return { status: "lost" };
	}
}

export type TemplateEditResult =
	| { status: "saved"; template: ChurchTemplateSummary }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

/**
 * Renames a church template or changes its description. It makes no new version, and documents already made from it
 * keep their own title. One request key makes one change, so a double click or a resend writes it once.
 */
export async function editChurchTemplate(input: {
	templateId: string;
	name: string;
	description: string;
	requestKey: string;
}): Promise<TemplateEditResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsWriter.editChurchTemplate(db, actor, input);
		if (reply.status !== "ok") return { ...refusedWith(reply.error.code), code: reply.error.code };
		revalidatePath("/documents/church");
		return { status: "saved", template: reply.value };
	} catch (error) {
		console.error(
			JSON.stringify({ component: "church-documents", outcome: "template_edit_failed", error: String(error) }),
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
 * Accepts the chosen items of one list (or all of them) as the next revision. The write checks the seat, the revision
 * the compare read, the template it compared with and the list's key, so a Member, a stale compare, a newer template or
 * ids from the other list write nothing.
 */
export async function acceptTemplateChanges(
	documentId: string,
	expectedRevision: string,
	templateHash: string,
	view: CompareView,
	key: string,
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
			view,
			key,
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
