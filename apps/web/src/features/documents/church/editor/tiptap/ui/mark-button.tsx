"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Tiptap UI ---
import type { UseMarkConfig } from "./use-mark.ts";
import { useMark } from "./use-mark.ts";

// --- UI Primitives ---
import type { ButtonProps } from "../primitives/button.tsx";
import { Button } from "../primitives/button.tsx";

export interface MarkButtonProps extends Omit<ButtonProps, "type">, UseMarkConfig {}

/**
 * Button component for toggling marks in a Tiptap editor.
 *
 * For custom button implementations, use the `useMark` hook instead.
 */
export const MarkButton = React.forwardRef<HTMLButtonElement, MarkButtonProps>(
	({ editor: providedEditor, type, onClick, children, ...buttonProps }, ref) => {
		const { editor } = useTiptapEditor(providedEditor);
		const { isVisible, handleMark, label, canToggle, isActive, Icon } = useMark({
			editor,
			type,
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
				data-active-state={isActive ? "on" : "off"}
				data-disabled={!canToggle || undefined}
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
					</>
				)}
			</Button>
		);
	},
);

MarkButton.displayName = "MarkButton";
