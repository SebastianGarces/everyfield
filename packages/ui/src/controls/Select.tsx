"use client";

import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn, Icon } from "../foundations";
import { unlessReset } from "../foundations/form-reset";
import { inputBox, inputInvalid, useFieldControl } from "./Field";
import { usePortalContainer } from "./overlay-portal";
import { popSurface } from "./Popover";

export type SelectOption = { value: string; label: string; disabled?: boolean };

type Chosen = { value: string; defaultValue?: never } | { value?: never; defaultValue: string };

type SelectProps = Omit<ComponentPropsWithRef<typeof SelectPrimitive.Root>, "children" | "value" | "defaultValue"> &
	Chosen & {
		options: SelectOption[];
		placeholder?: string;
		invalid?: boolean;
		id?: string;
		"aria-label"?: string;
		renderValue?: (option: SelectOption) => ReactNode;
		renderOption?: (option: SelectOption) => ReactNode;
		className?: string;
	};

export function Select({
	options,
	placeholder = "Choose",
	invalid,
	id,
	renderValue,
	renderOption,
	className,
	value,
	defaultValue,
	onValueChange,
	...props
}: SelectProps) {
	const container = usePortalContainer();
	const control = useFieldControl({ id, "aria-invalid": invalid, trigger: true, "aria-label": props["aria-label"] });
	const isInvalid = control["aria-invalid"] === true;
	const current = options.find((o) => o.value === (value ?? defaultValue));
	return (
		<SelectPrimitive.Root
			key={value === undefined ? defaultValue : undefined}
			value={value}
			defaultValue={defaultValue}
			onValueChange={unlessReset(onValueChange)}
			{...props}
		>
			<SelectPrimitive.Trigger
				{...control}
				aria-label={props["aria-label"]}
				className={cn(
					inputBox,
					isInvalid
						? inputInvalid
						: "focus-visible:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)] focus-visible:outline-none",
					"justify-between text-left data-[placeholder]:text-text-3 disabled:opacity-60",
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
							<SelectItem key={o.value} option={o} render={renderOption} />
						))}
					</SelectPrimitive.Viewport>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}

function SelectItem({
	option,
	render,
}: {
	option: SelectOption;
	render: ((option: SelectOption) => ReactNode) | undefined;
}) {
	return (
		<SelectPrimitive.Item
			value={option.value}
			disabled={option.disabled}
			className="relative flex h-[38px] items-center gap-2.5 rounded-md px-2.5 text-md text-ink outline-none select-none data-[disabled]:opacity-45 transition-[background-color] duration-150 data-[highlighted]:bg-surface-2"
		>
			<SelectPrimitive.ItemText>{render ? render(option) : option.label}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="ml-auto">
				<Icon icon={Tick02Icon} size={16} className="text-ink-2" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}
