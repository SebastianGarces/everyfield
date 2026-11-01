"use server";

import { requestDatabase } from "@/server/database";
import { documentsWriter } from "@everyfield/domain/documents";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { documentActor } from "../server.ts";

// New from template and Delete. The actor is read again here; the server refuses a Member, whatever the page showed.
// A success moves to the next page on the server, so the library is fresh without a client refresh.

export type ChurchActionResult = { status: "refused"; message: string } | { status: "lost" };

const MESSAGES: Record<string, string> = {
	access_denied: "Only an Owner or Admin of the church plant can do this.",
	unavailable: "This is not available any more. Reload the page.",
	conflict: "The document changed after this page opened. Reload the page and try again.",
	invalid_input: "That request is not valid.",
};
const refusedWith = (code: string): ChurchActionResult => ({
	status: "refused",
	message: MESSAGES[code] ?? "Something went wrong. Nothing was changed.",
});

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
