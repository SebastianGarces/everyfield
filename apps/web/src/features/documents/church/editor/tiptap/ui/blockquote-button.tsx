"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

// --- Lib ---
import { parseShortcutKeys } from "../tiptap-utils.ts";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Tiptap UI ---
import type { UseBlockquoteConfig } from "./use-blockquote.ts";
import { BLOCKQUOTE_SHORTCUT_KEY, useBlockquote } from "./use-blockquote.ts";

// --- UI Primitives ---
import type { ButtonProps } from "../primitives/button.tsx";
import { Button } from "../primitives/button.tsx";

export interface BlockquoteButtonProps extends Omit<ButtonProps, "type">, UseBlockquoteConfig {
	/**
	 * Optional text to display alongside the icon.
	 */
	text?: string;
	/**
	 * Optional show shortcut keys in the button.
	 * @default false
	 */
	showShortcut?: boolean;
}

export function BlockquoteShortcutBadge({ shortcutKeys = BLOCKQUOTE_SHORTCUT_KEY }: { shortcutKeys?: string }) {
	return <kbd className="ml-1 text-xs opacity-70">{parseShortcutKeys({ shortcutKeys })}</kbd>;
}

/**
 * Button component for toggling a quote in a Tiptap editor.
 *
 * For custom button implementations, use the `useBlockquote` hook instead.
 */
export const BlockquoteButton = React.forwardRef<HTMLButtonElement, BlockquoteButtonProps>(
	(
		{
			editor: providedEditor,
			text,
			hideWhenUnavailable = false,
			onToggled,
			showShortcut = false,
			onClick,
			children,
			...buttonProps
		},
		ref,
	) => {
		const { editor } = useTiptapEditor(providedEditor);
		const { isVisible, handleToggle, label, canToggle, isActive, Icon, shortcutKeys } = useBlockquote({
			editor,
			hideWhenUnavailable,
			onToggled,
		});

		const handleClick = React.useCallback(
			(event: React.MouseEvent<HTMLButtonElement>) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				handleToggle();
			},
			[handleToggle, onClick],
		);

		if (!isVisible) {
			return null;
		}

		return (
			<Button
				type="button"
				disabled={!canToggle}
				data-style="ghost"
				data-active-state={isActive ? "on" : "off"}
				data-disabled={!canToggle}
				role="button"
				tabIndex={-1}
				aria-label={label}
				aria-pressed={isActive}
				tooltip={label}
				onClick={handleClick}
				{...buttonProps}
				ref={ref}
			>
				{children ?? (
					<>
						<Icon className={BUTTON_ICON} />
						{text && <span className="text-sm">{text}</span>}
						{showShortcut && <BlockquoteShortcutBadge shortcutKeys={shortcutKeys} />}
					</>
				)}
			</Button>
		);
	},
);

BlockquoteButton.displayName = "BlockquoteButton";
