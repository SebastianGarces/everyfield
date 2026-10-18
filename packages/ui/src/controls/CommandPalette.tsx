"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Icon } from "../foundations";
import { Kbd } from "./Field";
import { usePortalContainer, useReturnFocus } from "./overlay-portal";
import { Spinner } from "./Spinner";

export type CommandItem = {
	id: string;
	label: string;
	/** Leading art: an Avatar, an icon or EvryBot size xs. Decorative. */
	art?: ReactNode;
	/** Right-hand detail, such as the person's stage. Also searched. */
	meta?: string;
	keywords?: string[];
	onSelect: () => void;
};
export type CommandGroup = { heading: string; items: CommandItem[] };

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	groups: CommandGroup[];
	placeholder?: string;
	/** Controlled query, for pages that search on the server. Then pass filter={false}. */
	query?: string;
	onQueryChange?: (query: string) => void;
	/** false when the caller already filtered the groups for the query. */
	filter?: boolean;
	loading?: boolean;
	/** A failed search says so and never looks like "No results". */
	error?: { message: string; onRetry: () => void };
	emptyText?: string;
	/** Keyboard hints in the footer, such as ["↑↓ move", "↵ open", "⌘J ask Evry"]. */
	hints?: string[];
};

/**
 * CommandPalette (components.md): a modal dialog with a search combobox, grouped results and a hint footer. Arrow keys
 * move through results, Enter opens one, Esc closes and returns focus. The caller opens it from Search and ⌘K.
 */
export function CommandPalette({
	open,
	onOpenChange,
	groups,
	placeholder = "Search people, meetings, articles",
	query,
	onQueryChange,
	filter = true,
	loading,
	error,
	emptyText = "No results",
	hints = ["↑↓ move", "↵ open", "esc close"],
}: CommandPaletteProps) {
	const container = usePortalContainer();
	const focus = useReturnFocus();
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal container={container}>
				<DialogPrimitive.Overlay className="ef-scrim fixed inset-0 z-50 bg-ink-fixed/28 backdrop-blur-[2px]" />
				<DialogPrimitive.Content
					{...focus}
					aria-modal="true"
					aria-describedby={undefined}
					className="ef-dialog fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-24px)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-[24px] bg-surface-raised text-md text-ink shadow-pop outline-none max-app-sm:top-3"
				>
					<DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
					<Command shouldFilter={filter} loop label="Search">
						<div className="flex items-center gap-3 border-b border-line px-5 py-[18px]">
							<Icon icon={Search01Icon} size={20} className="text-text-3" />
							<Command.Input
								value={query}
								onValueChange={onQueryChange}
								placeholder={placeholder}
								className="min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-text-3 focus-visible:outline-none"
							/>
							<Kbd>esc</Kbd>
						</div>
						<Command.List className="max-h-[min(420px,60dvh)] overflow-y-auto p-2">
							{error ? (
								<div role="alert" className="flex flex-col items-start gap-2 px-2.5 py-4 text-text-2">
									{error.message}
									<button
										type="button"
										onClick={error.onRetry}
										className="cursor-pointer rounded-xs font-medium text-ink underline underline-offset-[3px]"
									>
										Try again
									</button>
								</div>
							) : loading ? (
								<Command.Loading>
									<div className="flex items-center gap-2.5 px-2.5 py-4 text-text-3">
										<Spinner size={14} />
										Searching…
									</div>
								</Command.Loading>
							) : (
								<Command.Empty className="px-2.5 py-4 text-text-3">{emptyText}</Command.Empty>
							)}
							{error || loading
								? null
								: groups.map((g) => (
										<Command.Group
											key={g.heading}
											heading={g.heading}
											className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-text-3"
										>
											{g.items.map((item) => (
												<Command.Item
													key={item.id}
													value={`${item.label} ${item.id}`}
													keywords={[...(item.keywords ?? []), ...(item.meta ? [item.meta] : [])]}
													onSelect={() => {
														item.onSelect();
														onOpenChange(false);
													}}
													className="flex h-[42px] cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 transition-[background-color] duration-150 select-none data-[selected=true]:bg-surface-2"
												>
													{item.art}
													<span className="min-w-0 flex-1 truncate">{item.label}</span>
													{item.meta ? <span className="flex-none text-sm text-text-3">{item.meta}</span> : null}
												</Command.Item>
											))}
										</Command.Group>
									))}
						</Command.List>
					</Command>
					<div
						aria-hidden="true"
						className="flex gap-4 border-t border-line bg-surface px-[18px] py-2.5 text-xs text-text-3 max-app-sm:hidden"
					>
						{hints.map((h) => (
							<span key={h}>{h}</span>
						))}
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
