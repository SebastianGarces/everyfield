"use server";

import { requestDatabase } from "@/server/database";
import { saveChurchRequest } from "@everyfield/contracts/documents";
import { documentsWriter } from "@everyfield/domain/documents";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { documentActor } from "../server.ts";
import { refusedWith } from "./refusal.ts";

// New from template and Delete. The actor is read again here; the server refuses a Member, whatever the page showed.
// A success moves to the next page on the server, so the library is fresh without a client refresh.

export type ChurchActionResult = { status: "refused"; message: string } | { status: "lost" };

/** Creates a Church Document from a built-in template, then opens its page. The same request key opens the same one. */
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
