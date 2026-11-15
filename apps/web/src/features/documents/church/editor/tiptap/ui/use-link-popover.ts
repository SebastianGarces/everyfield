import * as React from "react";
import type { Editor } from "@tiptap/react";

import { useTiptapEditor } from "../use-tiptap-editor.ts";

import { LinkIcon } from "../icons.tsx";

import { isMarkInSchema, sanitizeUrl } from "../tiptap-utils.ts";
import { isAllowedLink } from "../../extensions.ts";

export interface UseLinkPopoverConfig {
	editor?: Editor | null;
}

export interface LinkHandlerProps {
	editor: Editor | null;
}

function canSetLink(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.can().setMark("link");
}

function isLinkActive(editor: Editor | null): boolean {
	if (!editor || !editor.isEditable) return false;
	return editor.isActive("link");
}

function shouldShowLinkButton(props: { editor: Editor | null }): boolean {
	const { editor } = props;

	return isMarkInSchema("link", editor) && !!editor;
}

function useLinkHandler(props: LinkHandlerProps) {
	const { editor } = props;
	const [draft, setDraft] = React.useState<{ at: Editor["state"]["selection"]; url: string } | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const selection = editor?.state.selection;
	const url = draft && draft.at === selection ? draft.url : editor?.getAttributes("link").href || "";

	const setLink = React.useCallback((): boolean => {
		if (!url || !editor) return false;
		if (!isAllowedLink(url)) {
			setError("A link must start with https://, http:// or mailto:. No link was added.");
			return false;
		}
		setError(null);

		const { selection } = editor.state;
		const isEmpty = selection.empty;

		let chain = editor.chain().focus();

		chain = chain.extendMarkRange("link").setLink({ href: url });

		if (isEmpty && !editor.isActive("link")) {
			chain = chain.insertContent({ type: "text", text: url });
		}

		chain.run();

		setDraft(null);

		return true;
	}, [editor, url]);

	const removeLink = React.useCallback(() => {
		if (!editor) return;
		editor.chain().focus().extendMarkRange("link").unsetLink().setMeta("preventAutolink", true).run();
		setDraft(null);
	}, [editor]);

	const openLink = React.useCallback(
		(target: string = "_blank", features: string = "noopener,noreferrer") => {
			if (!url) return;

			const safeUrl = sanitizeUrl(url, window.location.href);
			if (safeUrl !== "#") {
				window.open(safeUrl, target, features);
			}
		},
		[url],
	);

	return {
		url,
		error,
		setUrl: (next: string) => {
			setError(null);
			setDraft(selection ? { at: selection, url: next } : null);
		},
		setLink,
		removeLink,
		openLink,
	};
}

function useLinkState(props: { editor: Editor | null }) {
	const { editor } = props;

	const canSet = canSetLink(editor);
	const isActive = isLinkActive(editor);

	const isVisible = shouldShowLinkButton({ editor });

	return {
		isVisible,
		canSet,
		isActive,
	};
}

export function useLinkPopover(config?: UseLinkPopoverConfig) {
	const { editor: providedEditor } = config || {};

	const { editor } = useTiptapEditor(providedEditor);

	const { isVisible, canSet, isActive } = useLinkState({ editor });

	const linkHandler = useLinkHandler({ editor });

	return {
		isVisible,
		canSet,
		isActive,
		label: "Link",
		Icon: LinkIcon,
		...linkHandler,
	};
}
