import * as React from "react";
import type { Editor } from "@tiptap/react";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Lib ---
import { isMarkInSchema, isNodeTypeSelected } from "../tiptap-utils.ts";

// --- Icons ---
import { BoldIcon, ItalicIcon, UnderlineIcon } from "../icons.tsx";

export type Mark = "bold" | "italic" | "underline";

/**
 * Configuration for the mark functionality
 */
export interface UseMarkConfig {
	/**
	 * The Tiptap editor instance.
	 */
	editor?: Editor | null;
	/**
	 * The type of mark to toggle
	 */
	type: Mark;
}

export const markIcons = {
	bold: BoldIcon,
	italic: ItalicIcon,
	underline: UnderlineIcon,
};

export const MARK_SHORTCUT_KEYS: Record<Mark, string> = {
	bold: "mod+b",
	italic: "mod+i",
	underline: "mod+u",
};

/**
 * Checks if a mark can be toggled in the current editor state
 */
export function canToggleMark(editor: Editor | null, type: Mark): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!isMarkInSchema(type, editor) || isNodeTypeSelected(editor, ["image"])) return false;

	return editor.can().toggleMark(type);
}

/**
 * Checks if a mark is currently active
 */
export function isMarkActive(editor: Editor | null, type: Mark): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive(type);
}

/**
 * Toggles a mark in the editor
 */
export function toggleMark(editor: Editor | null, type: Mark): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!canToggleMark(editor, type)) return false;

	return editor.chain().focus().toggleMark(type).run();
}

/**
 * Determines if the mark button should be shown
 */
export function shouldShowButton(props: { editor: Editor | null; type: Mark }): boolean {
	const { editor, type } = props;

	if (!editor || !editor.isEditable) return false;
	return isMarkInSchema(type, editor);
}

/**
 * Gets the formatted mark name
 */
export function getFormattedMarkName(type: Mark): string {
	return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Custom hook that provides mark functionality for Tiptap editor
 *
 * @example
 * ```tsx
 * // Simple usage
 * function MySimpleBoldButton() {
 *   const { isVisible, handleMark } = useMark({ type: "bold" })
 *
 *   if (!isVisible) return null
 *
 *   return <button onClick={handleMark}>Bold</button>
 * }
 *
 * // Advanced usage with configuration
 * function MyAdvancedItalicButton() {
 *   const { isVisible, handleMark, label, isActive } = useMark({
 *     editor: myEditor,
 *     type: "italic",
 *   })
 *
 *   if (!isVisible) return null
 *
 *   return (
 *     <MyButton
 *       onClick={handleMark}
 *       aria-pressed={isActive}
 *       aria-label={label}
 *     >
 *       Italic
 *     </MyButton>
 *   )
 * }
 * ```
 */
export function useMark(config: UseMarkConfig) {
	const { editor: providedEditor, type } = config;

	const { editor } = useTiptapEditor(providedEditor);
	const canToggle = canToggleMark(editor, type);
	const isActive = isMarkActive(editor, type);
	// Everyfield change: derive visibility from the editor state on every render. Tiptap's copy set it in an effect
	// that ran before the view mounted, so Bold, Italic and Underline stayed hidden until the first selection change.
	const isVisible = shouldShowButton({ editor, type });

	const handleMark = React.useCallback(() => {
		if (!editor) return false;

		return toggleMark(editor, type);
	}, [editor, type]);

	return {
		isVisible,
		isActive,
		handleMark,
		canToggle,
		label: getFormattedMarkName(type),
		shortcutKeys: MARK_SHORTCUT_KEYS[type],
		Icon: markIcons[type],
	};
}
