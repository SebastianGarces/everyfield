"use client";

import { ArrowDown01Icon, Cancel01Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Command } from "cmdk";
import { useState } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { inputBox, inputInvalid, useFieldControl } from "./Field";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import { Spinner } from "./Spinner";

export type ComboboxOption = { value: string; label: string; description?: string; disabled?: boolean };

type ListProps = {
	options: ComboboxOption[];
	value: string[];
	onSelect: (value: string) => void;
	searchLabel: string;
	multiple: boolean;
	loading?: boolean;
	error?: { message: string; onRetry: () => void };
	emptyText?: string;
};

function OptionList({
	options,
	value,
	onSelect,
	searchLabel,
	multiple,
	loading,
	error,
	emptyText = "No matches",
}: ListProps) {
	return (
		<Command loop className="flex flex-col">
			<div className="flex items-center gap-2.5 border-b border-line px-2.5 pb-1.5">
				<Icon icon={Search01Icon} size={16} className="text-text-3" />
				<Command.Input
					placeholder={searchLabel}
					aria-label={searchLabel}
					className="h-10 min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-text-3 focus-visible:outline-none"
				/>
			</div>
			<Command.List className="max-h-[280px] overflow-y-auto pt-1.5" aria-label={searchLabel}>
				{error ? (
					<div role="alert" className="flex flex-col items-start gap-2 px-2.5 py-3 text-sm text-text-2">
						<span>{error.message}</span>
						<button
							type="button"
							onClick={error.onRetry}
							className="rounded-xs font-medium text-ink underline underline-offset-[3px]"
						>
							Try again
						</button>
					</div>
				) : loading ? (
					<Command.Loading>
						<div className="flex items-center gap-2.5 px-2.5 py-3 text-sm text-text-3">
							<Spinner size={14} />
							Loading options…
						</div>
					</Command.Loading>
				) : (
					<Command.Empty className="px-2.5 py-3 text-sm text-text-3">{emptyText}</Command.Empty>
				)}
				{error || loading
					? null
					: options.map((o) => {
							const checked = value.includes(o.value);
							return (
								<Command.Item
									key={o.value}
									value={o.label}
									keywords={o.description ? [o.description] : undefined}
									disabled={o.disabled}
									onSelect={() => onSelect(o.value)}
									className="relative flex min-h-[38px] items-center gap-2.5 rounded-md px-2.5 py-1.5 text-md text-ink transition-[background-color] duration-150 select-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-surface-2"
								>
									{multiple ? (
										<span
											aria-hidden="true"
											className={cn(
												"grid size-[18px] flex-none place-items-center rounded-xs",
												checked ? "bg-ink text-on-ink" : "shadow-[inset_0_0_0_1.5px_var(--ef-text-3)]",
											)}
										>
											{checked ? <Icon icon={Tick02Icon} size={16} /> : null}
										</span>
									) : null}
									<span className="min-w-0 flex-1">
										<span className="block truncate">{o.label}</span>
										{o.description ? <span className="block truncate text-xs text-text-3">{o.description}</span> : null}
									</span>
									{!multiple && checked ? <Icon icon={Tick02Icon} size={16} className="text-ink-2" /> : null}
									{checked ? <span className="sr-only">, selected</span> : null}
								</Command.Item>
							);
						})}
			</Command.List>
		</Command>
	);
}

type ComboboxProps = Omit<ListProps, "onSelect" | "multiple"> & {
	onValueChange: (value: string[]) => void;
	multiple?: boolean;
	placeholder?: string;
	invalid?: boolean;
	id?: string;
	className?: string;
	onOpenChange?: (open: boolean) => void;
};

function toggle(value: string[], v: string, multiple: boolean) {
	if (!multiple) return [v];
	return value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
}

export function Combobox({
	options,
	value,
	onValueChange,
	multiple = false,
	placeholder = "Choose",
	invalid,
	id,
	className,
	onOpenChange,
	...list
}: ComboboxProps) {
	const [open, setOpen] = useState(false);
	const control = useFieldControl({ id, "aria-invalid": invalid, trigger: true });
	const labels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				onOpenChange?.(next);
			}}
		>
			<PopoverTrigger
				role="combobox"
				aria-haspopup="listbox"
				{...control}
				className={cn(
					inputBox,
					control["aria-invalid"]
						? inputInvalid
						: "focus-visible:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)] focus-visible:outline-none",
					"justify-between text-left",
					className,
				)}
			>
				<span className={cn("min-w-0 flex-1 truncate", !labels.length && "text-text-3")}>
					{labels.length ? labels.join(", ") : placeholder}
				</span>
				<Icon icon={ArrowDown01Icon} size={16} className="text-text-3" />
			</PopoverTrigger>
			<PopoverContent label={list.searchLabel} className="w-[var(--radix-popover-trigger-width)] min-w-[260px]">
				<OptionList
					{...list}
					options={options}
					value={value}
					multiple={multiple}
					onSelect={(v) => {
						onValueChange(toggle(value, v, multiple));
						if (!multiple) {
							setOpen(false);
							onOpenChange?.(false);
						}
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

type FilterChipProps = Omit<ComboboxProps, "placeholder" | "invalid" | "id" | "className" | "onOpenChange"> & {
	label: string;
	icon?: IconSvgElement;
	anyText?: string;
};

export function FilterChip({
	label,
	icon,
	anyText = "Any",
	options,
	value,
	onValueChange,
	multiple = true,
	...list
}: FilterChipProps) {
	const [open, setOpen] = useState(false);
	const labels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
	const active = labels.length > 0;
	const summary = !active ? anyText : labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}`;
	return (
		<span
			className={cn(
				"inline-flex h-10 flex-none items-center rounded-md font-medium whitespace-nowrap transition-[background-color,box-shadow] duration-150",
				active
					? "bg-amber-100 text-amber-600 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ef-amber-500)_35%,transparent)]"
					: "bg-surface-raised text-ink shadow-[inset_0_0_0_1px_var(--ef-line)] hover:shadow-[inset_0_0_0_1px_var(--ef-line-2)]",
			)}
		>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					className={cn("inline-flex h-full items-center gap-2 rounded-md pl-3.5", active ? "pr-1.5" : "pr-3.5")}
				>
					{icon ? <Icon icon={icon} size={16} /> : null}
					{label}
					<span className={cn("font-normal", active ? "text-amber-600" : "text-text-2")}>{summary}</span>
				</PopoverTrigger>
				<PopoverContent label={`${label} filter`} className="w-[280px]">
					<OptionList
						{...list}
						options={options}
						value={value}
						multiple={multiple}
						searchLabel={list.searchLabel}
						onSelect={(v) => {
							onValueChange(toggle(value, v, multiple));
							if (!multiple) setOpen(false);
						}}
					/>
				</PopoverContent>
			</Popover>
			{active ? (
				<button
					type="button"
					aria-label={`Remove ${label} filter`}
					onClick={() => onValueChange([])}
					className="mr-1 grid size-8 place-items-center rounded-md text-amber-600 transition-[background-color] hover:bg-[color-mix(in_srgb,var(--ef-amber-500)_18%,transparent)]"
				>
					<Icon icon={Cancel01Icon} size={16} />
				</button>
			) : null}
		</span>
	);
}
