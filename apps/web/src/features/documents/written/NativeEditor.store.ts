import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE, nativeText, type DocNode } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { DocumentOutcome } from "../actions.ts";
import { clean } from "../church/editor/document-json.ts";
import { blocksFromEditor, blocksToEditor } from "../church/editor/table-json.ts";
import { documentProblem, type WrittenView } from "../model.ts";
import { SaveChain } from "../save-chain.ts";

export const EMPTY: DocNode = { type: "doc", content: [{ type: "paragraph" }] };

export const toEditor = (body: DocNode) => ({ ...body, content: blocksToEditor(body.content ?? []) });

const fromEditor = (doc: PMNode): DocNode => {
	const json = clean(doc.toJSON()) as DocNode;
	return json.content ? { ...json, content: blocksFromEditor(json.content) as DocNode["content"] } : json;
};

export function sameDoc(base: PMNode | null, current: PMNode) {
	if (!base) return true;
	const comparable = base.type.schema === current.type.schema ? base : current.type.schema.nodeFromJSON(base.toJSON());
	return comparable.eq(current);
}

function fileFormat(file: File): "text" | "docx" | null {
	const name = file.name.toLowerCase();
	if (name.endsWith(".docx")) return "docx";
	if (name.endsWith(".txt") || file.type === "text/plain") return "text";
	return null;
}

type Written = { id: string; revision: string; kind: WrittenView["kind"] };

export type NativeEditorPort = {
	save: (input: {
		title: string;
		body: DocNode;
		expectedRevision: string;
		documentId?: string;
	}) => Promise<DocumentOutcome<Written>>;
	importFile: (file: File, params: Record<string, string>) => Promise<DocumentOutcome<WrittenView>>;
	designate: (documentId: string, revision: string) => Promise<DocumentOutcome<Pick<Written, "revision" | "kind">>>;
	created: (id: string) => void;
};

export type Saved = {
	id: string | null;
	revision: string;
	title: string;
	kind: WrittenView["kind"];
	textRevision: boolean;
	doc: PMNode | null;
};

export type Phase = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; reason: string; conflict: boolean };

export type NativeEditorState = {
	saved: Saved;
	title: string;
	phase: Phase;
	errors: { title?: string; body?: string };
	note: string | null;
	refused: boolean;
	actions: {
		began: (editor: Editor) => void;
		typeTitle: (title: string) => void;
		refuse: () => void;
		settle: () => void;
		save: (editor: Editor) => Promise<boolean>;
		importFile: (editor: Editor, file: File) => void;
		designate: (scope: "church" | "account") => Promise<void>;
		discard: () => void;
		unsaved: (editor: Editor) => boolean;
	};
};

const lost = { status: "lost" } as const;

export function createNativeEditorStore({
	doc,
	port,
}: {
	doc: WrittenView | null;
	port: NativeEditorPort;
}): StoreApi<NativeEditorState> {
	const chain = new SaveChain();
	let discarding = false;
	let importKey: string | null = null;

	return createStore<NativeEditorState>()((set, get) => {
		const savedNow = (editor: Editor) =>
			sameDoc(get().saved.doc, editor.state.doc) && get().title.trim() === get().saved.title;

		const created = (id: string) => {
			if (!get().saved.id) port.created(id);
		};

		const saveNow = (editor: Editor): Promise<boolean> => {
			const current = editor.state.doc;
			const body = fromEditor(current);
			const title = get().title.trim();
			const errors = {
				...(title ? {} : { title: "Enter a title." }),
				...(nativeText(body) ? {} : { body: "Write some text before you save." }),
			};
			set({ errors });
			if (errors.title || errors.body) return Promise.resolve(false);
			set({ phase: { kind: "saving" }, note: null });
			const base = get().saved;
			return chain.start(async () => {
				const result = await port
					.save({
						title,
						body,
						expectedRevision: base.revision,
						...(base.id ? { documentId: base.id } : {}),
					})
					.catch(() => lost);
				if (result.status !== "ok") {
					const conflict = result.status === "refused" && result.code === "conflict";
					set({
						phase: {
							kind: "failed",
							conflict,
							reason: conflict
								? "Someone saved a newer version first. Your edits are still here. Copy what you need, then reload."
								: result.status === "lost"
									? "The connection dropped. Your edits are still here."
									: documentProblem(result.code, result.problem, "Try again."),
						},
					});
					return false;
				}
				created(result.value.id);
				set((state) => ({
					saved: {
						id: result.value.id,
						revision: result.value.revision,
						title,
						kind: result.value.kind,
						textRevision: false,
						doc: current,
					},
					title: state.title.trim() === title ? title : state.title,
					phase: { kind: "idle" },
				}));
				return true;
			});
		};

		return {
			saved: {
				id: doc?.id ?? null,
				revision: doc?.revision ?? "0",
				title: doc?.title ?? "",
				kind: doc?.kind ?? "native",
				textRevision: doc?.textRevision ?? false,
				doc: null,
			},
			title: doc?.title ?? "",
			phase: { kind: "idle" },
			errors: {},
			note: null,
			refused: false,
			actions: {
				began: (editor) => {
					if (!get().saved.doc) set((state) => ({ saved: { ...state.saved, doc: editor.state.doc } }));
					editor.on("tableChangeRefused", get().actions.refuse);
				},
				typeTitle: (title) => set((state) => ({ title, errors: { ...state.errors, title: undefined } })),
				refuse: () => set({ refused: true }),
				settle: () => {
					if (get().refused) set({ refused: false });
				},
				save: (editor) =>
					chain.save(
						() => savedNow(editor),
						() => saveNow(editor),
					),
				importFile: (editor, file) => {
					const format = fileFormat(file);
					if (!format) return set({ note: "Use a .txt or .docx file. Older .doc Word files are not accepted." });
					if (file.size === 0) return set({ note: "The file is empty." });
					if (file.size > IMPORT_BYTES_MAX) return set({ note: IMPORT_TOO_LARGE });
					const base = get().saved;
					const title =
						get().title.trim() || file.name.replace(/\.(txt|docx)$/i, "").slice(0, 200) || "Imported document";
					const key = importKey ?? crypto.randomUUID();
					importKey = key;
					set({ phase: { kind: "saving" }, note: null });
					void port
						.importFile(file, {
							title,
							format,
							expectedRevision: base.revision,
							requestKey: key,
							...(base.id ? { documentId: base.id } : {}),
						})
						.catch(() => lost)
						.then((result) => {
							if (result.status !== "ok") {
								if (result.status === "refused") importKey = null;
								return set({
									phase: { kind: "idle" },
									note: documentProblem(
										result.status === "refused" ? result.code : "lost",
										result.status === "refused" ? result.problem : undefined,
										"This file did not import. Nothing in this document changed.",
									),
								});
							}
							importKey = null;
							const value = result.value;
							created(value.id);
							editor.chain().setMeta("addToHistory", false).setContent(toEditor(value.body)).run();
							set({
								saved: {
									id: value.id,
									revision: value.revision,
									title: value.title,
									kind: value.kind,
									textRevision: false,
									doc: editor.state.doc,
								},
								title: value.title,
								phase: { kind: "idle" },
								note:
									format === "docx"
										? "The Word file is now this document's saved version. Its headings, lists, links and tables came across, ready to edit."
										: "The file's text is now this document's saved version. Each line is a paragraph you can edit.",
							});
						});
				},
				designate: async (scope) => {
					const base = get().saved;
					if (!base.id) return;
					set({ phase: { kind: "saving" } });
					const result = await port.designate(base.id, base.revision).catch(() => lost);
					if (result.status !== "ok")
						return set({
							phase: { kind: "idle" },
							note: documentProblem(
								result.status === "refused" ? result.code : "lost",
								result.status === "refused" ? result.problem : undefined,
								"The core values did not change. Try again.",
							),
						});
					set((state) => ({
						saved: { ...state.saved, revision: result.value.revision, kind: result.value.kind },
						phase: { kind: "idle" },
						note:
							scope === "church"
								? "This document is now the core values for your church."
								: "This document is now your core values.",
					}));
				},
				discard: () => {
					discarding = true;
				},
				unsaved: (editor) => !discarding && (chain.busy || !savedNow(editor)),
			},
		};
	});
}
