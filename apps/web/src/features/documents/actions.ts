"use server";

import { requestDatabase } from "@/server/database";
import type { DocumentsError } from "@everyfield/contracts/documents";
import { privateStorage } from "@everyfield/db/schema";
import { documentsReader, documentsWriter } from "@everyfield/domain/documents";
import {
	type CopySource,
	type Format,
	type OwnedView,
	type Resolved,
	type SavedFile,
	type WrittenView,
} from "./model.ts";
import { documentActor } from "./server.ts";

// Field fill for the open template. The actor is read again here. The browser cannot name a person, meeting, or
// team. Preview bytes use their own route.

export type DocumentOutcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: DocumentsError["code"]; problem?: string; path?: string }
	| { status: "lost" };

function refused(error: DocumentsError): DocumentOutcome<never> {
	const issue = error.code === "invalid_input" ? error.details.issues[0] : undefined;
	return issue
		? { status: "refused", code: error.code, problem: issue.problem, path: issue.path }
		: { status: "refused", code: error.code };
}

async function run<T>(
	read: (
		db: NonNullable<ReturnType<typeof requestDatabase>>,
		actor: NonNullable<Awaited<ReturnType<typeof documentActor>>>,
	) => Promise<DocumentOutcome<T>>,
) {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" } as const;
	try {
		return await read(db, actor);
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "action_failed", error: String(error) }));
		return { status: "lost" } as const;
	}
}

/** Filled fields for one template. Format does not change the fields. */
export async function resolveDocument(templateId: string, format: Format): Promise<DocumentOutcome<Resolved>> {
	return run(async (db, actor) => {
		const reply = await documentsReader.resolveContext(db, actor, { templateId, format });
		if (reply.status === "refused") return refused(reply.error);
		const value = reply.value;
		return {
			status: "ok",
			value: {
				templateId: value.templateId,
				format: value.format,
				fields: value.fields,
				missing: value.missing,
				complete: value.complete,
			},
		};
	});
}

const storageMissing = {
	status: "refused" as const,
	code: "unavailable" as const,
	problem: "Saving is not available right now.",
};

function presentSaved(value: SavedFile): SavedFile {
	return {
		id: value.id,
		savedTemplateName: value.savedTemplateName,
		format: value.format,
		generatedAt: value.generatedAt,
		downloadName: value.downloadName,
	};
}

function presentOwned(value: OwnedView): OwnedView {
	return { id: value.id, kind: value.kind, title: value.title, archived: value.archived };
}

/** Save one generated file for the church. The same request key and the same fields return the same file. */
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

/** The latest saved files for this church. Preview bytes are not in this list. */
export async function listSavedDocuments(): Promise<DocumentOutcome<SavedFile[]>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter["history.list"](db, actor, {});
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: reply.value.entries.map(presentSaved) };
	});
}

/** A fresh signed download for one saved file. The link lasts five minutes. */
export async function downloadSavedDocument(documentId: string): Promise<DocumentOutcome<{ url: string }>> {
	const storage = privateStorage();
	if (!storage) return storageMissing;
	return run(async (db, actor) => {
		const reply = await documentsWriter.download(db, actor, { documentId }, storage);
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { url: reply.value.url } };
	});
}

/** Written documents for the current account or church, plus the current core-values text. */
export async function loadWrittenDocuments(): Promise<
	DocumentOutcome<{ documents: OwnedView[]; evidence: string | null }>
> {
	return run(async (db, actor) => {
		const listed = await documentsWriter.listOwned(db, actor, {});
		if (listed.status === "refused") return refused(listed.error);
		const evidence = await documentsWriter.readCoreValuesEvidence(db, actor, {});
		if (evidence.status === "refused") return refused(evidence.error);
		return {
			status: "ok",
			value: {
				documents: listed.value.documents.map(presentOwned),
				evidence: evidence.value.text,
			},
		};
	});
}

/**
 * Create or replace a written document: its title and the editor's body node. A new document uses revision "0" and
 * has no id. The domain parses the body; the browser's copy is not trusted.
 */
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

/** Use for this church: your own account documents that are not archived and have text. */
export async function loadCopySources(): Promise<DocumentOutcome<CopySource[]>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.listCopySources(db, actor, {});
		if (reply.status === "refused") return refused(reply.error);
		return {
			status: "ok",
			value: reply.value.documents.map((item) => ({ id: item.id, title: item.title, revisionId: item.revisionId })),
		};
	});
}

/** Copy one of your account documents into the church plant. The same request key makes one copy. */
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
