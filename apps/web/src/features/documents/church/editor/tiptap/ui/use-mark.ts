import * as React from "react";
import type { Editor } from "@tiptap/react";

import { useTiptapEditor } from "../use-tiptap-editor.ts";

import { isMarkInSchema, isNodeTypeSelected } from "../tiptap-utils.ts";

import { BoldIcon, ItalicIcon, UnderlineIcon } from "../icons.tsx";

type Mark = "bold" | "italic" | "underline";

export interface UseMarkConfig {
	editor?: Editor | null;
	type: Mark;
}

const markIcons = {
	bold: BoldIcon,
	italic: ItalicIcon,
	underline: UnderlineIcon,
};

const MARK_SHORTCUT_KEYS: Record<Mark, string> = {
	bold: "mod+b",
	italic: "mod+i",
	underline: "mod+u",
};

function canToggleMark(editor: Editor | null, type: Mark): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!isMarkInSchema(type, editor) || isNodeTypeSelected(editor, ["image"])) return false;

	return editor.can().toggleMark(type);
}

function isMarkActive(editor: Editor | null, type: Mark): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive(type);
}

function toggleMark(editor: Editor | null, type: Mark): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!canToggleMark(editor, type)) return false;

	return editor.chain().focus().toggleMark(type).run();
}

function shouldShowButton(props: { editor: Editor | null; type: Mark }): boolean {
	const { editor, type } = props;

	if (!editor || !editor.isEditable) return false;
	return isMarkInSchema(type, editor);
}

function getFormattedMarkName(type: Mark): string {
	return type.charAt(0).toUpperCase() + type.slice(1);
}

export function useMark(config: UseMarkConfig) {
	const { editor: providedEditor, type } = config;

	const { editor } = useTiptapEditor(providedEditor);
	const canToggle = canToggleMark(editor, type);
	const isActive = isMarkActive(editor, type);
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
