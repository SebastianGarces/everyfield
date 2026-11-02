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
export type ListType = "bulletList" | "orderedList";

export interface UseListConfig {
	/** The Tiptap editor instance. */
	editor?: Editor | null;
	/** The type of list to toggle. */
	type: ListType;
	/**
	 * Whether the button should hide when the list is not available.
	 * @default false
	 */
	hideWhenUnavailable?: boolean;
	/** Callback function called after a successful toggle. */
	onToggled?: () => void;
}

export const listIcons = {
	bulletList: ListIcon,
	orderedList: ListOrderedIcon,
};

export const listLabels: Record<ListType, string> = {
	bulletList: "Bulleted list",
	orderedList: "Numbered list",
};

export const LIST_SHORTCUT_KEYS: Record<ListType, string> = {
	bulletList: "mod+shift+8",
	orderedList: "mod+shift+7",
};

export function canToggleList(editor: Editor | null, type: ListType): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!isNodeInSchema(type, editor) || isNodeTypeSelected(editor, ["image"])) return false;
	return type === "bulletList" ? editor.can().toggleBulletList() : editor.can().toggleOrderedList();
}

export function isListActive(editor: Editor | null, type: ListType): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive(type);
}

export function toggleList(editor: Editor | null, type: ListType): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!canToggleList(editor, type)) return false;
	const chain = editor.chain().setMeta("closeHistory", true).focus();
	return (type === "bulletList" ? chain.toggleBulletList() : chain.toggleOrderedList()).run();
}

export function shouldShowButton(props: {
	editor: Editor | null;
	type: ListType;
	hideWhenUnavailable: boolean;
}): boolean {
	const { editor, type, hideWhenUnavailable } = props;
	if (!editor || !editor.isEditable) return false;
	if (!isNodeInSchema(type, editor)) return false;
	if (hideWhenUnavailable) return canToggleList(editor, type);
	return true;
}

/** Custom hook that provides list functionality for a Tiptap editor. */
export function useList(config: UseListConfig) {
	const { editor: providedEditor, type, hideWhenUnavailable = false, onToggled } = config;

	const { editor } = useTiptapEditor(providedEditor);
	const canToggle = canToggleList(editor, type);
	const isActive = isListActive(editor, type);
	// Everyfield change: derived on every render, not set in an effect (see use-mark.ts).
	const isVisible = shouldShowButton({ editor, type, hideWhenUnavailable });

	const handleToggle = React.useCallback(() => {
		if (!editor) return false;
		const success = toggleList(editor, type);
		if (success) onToggled?.();
		return success;
	}, [editor, type, onToggled]);

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
