"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

// --- Lib ---
import { parseShortcutKeys } from "../tiptap-utils.ts";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Tiptap UI ---
import type { Mark, UseMarkConfig } from "./use-mark.ts";
import { MARK_SHORTCUT_KEYS, useMark } from "./use-mark.ts";

// --- UI Primitives ---
import type { ButtonProps } from "../primitives/button.tsx";
import { Button } from "../primitives/button.tsx";

export interface MarkButtonProps extends Omit<ButtonProps, "type">, UseMarkConfig {
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

export function MarkShortcutBadge({
	type,
	shortcutKeys = MARK_SHORTCUT_KEYS[type],
}: {
	type: Mark;
	shortcutKeys?: string;
}) {
	return <kbd className="ml-1 text-xs opacity-70">{parseShortcutKeys({ shortcutKeys })}</kbd>;
}

/**
 * Button component for toggling marks in a Tiptap editor.
 *
 * For custom button implementations, use the `useMark` hook instead.
 */
export const MarkButton = React.forwardRef<HTMLButtonElement, MarkButtonProps>(
	(
		{
			editor: providedEditor,
			type,
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
		const { isVisible, handleMark, label, canToggle, isActive, Icon, shortcutKeys } = useMark({
			editor,
			type,
			hideWhenUnavailable,
			onToggled,
		});

		const handleClick = React.useCallback(
			(event: React.MouseEvent<HTMLButtonElement>) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				handleMark();
			},
			[handleMark, onClick],
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
						{showShortcut && <MarkShortcutBadge type={type} shortcutKeys={shortcutKeys} />}
					</>
				)}
			</Button>
		);
	},
);

MarkButton.displayName = "MarkButton";
