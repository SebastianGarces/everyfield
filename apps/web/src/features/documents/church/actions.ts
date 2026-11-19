"use server";

import { requestDatabase } from "@/server/database";
import type { CompareView, ChurchTemplateSummary, DocDocument } from "@everyfield/contracts/documents";
import { documentsWriter } from "@everyfield/domain/documents";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { documentActor } from "../server.ts";
import { refusedWith } from "./refusal.ts";
import { logFailure } from "@everyfield/domain/log";

export type ChurchActionResult = { status: "refused"; message: string } | { status: "lost" };

export async function createChurchDocument(
	templateId: string,
	requestKey: string,
	mergeFields?: Record<string, string>,
): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	let id: string;
	try {
		const reply = await documentsWriter.createFromTemplate(db, actor, { templateId, requestKey, mergeFields });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		id = reply.value.id;
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "create_failed" }, error);
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect(`/documents/church/${id}`);
}

export type SaveResult =
	{ status: "saved"; revision: string } | { status: "refused"; code: string; message: string } | { status: "lost" };

export async function saveChurchDocument(
	documentId: string,
	expectedRevision: string,
	body: unknown,
): Promise<SaveResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
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
		logFailure({ component: "church-documents", outcome: "save_failed" }, error);
		return { status: "lost" };
	}
}

export type BrandingResult =
	{ status: "saved"; useChurchBranding: boolean } | { status: "refused"; message: string } | { status: "lost" };

export async function setChurchBranding(documentId: string, useChurchBranding: boolean): Promise<BrandingResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.setBranding(db, actor, { documentId, useChurchBranding });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		return { status: "saved", useChurchBranding: reply.value.useChurchBranding };
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "branding_failed" }, error);
		return { status: "lost" };
	}
}

export async function deleteChurchDocument(documentId: string, expectedRevision: string): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.deleteChurch(db, actor, { documentId, expectedRevision });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "delete_failed" }, error);
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect("/documents/church?deleted=1");
}

export async function archiveChurchDocument(documentId: string, expectedRevision: string): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.archiveChurch(db, actor, { documentId, expectedRevision });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "archive_failed" }, error);
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect("/documents/church?archived=1");
}

export async function restoreChurchDocument(documentId: string): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.restoreChurch(db, actor, { documentId });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "restore_failed" }, error);
		return { status: "lost" };
	}
	revalidatePath("/documents/church");
	redirect("/documents/church?restored=1");
}

export type TemplateSaveResult =
	{ status: "saved"; template: ChurchTemplateSummary } | { status: "refused"; message: string } | { status: "lost" };

export async function saveChurchTemplate(input: {
	documentId: string;
	revision: number;
	name: string;
	description: string;
	requestKey: string;
}): Promise<TemplateSaveResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.saveChurchTemplate(db, actor, input);
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		revalidatePath("/documents/church");
		return { status: "saved", template: reply.value };
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "template_save_failed" }, error);
		return { status: "lost" };
	}
}

export type TemplateUpdateResult =
	| { status: "updated"; template: ChurchTemplateSummary }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

export async function updateChurchTemplate(input: {
	templateId: string;
	expectedVersion: number;
	documentId: string;
	revision: number;
	requestKey: string;
}): Promise<TemplateUpdateResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.updateChurchTemplate(db, actor, input);
		if (reply.status !== "ok") return { ...refusedWith(reply.error.code), code: reply.error.code };
		revalidatePath("/documents/church");
		return { status: "updated", template: reply.value };
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "template_update_failed" }, error);
		return { status: "lost" };
	}
}

export type TemplateEditResult =
	| { status: "saved"; template: ChurchTemplateSummary }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

export async function editChurchTemplate(input: {
	templateId: string;
	name: string;
	description: string;
	requestKey: string;
}): Promise<TemplateEditResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.editChurchTemplate(db, actor, input);
		if (reply.status !== "ok") return { ...refusedWith(reply.error.code), code: reply.error.code };
		revalidatePath("/documents/church");
		return { status: "saved", template: reply.value };
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "template_edit_failed" }, error);
		return { status: "lost" };
	}
}

export async function deleteChurchTemplate(
	templateId: string,
): Promise<{ status: "deleted" } | { status: "refused"; message: string } | { status: "lost" }> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.deleteChurchTemplate(db, actor, { templateId });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		revalidatePath("/documents/church");
		return { status: "deleted" };
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "template_delete_failed" }, error);
		return { status: "lost" };
	}
}

export type DeleteExportResult = { status: "deleted" } | { status: "refused"; message: string } | { status: "lost" };

export async function deleteSavedExport(documentId: string, exportId: string): Promise<DeleteExportResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor) return { status: "lost" };
	try {
		const reply = await documentsWriter.deleteExport(db, actor, { documentId, exportId });
		if (reply.status !== "ok") return refusedWith(reply.error.code);
		return { status: "deleted" };
	} catch (error) {
		logFailure({ component: "church-documents", outcome: "export_delete_failed" }, error);
		return { status: "lost" };
	}
}

export type AcceptResult =
	| { status: "accepted"; revision: string; document: DocDocument }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

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
	if (!actor) return { status: "lost" };
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
		logFailure({ component: "church-documents", outcome: "accept_failed" }, error);
		return { status: "lost" };
	}
}
