"use server";

import { viewerActor } from "@/server/request-context";
import { privateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import { z } from "zod";
import type { OwnedView, SavedFile, WrittenView } from "./model.ts";
import {
	presentOwned,
	presentSaved,
	refused,
	runAs,
	storageMissing,
	type DocumentOutcome,
	type Read,
} from "./outcome.ts";

const run = async <T>(read: Read<T>) => runAs(await viewerActor(), read);

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

const ownedDraft = z
	.object({ title: z.unknown(), body: z.unknown(), documentId: z.unknown(), expectedRevision: z.unknown() })
	.partial();

type Saved = DocumentOutcome<{ id: string; revision: string; kind: WrittenView["kind"] }>;

export async function saveOwnedDocument(raw: unknown): Promise<Saved> {
	return saveWritten(raw, false);
}

export async function saveMyDocument(raw: unknown): Promise<Saved> {
	return saveWritten(raw, true);
}

async function saveWritten(raw: unknown, mine: boolean): Promise<Saved> {
	const parsed = ownedDraft.safeParse(raw);
	const input = parsed.success ? parsed.data : {};
	return run(async (db, actor) => {
		const reply = await (mine ? documentsWriter.saveMine : documentsWriter.saveNative)(db, actor, {
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
	mine = false,
): Promise<DocumentOutcome<OwnedView>> {
	return run(async (db, actor) => {
		const archive = mine ? documentsWriter.archiveMine : documentsWriter.archive;
		const reply = await archive(db, actor, { documentId, expectedRevision });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: presentOwned(reply.value) };
	});
}

type Designated = DocumentOutcome<{ revision: string; kind: WrittenView["kind"] }>;

export async function designateOwnedDocument(documentId: string, expectedRevision: string): Promise<Designated> {
	return designateWritten(documentId, expectedRevision, false);
}

export async function designateMyDocument(documentId: string, expectedRevision: string): Promise<Designated> {
	return designateWritten(documentId, expectedRevision, true);
}

async function designateWritten(documentId: string, expectedRevision: string, mine: boolean): Promise<Designated> {
	return run(async (db, actor) => {
		const designate = mine ? documentsWriter.designateMine : documentsWriter.designateCoreValues;
		const reply = await designate(db, actor, { documentId, expectedRevision });
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

export async function startFromTemplate(templateId: string, requestKey: string): Promise<DocumentOutcome<{ id: string }>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.createMineFromTemplate(db, actor, { templateId, requestKey });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { id: reply.value.id } };
	});
}
