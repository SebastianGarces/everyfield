import * as React from "react";
import { type Editor } from "@tiptap/react";

import { useTiptapEditor } from "../use-tiptap-editor.ts";

import { Redo2Icon, Undo2Icon } from "../icons.tsx";

type UndoRedoAction = "undo" | "redo";

export interface UseUndoRedoConfig {
	editor?: Editor | null;
	action: UndoRedoAction;
}

const UNDO_REDO_SHORTCUT_KEYS: Record<UndoRedoAction, string> = {
	undo: "mod+z",
	redo: "mod+shift+z",
};

const historyActionLabels: Record<UndoRedoAction, string> = {
	undo: "Undo",
	redo: "Redo",
};

const historyIcons = {
	undo: Undo2Icon,
	redo: Redo2Icon,
};

function canExecuteUndoRedoAction(editor: Editor | null, action: UndoRedoAction): boolean {
	if (!editor || !editor.isEditable) return false;

	return action === "undo" ? editor.can().undo() : editor.can().redo();
}

function executeUndoRedoAction(editor: Editor | null, action: UndoRedoAction): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!canExecuteUndoRedoAction(editor, action)) return false;

	const chain = editor.chain().focus();
	return action === "undo" ? chain.undo().run() : chain.redo().run();
}

function shouldShowButton(props: { editor: Editor | null }): boolean {
	const { editor } = props;

	return !!editor && editor.isEditable;
}

export function useUndoRedo(config: UseUndoRedoConfig) {
	const { editor: providedEditor, action } = config;

	const { editor } = useTiptapEditor(providedEditor);
	const subscribe = React.useCallback(
		(changed: () => void) => {
			if (!editor) return () => {};
			editor.on("mount", changed);
			editor.on("transaction", changed);
			return () => {
				editor.off("mount", changed);
				editor.off("transaction", changed);
			};
		},
		[editor],
	);
	const isVisible = React.useSyncExternalStore(
		subscribe,
		() => !editor || shouldShowButton({ editor }),
		() => true,
	);
	const canExecute = canExecuteUndoRedoAction(editor, action);

	const handleAction = React.useCallback(() => {
		if (!editor) return false;

		return executeUndoRedoAction(editor, action);
	}, [editor, action]);

	return {
		isVisible,
		handleAction,
		canExecute,
		label: historyActionLabels[action],
		shortcutKeys: UNDO_REDO_SHORTCUT_KEYS[action],
		Icon: historyIcons[action],
	};
}
