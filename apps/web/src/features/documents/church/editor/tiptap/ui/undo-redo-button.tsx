"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Tiptap UI ---
import type { UseUndoRedoConfig } from "./use-undo-redo.ts";
import { useUndoRedo } from "./use-undo-redo.ts";

// --- UI Primitives ---
import type { ButtonProps } from "../primitives/button.tsx";
import { Button } from "../primitives/button.tsx";

export interface UndoRedoButtonProps extends Omit<ButtonProps, "type">, UseUndoRedoConfig {}

/**
 * Button component for triggering undo/redo actions in a Tiptap editor.
 *
 * For custom button implementations, use the `useHistory` hook instead.
 */
export const UndoRedoButton = React.forwardRef<HTMLButtonElement, UndoRedoButtonProps>(
	({ editor: providedEditor, action, onClick, children, ...buttonProps }, ref) => {
		const { editor } = useTiptapEditor(providedEditor);
		const { isVisible, handleAction, label, canExecute, Icon } = useUndoRedo({
			editor,
			action,
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
				data-disabled={!canExecute || undefined}
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
					</>
				)}
			</Button>
		);
	},
);

UndoRedoButton.displayName = "UndoRedoButton";
