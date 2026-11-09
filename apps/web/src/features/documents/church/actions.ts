"use server";

import { requestDatabase } from "@/server/database";
import { saveChurchRequest, type ChurchTemplateSummary } from "@everyfield/contracts/documents";
import { documentsWriter } from "@everyfield/domain/documents";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { documentActor } from "../server.ts";
import { refusedWith } from "./refusal.ts";

// New from template and Delete. The actor is read again here; the server refuses a Member, whatever the page showed.
// A success moves to the next page on the server, so the library is fresh without a client refresh.

export type ChurchActionResult = { status: "refused"; message: string } | { status: "lost" };

/** Creates a Church Document from a built-in or church template, then opens its page. The same request key opens the same one. */
export async function createChurchDocument(templateId: string, requestKey: string): Promise<ChurchActionResult> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	let id: string;
	try {
		const reply = await documentsWriter.createFromTemplate(db, actor, { templateId, requestKey });
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
		const reply = await documentsWriter.saveChurchTemplate(db, actor, {
			documentId: input.documentId,
			revision: input.revision,
			name: input.name,
			...(input.description.trim() ? { description: input.description } : {}),
			requestKey: input.requestKey,
		});
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
