"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type {
	ChurchBlock,
	ChurchDocument,
	ChurchExport,
	ChurchRevisionSummary,
	DocumentsError,
} from "@everyfield/contracts/documents";
import { privateStorage } from "@everyfield/db/schema";
import { documentsReader, documentsWriter } from "@everyfield/domain/documents";
import type { Format, OwnedView, Resolved, SavedFile } from "./model.ts";
import { documentActor } from "./server.ts";

// Field fill for the open template. The actor is read again here. The browser cannot name a person, meeting, or
// team. Preview bytes use their own route.

export type DocumentOutcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: DocumentsError["code"]; problem?: string; slotIds?: string[] }
	| { status: "lost" };

function refused(error: DocumentsError): DocumentOutcome<never> {
	const problem = error.code === "invalid_input" ? error.details.issues[0]?.problem : undefined;
	const slotIds = error.code === "slot_not_deletable" ? error.details.slotIds : undefined;
	return {
		status: "refused",
		code: error.code,
		...(problem ? { problem } : {}),
		...(slotIds ? { slotIds } : {}),
	};
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
		source: value.source ? { title: value.source.title, revision: value.source.revision } : null,
	};
}

function presentOwned(value: OwnedView): OwnedView {
	return {
		id: value.id,
		kind: value.kind,
		title: value.title,
		body: value.body,
		revision: value.revision,
		archived: value.archived,
	};
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

/** Create or replace a written document. A new document uses revision "0" and has no id. */
export async function saveOwnedDocument(input: {
	title: string;
	body: string;
	documentId?: string;
	expectedRevision: string;
}): Promise<DocumentOutcome<OwnedView>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.saveNative(db, actor, input);
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: presentOwned(reply.value) };
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
): Promise<DocumentOutcome<OwnedView>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.designateCoreValues(db, actor, { documentId, expectedRevision });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: presentOwned(reply.value) };
	});
}

/** Import UTF-8 text or a modern Word file into a written document. The original bytes stay private. */
export async function importOwnedDocument(input: {
	title: string;
	format: "text" | "docx";
	bytes: string;
	documentId?: string;
	expectedRevision: string;
	requestKey: string;
}): Promise<DocumentOutcome<OwnedView>> {
	const storage = privateStorage();
	if (!storage) return storageMissing;
	return run(async (db, actor) => {
		const reply = await documentsWriter.importTextOrWord(db, actor, input, storage);
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: presentOwned(reply.value) };
	});
}

// Church Documents. Each action reads the actor again. A write answers with what it changed, so the screen updates in place
// and never refreshes the route or rereads the page.

/** Make a Church Document from an editable template. The same request key makes the same document. */
export async function createChurchDocument(
	templateId: string,
	mergeFields: Record<string, string>,
	requestKey: string,
): Promise<DocumentOutcome<{ id: string }>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.createFromTemplate(db, actor, { templateId, mergeFields, requestKey });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { id: reply.value.id } };
	});
}

/** The name the page shows for the person who just wrote: the signed-in account's own name. */
async function writer() {
	const viewer = await getViewer();
	return { id: viewer && "accountId" in viewer ? viewer.accountId : null, name: viewer?.displayName?.trim() || null };
}

/** What a save changed: the document at its new revision and that one revision's summary. */
type ChurchSaved = { document: ChurchDocument; revision: ChurchRevisionSummary };

/** Save the body as one new revision. The answer holds only what changed, so its size does not grow with the history. */
export async function saveChurchDocument(
	documentId: string,
	expectedRevision: string,
	body: ChurchBlock[],
): Promise<DocumentOutcome<ChurchSaved>> {
	return run(async (db, actor) => {
		const saved = await documentsWriter.saveNative(db, actor, { documentId, expectedRevision, body });
		if (saved.status === "refused") return refused(saved.error);
		const document = saved.value;
		const author = await writer();
		return {
			status: "ok",
			value: {
				document,
				revision: {
					id: document.revisionId,
					number: Number(document.revision),
					authorAccountId: author.id,
					authorName: author.name,
					recordedAt: new Date().toISOString(),
					contentHash: document.contentHash,
				},
			},
		};
	});
}

/** One older revision, exactly as it was saved. */
export async function readChurchRevision(
	documentId: string,
	revision: number,
): Promise<DocumentOutcome<{ number: number; body: ChurchBlock[] }>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter["history.get"](db, actor, { documentId, revision });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { number: reply.value.number, body: reply.value.body } };
	});
}

export async function setChurchBranding(
	documentId: string,
	useChurchBranding: boolean,
): Promise<DocumentOutcome<{ useChurchBranding: boolean }>> {
	return run(async (db, actor) => {
		const reply = await documentsWriter.setBranding(db, actor, { documentId, useChurchBranding });
		if (reply.status === "refused") return refused(reply.error);
		return { status: "ok", value: { useChurchBranding: reply.value.useChurchBranding } };
	});
}

/** Export one revision and ask for its signed link. The answer holds the one new export, not the page. */
export async function exportChurchDocument(
	documentId: string,
	revision: number,
	format: "pdf" | "docx",
	requestKey: string,
): Promise<DocumentOutcome<{ url: string; export: ChurchExport }>> {
	const storage = privateStorage();
	if (!storage) return storageMissing;
	return run(async (db, actor) => {
		const made = await documentsWriter.exportNative(db, actor, { documentId, revision, format, requestKey }, storage);
		if (made.status === "refused") return refused(made.error);
		const link = await documentsWriter.download(db, actor, { documentId: made.value.id }, storage);
		if (link.status === "refused") return refused(link.error);
		const file = made.value;
		const author = await writer();
		return {
			status: "ok",
			value: {
				url: link.value.url,
				export: {
					id: file.id,
					format,
					revision: file.source?.revision ?? revision,
					theme: file.theme?.kind === "church" ? "church" : "everyfield-neutral",
					creatorName: author.name,
					generatedAt: file.generatedAt,
					downloadName: file.downloadName,
				},
			},
		};
	});
}
