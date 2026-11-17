"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

import { useTiptapEditor } from "../use-tiptap-editor.ts";

import type { UseUndoRedoConfig } from "./use-undo-redo.ts";
import { useUndoRedo } from "./use-undo-redo.ts";

import type { ButtonProps } from "../primitives/button.tsx";
import { Button } from "../primitives/button.tsx";

export interface UndoRedoButtonProps extends Omit<ButtonProps, "type">, UseUndoRedoConfig {}

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
