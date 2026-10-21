"use client";

import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, Icon } from "../foundations";
import { inputBox, inputInvalid, useFieldControl } from "./Field";
import { usePortalContainer } from "./overlay-portal";
import { popSurface } from "./Popover";

export type SelectOption = { value: string; label: string; disabled?: boolean };

type SelectProps = Omit<ComponentPropsWithRef<typeof SelectPrimitive.Root>, "children"> & {
	options: SelectOption[];
	placeholder?: string;
	invalid?: boolean;
	id?: string;
	"aria-label"?: string;
	/** Draws the chosen option, for example as a StageChip. Defaults to its label. */
	renderValue?: (option: SelectOption) => ReactNode;
	className?: string;
};

/**
 * Select (components.md): Trigger, Value, Popup and Item, for one choice from a fixed list. Inside a Field the label
 * names the trigger. Space, Enter and the arrow keys open it; typing jumps to an option; Esc closes it.
 */
export function Select({
	options,
	placeholder = "Choose",
	invalid,
	id,
	renderValue,
	className,
	value,
	defaultValue,
	...props
}: SelectProps) {
	const container = usePortalContainer();
	const control = useFieldControl({ id, "aria-invalid": invalid });
	const isInvalid = control["aria-invalid"] === true;
	const current = options.find((o) => o.value === (value ?? defaultValue));
	return (
		<SelectPrimitive.Root value={value} defaultValue={defaultValue} {...props}>
			<SelectPrimitive.Trigger
				{...control}
				aria-label={props["aria-label"]}
				className={cn(
					inputBox,
					isInvalid
						? inputInvalid
						: "focus-visible:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)] focus-visible:outline-none",
					"cursor-pointer justify-between text-left data-[placeholder]:text-text-3 disabled:cursor-not-allowed disabled:opacity-60",
					className,
				)}
			>
				<SelectPrimitive.Value placeholder={placeholder}>
					{current && renderValue ? renderValue(current) : undefined}
				</SelectPrimitive.Value>
				<SelectPrimitive.Icon asChild>
					<Icon icon={ArrowDown01Icon} size={16} className="text-text-3" />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal container={container}>
				<SelectPrimitive.Content
					position="popper"
					sideOffset={6}
					collisionPadding={12}
					className={cn(
						popSurface,
						"max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden",
					)}
				>
					<SelectPrimitive.Viewport>
						{options.map((o) => (
							<SelectItem key={o.value} option={o} />
						))}
					</SelectPrimitive.Viewport>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}

function SelectItem({ option }: { option: SelectOption }) {
	return (
		<SelectPrimitive.Item
			value={option.value}
			disabled={option.disabled}
			className="relative flex h-[38px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-md text-ink outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 transition-[background-color] duration-150 data-[highlighted]:bg-surface-2"
		>
			<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="ml-auto">
				<Icon icon={Tick02Icon} size={16} className="text-ink-2" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}
