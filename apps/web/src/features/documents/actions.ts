"use server";

import { privateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import type { Format, OwnedView, SavedFile, WrittenView } from "./model.ts";
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
	format: Format,
	overrides: Record<string, string>,
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

export async function saveOwnedDocument(input: {
	title: string;
	body: unknown;
	documentId?: string;
	expectedRevision: string;
}): Promise<DocumentOutcome<{ id: string; revision: string; kind: WrittenView["kind"] }>> {
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

export async function copyToChurch(input: {
	documentId: string;
	revisionId: string;
	requestKey: string;
}): Promise<DocumentOutcome<{ id: string }>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.useForChurch(db, actor, input);
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { id: reply.value.id } };
	});
}
