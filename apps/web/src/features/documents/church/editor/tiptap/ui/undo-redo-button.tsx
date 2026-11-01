"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

// --- Lib ---
import { parseShortcutKeys } from "../tiptap-utils.ts";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Tiptap UI ---
import type { UndoRedoAction, UseUndoRedoConfig } from "./use-undo-redo.ts";
import { UNDO_REDO_SHORTCUT_KEYS, useUndoRedo } from "./use-undo-redo.ts";

// --- UI Primitives ---
import type { ButtonProps } from "../primitives/button.tsx";
import { Button } from "../primitives/button.tsx";

export interface UndoRedoButtonProps extends Omit<ButtonProps, "type">, UseUndoRedoConfig {
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

export function HistoryShortcutBadge({
	action,
	shortcutKeys = UNDO_REDO_SHORTCUT_KEYS[action],
}: {
	action: UndoRedoAction;
	shortcutKeys?: string;
}) {
	return <kbd className="ml-1 text-xs opacity-70">{parseShortcutKeys({ shortcutKeys })}</kbd>;
}

/**
 * Button component for triggering undo/redo actions in a Tiptap editor.
 *
 * For custom button implementations, use the `useHistory` hook instead.
 */
export const UndoRedoButton = React.forwardRef<HTMLButtonElement, UndoRedoButtonProps>(
	(
		{
			editor: providedEditor,
			action,
			text,
			hideWhenUnavailable = false,
			onExecuted,
			showShortcut = false,
			onClick,
			children,
			...buttonProps
		},
		ref,
	) => {
		const { editor } = useTiptapEditor(providedEditor);
		const { isVisible, handleAction, label, canExecute, Icon, shortcutKeys } = useUndoRedo({
			editor,
			action,
			hideWhenUnavailable,
			onExecuted,
		});

		const handleClick = React.useCallback(
			(event: React.MouseEvent<HTMLButtonElement>) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				handleAction();
			},
			[handleAction, onClick],
		);

		if (!isVisible) {
			return null;
		}

		return (
			<Button
				type="button"
				disabled={!canExecute}
				data-style="ghost"
				data-disabled={!canExecute}
				role="button"
				tabIndex={-1}
				aria-label={label}
				tooltip={label}
				onClick={handleClick}
				{...buttonProps}
				ref={ref}
			>
				{children ?? (
					<>
						<Icon className={BUTTON_ICON} />
						{text && <span className="text-sm">{text}</span>}
						{showShortcut && <HistoryShortcutBadge action={action} shortcutKeys={shortcutKeys} />}
					</>
				)}
			</Button>
		);
	},
);

UndoRedoButton.displayName = "UndoRedoButton";
