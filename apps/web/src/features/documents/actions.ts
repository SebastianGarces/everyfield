"use server";

import { privateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import { z } from "zod";
import type { OwnedView, SavedFile, WrittenView } from "./model.ts";
import { documentActor } from "./server.ts";
import { presentOwned, presentSaved, refused, runAs, type DocumentOutcome, type Read } from "./outcome.ts";

const run = async <T>(read: Read<T>) => runAs(await documentActor(), read);

const storageMissing = {
	status: "refused" as const,
	code: "unavailable" as const,
	problem: "Saving is not available right now.",
};

export async function generateDocument(
	templateId: string,
	format: unknown,
	overrides: unknown,
	requestKey: string,
): Promise<DocumentOutcome<SavedFile>> {
	const storage = privateStorage();
	if (!storage) return storageMissing;
	return run(async (db, actor) => {
		const reply = await documentsWriter.generate(db, actor, { templateId, format, overrides, requestKey }, storage);
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: presentSaved(reply.value) };
	});
}

export async function downloadSavedDocument(documentId: string): Promise<DocumentOutcome<{ url: string }>> {
	const storage = privateStorage();
	if (!storage) return storageMissing;
	return run(async (db, actor) => {
		const reply = await documentsWriter.download(db, actor, { documentId }, storage);
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { url: reply.value.url } };
	});
}

const ownedDraft = z
	.object({ title: z.unknown(), body: z.unknown(), documentId: z.unknown(), expectedRevision: z.unknown() })
	.partial();

export async function saveOwnedDocument(
	raw: unknown,
): Promise<DocumentOutcome<{ id: string; revision: string; kind: WrittenView["kind"] }>> {
	const parsed = ownedDraft.safeParse(raw);
	const input = parsed.success ? parsed.data : {};
	return run(async (db, actor) => {
		const reply = await documentsWriter.saveNative(db, actor, {
			title: input.title,
			body: input.body,
			expectedRevision: input.expectedRevision,
			...(input.documentId ? { documentId: input.documentId } : {}),
		});
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { id: reply.value.id, revision: reply.value.revision, kind: reply.value.kind } };
	});
}

export async function archiveOwnedDocument(
	documentId: string,
	expectedRevision: string,
): Promise<DocumentOutcome<OwnedView>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.archive(db, actor, { documentId, expectedRevision });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: presentOwned(reply.value) };
	});
}

export async function designateOwnedDocument(
	documentId: string,
	expectedRevision: string,
): Promise<DocumentOutcome<{ revision: string; kind: WrittenView["kind"] }>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.designateCoreValues(db, actor, { documentId, expectedRevision });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { revision: reply.value.revision, kind: reply.value.kind } };
	});
}

export async function copyToChurch(input: unknown): Promise<DocumentOutcome<{ id: string }>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.useForChurch(db, actor, input);
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { id: reply.value.id } };
	});
}
