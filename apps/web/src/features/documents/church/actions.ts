"use server";

import { requestDatabase } from "@/server/database";
import { viewerActor } from "@/server/request-context";
import type { ChurchTemplateSummary, DocDocument } from "@everyfield/contracts/documents";
import { documentsWriter } from "@everyfield/domain/documents";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { refusedWith } from "./refusal.ts";
import type { LogWord } from "@everyfield/domain/log";
import { LOST, transient } from "../../../server/platform/transient.ts";

const denied = { ...refusedWith("access_denied"), code: "access_denied" } as const;
const write = <const O extends string, T>(outcome: LogWord<O>, body: () => Promise<T>) =>
	transient({ component: "church-documents", outcome }, body, LOST);

export type ChurchActionResult = { status: "refused"; message: string } | { status: "lost" };

export async function createChurchDocument(
	templateId: string,
	requestKey: string,
	mergeFields?: unknown,
): Promise<ChurchActionResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("create_failed", () =>
		documentsWriter.createFromTemplate(requestDatabase(), actor, { templateId, requestKey, mergeFields }),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	revalidatePath("/documents/church");
	redirect(`/documents/church/${reply.value.id}`);
}

export type SaveResult =
	{ status: "saved"; revision: string } | { status: "refused"; code: string; message: string } | { status: "lost" };

export async function saveChurchDocument(
	documentId: string,
	expectedRevision: string,
	body: unknown,
): Promise<SaveResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("save_failed", () =>
		documentsWriter.saveNative(requestDatabase(), actor, { documentId, expectedRevision, body }),
	);
	if (reply.status === "lost") return reply;
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
}

export type BrandingResult =
	{ status: "saved"; useChurchBranding: boolean } | { status: "refused"; message: string } | { status: "lost" };

export async function setChurchBranding(documentId: string, useChurchBranding: boolean): Promise<BrandingResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("branding_failed", () =>
		documentsWriter.setBranding(requestDatabase(), actor, { documentId, useChurchBranding }),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	return { status: "saved", useChurchBranding: reply.value.useChurchBranding };
}

export async function deleteChurchDocument(documentId: string, expectedRevision: string): Promise<ChurchActionResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("delete_failed", () =>
		documentsWriter.deleteChurch(requestDatabase(), actor, { documentId, expectedRevision }),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	revalidatePath("/documents/church");
	redirect("/documents/church?deleted=1");
}

export async function archiveChurchDocument(documentId: string, expectedRevision: string): Promise<ChurchActionResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("archive_failed", () =>
		documentsWriter.archiveChurch(requestDatabase(), actor, { documentId, expectedRevision }),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	revalidatePath("/documents/church");
	redirect("/documents/church?archived=1");
}

export async function restoreChurchDocument(documentId: string): Promise<ChurchActionResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("restore_failed", () =>
		documentsWriter.restoreChurch(requestDatabase(), actor, { documentId }),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	revalidatePath("/documents/church");
	redirect("/documents/church?restored=1");
}

export type TemplateSaveResult =
	{ status: "saved"; template: ChurchTemplateSummary } | { status: "refused"; message: string } | { status: "lost" };

export async function saveChurchTemplate(input: unknown): Promise<TemplateSaveResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("template_save_failed", () =>
		documentsWriter.saveChurchTemplate(requestDatabase(), actor, input),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	revalidatePath("/documents/church");
	return { status: "saved", template: reply.value };
}

export type TemplateUpdateResult =
	| { status: "updated"; template: ChurchTemplateSummary }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

export async function updateChurchTemplate(input: unknown): Promise<TemplateUpdateResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("template_update_failed", () =>
		documentsWriter.updateChurchTemplate(requestDatabase(), actor, input),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return { ...refusedWith(reply.error.code), code: reply.error.code };
	revalidatePath("/documents/church");
	return { status: "updated", template: reply.value };
}

export type TemplateEditResult =
	| { status: "saved"; template: ChurchTemplateSummary }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

export async function editChurchTemplate(input: unknown): Promise<TemplateEditResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("template_edit_failed", () =>
		documentsWriter.editChurchTemplate(requestDatabase(), actor, input),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return { ...refusedWith(reply.error.code), code: reply.error.code };
	revalidatePath("/documents/church");
	return { status: "saved", template: reply.value };
}

export async function deleteChurchTemplate(
	templateId: string,
): Promise<{ status: "deleted" } | { status: "refused"; message: string } | { status: "lost" }> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("template_delete_failed", () =>
		documentsWriter.deleteChurchTemplate(requestDatabase(), actor, { templateId }),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	revalidatePath("/documents/church");
	return { status: "deleted" };
}

export type DeleteExportResult = { status: "deleted" } | { status: "refused"; message: string } | { status: "lost" };

export async function deleteSavedExport(documentId: string, exportId: string): Promise<DeleteExportResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("export_delete_failed", () =>
		documentsWriter.deleteExport(requestDatabase(), actor, { documentId, exportId }),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok") return refusedWith(reply.error.code);
	return { status: "deleted" };
}

export type AcceptResult =
	| { status: "accepted"; revision: string; document: DocDocument }
	| { status: "refused"; code: string; message: string }
	| { status: "lost" };

export async function acceptTemplateChanges(
	documentId: string,
	expectedRevision: string,
	templateHash: string,
	view: unknown,
	key: string,
	accept: unknown,
): Promise<AcceptResult> {
	const actor = await viewerActor();
	if (!actor) return denied;
	const reply = await write("accept_failed", () =>
		documentsWriter.acceptTemplateChanges(requestDatabase(), actor, {
			documentId,
			expectedRevision,
			templateHash,
			view,
			key,
			accept,
		}),
	);
	if (reply.status === "lost") return reply;
	if (reply.status !== "ok")
		return { status: "refused", code: reply.error.code, message: refusedWith(reply.error.code).message };
	return { status: "accepted", revision: reply.value.revision, document: reply.value.body };
}
