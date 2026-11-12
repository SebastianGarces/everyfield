"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

// --- Hooks ---
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Tiptap UI ---
import type { UseBlockquoteConfig } from "./use-blockquote.ts";
import { useBlockquote } from "./use-blockquote.ts";

// --- UI Primitives ---
import type { ButtonProps } from "../primitives/button.tsx";
import { Button } from "../primitives/button.tsx";

export interface BlockquoteButtonProps extends Omit<ButtonProps, "type">, UseBlockquoteConfig {}

/**
 * Button component for toggling a quote in a Tiptap editor.
 *
 * For custom button implementations, use the `useBlockquote` hook instead.
 */
export const BlockquoteButton = React.forwardRef<HTMLButtonElement, BlockquoteButtonProps>(
	({ editor: providedEditor, onClick, children, ...buttonProps }, ref) => {
		const { editor } = useTiptapEditor(providedEditor);
		const { isVisible, handleToggle, label, canToggle, isActive, Icon } = useBlockquote({
			editor,
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

BlockquoteButton.displayName = "BlockquoteButton";
