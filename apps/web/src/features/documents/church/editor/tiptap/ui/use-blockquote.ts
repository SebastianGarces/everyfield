import * as React from "react";
import type { Editor } from "@tiptap/react";

import { useTiptapEditor } from "../use-tiptap-editor.ts";

import { BlockquoteIcon } from "../icons.tsx";

import { isNodeInSchema, isNodeTypeSelected } from "../tiptap-utils.ts";

const BLOCKQUOTE_SHORTCUT_KEY = "mod+shift+b";

export interface UseBlockquoteConfig {
	editor?: Editor | null;
}

function canToggleBlockquote(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!isNodeInSchema("quote", editor) || isNodeTypeSelected(editor, ["image"])) return false;
	return editor.can().toggleBlockquote();
}

function isBlockquoteActive(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive("quote");
}

function toggleBlockquote(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	if (!canToggleBlockquote(editor)) return false;
	return editor.chain().setMeta("closeHistory", true).focus().toggleBlockquote().run();
}

function shouldShowButton(props: { editor: Editor | null }): boolean {
	const { editor } = props;
	if (!editor || !editor.isEditable) return false;
	return isNodeInSchema("quote", editor);
}

export function useBlockquote(config?: UseBlockquoteConfig) {
	const { editor: providedEditor } = config || {};

	const { editor } = useTiptapEditor(providedEditor);
	const canToggle = canToggleBlockquote(editor);
	const isActive = isBlockquoteActive(editor);
	const isVisible = shouldShowButton({ editor });

	const handleToggle = React.useCallback(() => {
		if (!editor) return false;
		return toggleBlockquote(editor);
	}, [editor]);

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
