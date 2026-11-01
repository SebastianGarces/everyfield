"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";
import type { Editor } from "@tiptap/react";

// --- Hooks ---
import { useIsMobile } from "../use-mobile.ts";
import { useTiptapEditor } from "../use-tiptap-editor.ts";

// --- Icons ---
import { CornerDownLeftIcon, ExternalLinkIcon, LinkIcon, TrashIcon } from "../icons.tsx";

// --- Tiptap UI ---
import type { UseLinkPopoverConfig } from "./use-link-popover.ts";
import { useLinkPopover } from "./use-link-popover.ts";

// --- UI Primitives ---
import type { ButtonProps } from "../primitives/button.tsx";
import { Button, ButtonGroup } from "../primitives/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover.tsx";
import { Separator } from "../primitives/separator.tsx";
import { Input, InputGroup } from "../primitives/input.tsx";

export interface LinkMainProps {
	/**
	 * The URL to set for the link.
	 */
	url: string;
	/**
	 * Why the last attempt to set a link was refused, if it was.
	 */
	error?: string | null;
	/**
	 * Function to update the URL state.
	 */
	setUrl: React.Dispatch<React.SetStateAction<string | null>>;
	/**
	 * Function to set the link in the editor.
	 */
	setLink: () => void | boolean;
	/**
	 * Function to remove the link from the editor.
	 */
	removeLink: () => void;
	/**
	 * Function to open the link.
	 */
	openLink: () => void;
	/**
	 * Whether the link is currently active in the editor.
	 */
	isActive: boolean;
}

export interface LinkPopoverProps extends Omit<ButtonProps, "type">, UseLinkPopoverConfig {
	/**
	 * Callback for when the popover opens or closes.
	 */
	onOpenChange?: (isOpen: boolean) => void;
	/**
	 * Whether to automatically open the popover when a link is active.
	 * @default true
	 */
	autoOpenOnLinkActive?: boolean;
}

/**
 * Link button component for triggering the link popover
 */
export const LinkButton = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, children, ...props }, ref) => {
	return (
		<Button
			type="button"
			className={className}
			data-style="ghost"
			role="button"
			tabIndex={-1}
			aria-label="Link"
			tooltip="Link"
			ref={ref}
			{...props}
		>
			{children || <LinkIcon className={BUTTON_ICON} />}
		</Button>
	);
});

LinkButton.displayName = "LinkButton";

/**
 * Main content component for the link popover
 */
const LinkMain: React.FC<LinkMainProps> = ({ url, error, setUrl, setLink, removeLink, openLink, isActive }) => {
	const isMobile = useIsMobile();

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			setLink();
		}
	};

	return (
		<div className="flex flex-col gap-1.5" data-mobile={isMobile || undefined}>
			<div className="flex items-center gap-1">
				<InputGroup>
					<Input
						type="url"
						placeholder="Paste a link..."
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={handleKeyDown}
						autoFocus
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
					/>
				</InputGroup>

				<ButtonGroup orientation="horizontal">
					<Button type="button" onClick={setLink} title="Apply link" disabled={!url && !isActive} data-style="ghost">
						<CornerDownLeftIcon className={BUTTON_ICON} />
					</Button>
				</ButtonGroup>

				<Separator />

				<ButtonGroup orientation="horizontal">
					<Button
						type="button"
						onClick={openLink}
						title="Open in new window"
						disabled={!url && !isActive}
						data-style="ghost"
					>
						<ExternalLinkIcon className={BUTTON_ICON} />
					</Button>

					<Button
						type="button"
						onClick={removeLink}
						title="Remove link"
						disabled={!url && !isActive}
						data-style="ghost"
					>
						<TrashIcon className={BUTTON_ICON} />
					</Button>
				</ButtonGroup>
			</div>
			{error ? (
				<p role="alert" className="px-1 pb-1 text-sm text-magenta-600">
					{error}
				</p>
			) : null}
		</div>
	);
};

/**
 * Link content component for standalone use
 */
export const LinkContent: React.FC<{
	editor?: Editor | null;
}> = ({ editor }) => {
	const linkPopover = useLinkPopover({
		editor,
	});

	return <LinkMain {...linkPopover} />;
};

/**
 * Link popover component for Tiptap editors.
 *
 * For custom popover implementations, use the `useLinkPopover` hook instead.
 */
export const LinkPopover = React.forwardRef<HTMLButtonElement, LinkPopoverProps>(
	(
		{
			editor: providedEditor,
			hideWhenUnavailable = false,
			onSetLink,
			onOpenChange,
			autoOpenOnLinkActive = true,
			onClick,
			children,
			...buttonProps
		},
		ref,
	) => {
		const { editor } = useTiptapEditor(providedEditor);
		const [isOpen, setIsOpen] = React.useState(false);

		const { isVisible, canSet, isActive, url, error, setUrl, setLink, removeLink, openLink, label, Icon } =
			useLinkPopover({
				editor,
				hideWhenUnavailable,
				onSetLink,
			});

		const handleOnOpenChange = React.useCallback(
			(nextIsOpen: boolean) => {
				setIsOpen(nextIsOpen);
				onOpenChange?.(nextIsOpen);
			},
			[onOpenChange],
		);

		const handleSetLink = React.useCallback(() => {
			if (setLink()) setIsOpen(false);
		}, [setLink]);

		const handleClick = React.useCallback(
			(event: React.MouseEvent<HTMLButtonElement>) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				setIsOpen(!isOpen);
			},
			[onClick, isOpen],
		);

		React.useEffect(() => {
			if (autoOpenOnLinkActive && isActive) {
				setIsOpen(true);
			}
		}, [autoOpenOnLinkActive, isActive]);

		if (!isVisible) {
			return null;
		}

		return (
			<Popover open={isOpen} onOpenChange={handleOnOpenChange}>
				<PopoverTrigger asChild>
					<LinkButton
						disabled={!canSet}
						data-active-state={isActive ? "on" : "off"}
						data-disabled={!canSet}
						aria-label={label}
						aria-pressed={isActive}
						onClick={handleClick}
						{...buttonProps}
						ref={ref}
					>
						{children ?? <Icon className={BUTTON_ICON} />}
					</LinkButton>
				</PopoverTrigger>

				<PopoverContent>
					<LinkMain
						url={url}
						error={error}
						setUrl={setUrl}
						setLink={handleSetLink}
						removeLink={removeLink}
						openLink={openLink}
						isActive={isActive}
					/>
				</PopoverContent>
			</Popover>
		);
	},
);

LinkPopover.displayName = "LinkPopover";

export default LinkPopover;
