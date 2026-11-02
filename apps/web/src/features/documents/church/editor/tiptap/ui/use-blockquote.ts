import * as React from "react";
import type { Editor } from "@tiptap/react";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Icons ---
import { BlockquoteIcon } from "../icons.tsx";

// --- Lib ---
import { isNodeInSchema, isNodeTypeSelected } from "../tiptap-utils.ts";

// Everyfield change: the node is named `quote` in the format, and the toggle is one chain, so one Undo reverts it.
export const BLOCKQUOTE_SHORTCUT_KEY = "mod+shift+b";

export interface UseBlockquoteConfig {
	/** The Tiptap editor instance. */
	editor?: Editor | null;
	/**
	 * Whether the button should hide when the quote is not available.
	 * @default false
	 */
	hideWhenUnavailable?: boolean;
	/** Callback function called after a successful toggle. */
	onToggled?: () => void;
}

export function canToggleBlockquote(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!isNodeInSchema("quote", editor) || isNodeTypeSelected(editor, ["image"])) return false;
	return editor.can().toggleBlockquote();
}

export function isBlockquoteActive(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive("quote");
}

export function toggleBlockquote(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!canToggleBlockquote(editor)) return false;
	return editor.chain().setMeta("closeHistory", true).focus().toggleBlockquote().run();
}

export function shouldShowButton(props: { editor: Editor | null; hideWhenUnavailable: boolean }): boolean {
	const { editor, hideWhenUnavailable } = props;
	if (!editor || !editor.isEditable) return false;
	if (!isNodeInSchema("quote", editor)) return false;
	if (hideWhenUnavailable) return canToggleBlockquote(editor);
	return true;
}

/** Custom hook that provides quote functionality for a Tiptap editor. */
export function useBlockquote(config?: UseBlockquoteConfig) {
	const { editor: providedEditor, hideWhenUnavailable = false, onToggled } = config || {};

	const { editor } = useTiptapEditor(providedEditor);
	const canToggle = canToggleBlockquote(editor);
	const isActive = isBlockquoteActive(editor);
	// Everyfield change: derived on every render, not set in an effect (see use-mark.ts).
	const isVisible = shouldShowButton({ editor, hideWhenUnavailable });

	const handleToggle = React.useCallback(() => {
		if (!editor) return false;
		const success = toggleBlockquote(editor);
		if (success) onToggled?.();
		return success;
	}, [editor, onToggled]);

	return {
		isVisible,
		isActive,
		handleToggle,
		canToggle,
		label: "Quote",
		shortcutKeys: BLOCKQUOTE_SHORTCUT_KEY,
		Icon: BlockquoteIcon,
	};
}
