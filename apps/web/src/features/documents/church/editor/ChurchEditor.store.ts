import type { DocDocument, ExportFormat } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { createStore, type StoreApi } from "zustand/vanilla";
import { SaveChain } from "../../save-chain.ts";
import type { SaveResult } from "../actions.ts";
import { TABLE_REFUSED } from "./TableControls.tsx";
import { documentFrom } from "./document-json.ts";

export type ChurchEditorPort = {
	save: (documentId: string, expectedRevision: string, body: DocDocument) => Promise<SaveResult>;
};

export type Saved = { revision: string; body: DocDocument; doc: PMNode | null };

export type Phase = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; reason: string };

export type OnRevision = (revision: string, formats: ExportFormat[]) => void;

export type ChurchEditorState = {
	saved: Saved;
	phase: Phase;
	refused: string | null;
	actions: {
		began: (editor: Editor) => void;
		edited: (editor: Editor) => void;
		moved: () => void;
		save: (editor: Editor, onRevision: OnRevision) => Promise<boolean>;
		unsaved: (editor: Editor) => boolean;
	};
};

const inSchema = new WeakMap<PMNode, PMNode>();

export function sameAsSaved(saved: PMNode | null, current: PMNode) {
	if (!saved) return true;
	if (saved.type.schema === current.type.schema) return saved.eq(current);
	let comparable = inSchema.get(saved);
	if (comparable?.type.schema !== current.type.schema) {
		comparable = current.type.schema.nodeFromJSON(saved.toJSON());
		inSchema.set(saved, comparable);
	}
	return comparable.eq(current);
}

const lost = { status: "lost" } as const;

export function createChurchEditorStore({
	docId,
	revision,
	body,
	port,
}: {
	docId: string;
	revision: string;
	body: DocDocument;
	port: ChurchEditorPort;
}): StoreApi<ChurchEditorState> {
	const chain = new SaveChain();

	return createStore<ChurchEditorState>()((set, get) => {
		const savedNow = (editor: Editor) => sameAsSaved(get().saved.doc, editor.state.doc);

		const saveNow = (editor: Editor, onRevision: OnRevision): Promise<boolean> => {
			const doc = editor.state.doc;
			const next = documentFrom(get().saved.body, doc.toJSON());
			set({ phase: { kind: "saving" } });
			return chain.start(async () => {
				const result = await port.save(docId, get().saved.revision, next).catch(() => lost);
				if (result.status === "saved") {
					set({ saved: { revision: result.revision, body: next, doc }, phase: { kind: "idle" } });
					onRevision(result.revision, next.exports);
					return true;
				}
				set({
					phase: {
						kind: "failed",
						reason:
							result.status === "refused"
								? result.code === "conflict"
									? "Someone saved a newer revision first. Your edits are still here. Copy them, reload the page, then paste them in."
									: result.message
								: "The connection dropped. Your edits are still here.",
					},
				});
				return false;
			});
		};

		return {
			saved: { revision, body, doc: null },
			phase: { kind: "idle" },
			refused: null,
			actions: {
				began: (editor) => {
					const first = Selection.findFrom(editor.state.doc.resolve(0), 1, true);
					if (first) editor.view.dispatch(editor.state.tr.setSelection(first).setMeta("addToHistory", false));
					if (!get().saved.doc) set((state) => ({ saved: { ...state.saved, doc: editor.state.doc } }));
					editor.on("tableChangeRefused", () => set({ refused: TABLE_REFUSED }));
					editor.on("conditionChangeRefused", (reason: string) => set({ refused: `${reason} Nothing changed.` }));
				},
				edited: (editor) => {
					get().actions.moved();
					if (get().phase.kind === "failed" && savedNow(editor)) set({ phase: { kind: "idle" } });
				},
				moved: () => {
					if (get().refused !== null) set({ refused: null });
				},
				save: (editor, onRevision) =>
					chain.save(
						() => savedNow(editor),
						() => saveNow(editor, onRevision),
					),
				unsaved: (editor) => chain.busy || !savedNow(editor),
			},
		};
	});
}
