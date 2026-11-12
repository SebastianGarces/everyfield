import * as React from "react";
import type { Editor } from "@tiptap/react";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Icons ---
import { ListIcon, ListOrderedIcon } from "../icons.tsx";

// --- Lib ---
import { isNodeInSchema, isNodeTypeSelected } from "../tiptap-utils.ts";

// Everyfield change: only bullet and ordered lists (the format has no task list), and the toggle is one chain, so one
// Undo reverts it. Tiptap's version dispatches a node selection first, which would make Undo take two steps.
type ListType = "bulletList" | "orderedList";

export interface UseListConfig {
	/** The Tiptap editor instance. */
	editor?: Editor | null;
	/** The type of list to toggle. */
	type: ListType;
}

const listIcons = {
	bulletList: ListIcon,
	orderedList: ListOrderedIcon,
};

const listLabels: Record<ListType, string> = {
	bulletList: "Bulleted list",
	orderedList: "Numbered list",
};

const LIST_SHORTCUT_KEYS: Record<ListType, string> = {
	bulletList: "mod+shift+8",
	orderedList: "mod+shift+7",
};

function canToggleList(editor: Editor | null, type: ListType): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!isNodeInSchema(type, editor) || isNodeTypeSelected(editor, ["image"])) return false;
	return type === "bulletList" ? editor.can().toggleBulletList() : editor.can().toggleOrderedList();
}

function isListActive(editor: Editor | null, type: ListType): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive(type);
}

function toggleList(editor: Editor | null, type: ListType): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!canToggleList(editor, type)) return false;
	const chain = editor.chain().setMeta("closeHistory", true).focus();
	return (type === "bulletList" ? chain.toggleBulletList() : chain.toggleOrderedList()).run();
}

function shouldShowButton(props: { editor: Editor | null; type: ListType }): boolean {
	const { editor, type } = props;
	if (!editor || !editor.isEditable) return false;
	return isNodeInSchema(type, editor);
}

/** Custom hook that provides list functionality for a Tiptap editor. */
export function useList(config: UseListConfig) {
	const { editor: providedEditor, type } = config;

	const { editor } = useTiptapEditor(providedEditor);
	const canToggle = canToggleList(editor, type);
	const isActive = isListActive(editor, type);
	// Everyfield change: derived on every render, not set in an effect (see use-mark.ts).
	const isVisible = shouldShowButton({ editor, type });

	const handleToggle = React.useCallback(() => {
		if (!editor) return false;
		return toggleList(editor, type);
	}, [editor, type]);

	return {
		isVisible,
		isActive,
		handleToggle,
		canToggle,
		label: listLabels[type],
		shortcutKeys: LIST_SHORTCUT_KEYS[type],
		Icon: listIcons[type],
	};
}
