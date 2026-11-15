"use client";

import * as React from "react";
import { BUTTON_ICON } from "../styles.ts";

import { useTiptapEditor } from "../use-tiptap-editor.ts";

import { CornerDownLeftIcon, ExternalLinkIcon, LinkIcon, TrashIcon } from "../icons.tsx";

import type { UseLinkPopoverConfig } from "./use-link-popover.ts";
import { useLinkPopover } from "./use-link-popover.ts";

import type { ButtonProps } from "../primitives/button.tsx";
import { Button, ButtonGroup } from "../primitives/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover.tsx";
import { Separator } from "../primitives/separator.tsx";
import { Input, InputGroup } from "../primitives/input.tsx";

interface LinkMainProps {
	url: string;
	error?: string | null;
	setUrl: (url: string) => void;
	setLink: () => void | boolean;
	removeLink: () => void;
	openLink: () => void;
	isActive: boolean;
}

export interface LinkPopoverProps extends Omit<ButtonProps, "type">, UseLinkPopoverConfig {
	onOpenChange?: (isOpen: boolean) => void;
}

const LinkButton = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, children, ...props }, ref) => {
	return (
		<Button
			type="button"
			className={className}
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

const LinkMain: React.FC<LinkMainProps> = ({ url, error, setUrl, setLink, removeLink, openLink, isActive }) => {
	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			setLink();
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
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
					<Button type="button" onClick={setLink} title="Apply link" disabled={!url && !isActive}>
						<CornerDownLeftIcon className={BUTTON_ICON} />
					</Button>
				</ButtonGroup>

				<Separator />

				<ButtonGroup orientation="horizontal">
					<Button type="button" onClick={openLink} title="Open in new window" disabled={!url && !isActive}>
						<ExternalLinkIcon className={BUTTON_ICON} />
					</Button>

					<Button type="button" onClick={removeLink} title="Remove link" disabled={!url && !isActive}>
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

export const LinkPopover = React.forwardRef<HTMLButtonElement, LinkPopoverProps>(
	({ editor: providedEditor, onOpenChange, onClick, children, ...buttonProps }, ref) => {
		const { editor } = useTiptapEditor(providedEditor);
		const [isOpen, setIsOpen] = React.useState(false);

		const { isVisible, canSet, isActive, url, error, setUrl, setLink, removeLink, openLink, label, Icon } =
			useLinkPopover({ editor });

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

		if (!isVisible) {
			return null;
		}

		return (
			<Popover open={isOpen} onOpenChange={handleOnOpenChange}>
				<PopoverTrigger asChild>
					<LinkButton
						disabled={!canSet}
						data-active-state={isActive ? "on" : "off"}
						data-disabled={!canSet || undefined}
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
