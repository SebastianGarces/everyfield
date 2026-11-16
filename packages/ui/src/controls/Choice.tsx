"use client";

import { Checkbox as CheckboxPrimitive, RadioGroup as RadioPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../foundations";
import { unlessReset } from "../foundations/form-reset";

function ChoiceLabel({
	htmlFor,
	label,
	description,
	disabled,
}: {
	htmlFor: string;
	label: ReactNode;
	description?: ReactNode;
	disabled?: boolean;
}) {
	return (
		<span className="min-w-0 flex-1">
			<label
				htmlFor={htmlFor}
				data-toggle-label
				data-disabled={disabled ? "" : undefined}
				className={cn("font-medium text-ink", disabled && "opacity-60")}
			>
				{label}
			</label>
			{description ? <span className="mt-0.5 block text-sm text-text-3">{description}</span> : null}
		</span>
	);
}

type CheckboxProps = Omit<ComponentPropsWithRef<typeof CheckboxPrimitive.Root>, "children"> & {
	label?: ReactNode;
	description?: ReactNode;
	shape?: "square" | "round";
};

export function Checkbox({
	label,
	description,
	shape = "square",
	id,
	className,
	onCheckedChange,
	...props
}: CheckboxProps) {
	const auto = useId();
	const boxId = id ?? auto;
	const box = (
		<CheckboxPrimitive.Root
			key={props.checked === undefined ? String(props.defaultChecked) : undefined}
			id={boxId}
			onCheckedChange={unlessReset(onCheckedChange)}
			className={cn(
				"group/check grid size-5 flex-none place-items-center bg-surface-raised shadow-[inset_0_0_0_1.5px_var(--ef-text-3)] transition-[background-color,box-shadow] duration-150 hover:shadow-[inset_0_0_0_1.5px_var(--ef-ink-2)] disabled:opacity-45 data-[state=checked]:bg-ink data-[state=checked]:shadow-none data-[state=indeterminate]:bg-ink data-[state=indeterminate]:shadow-none",
				shape === "round" ? "rounded-full" : "rounded-xs",
				!label && className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator className="grid place-items-center text-on-ink">
				<svg
					viewBox="0 0 12 12"
					width="12"
					height="12"
					aria-hidden="true"
					className="group-data-[state=indeterminate]/check:hidden"
				>
					<path
						d="M2.5 6.2 4.9 8.5 9.5 3.6"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
				<span
					aria-hidden="true"
					className="hidden h-0.5 w-[9px] bg-current group-data-[state=indeterminate]/check:block"
				/>
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
	if (!label) return box;
	return (
		<div className={cn("flex min-h-11 items-start gap-3 py-3", className)}>
			{box}
			<ChoiceLabel htmlFor={boxId} label={label} description={description} disabled={props.disabled} />
		</div>
	);
}

export function RadioGroup({
	className,
	orientation = "vertical",
	onValueChange,
	...props
}: ComponentPropsWithRef<typeof RadioPrimitive.Root>) {
	return (
		<RadioPrimitive.Root
			key={props.value === undefined ? props.defaultValue : undefined}
			orientation={orientation}
			onValueChange={unlessReset(onValueChange)}
			className={cn("flex gap-x-6", orientation === "vertical" && "flex-col", className)}
			{...props}
		/>
	);
}

type RadioProps = Omit<ComponentPropsWithRef<typeof RadioPrimitive.Item>, "children"> & {
	label: ReactNode;
	description?: ReactNode;
};

export function Radio({ label, description, id, className, ...props }: RadioProps) {
	const auto = useId();
	const itemId = id ?? auto;
	return (
		<div className={cn("flex min-h-11 items-start gap-3 py-3", className)}>
			<RadioPrimitive.Item
				id={itemId}
				className="size-5 flex-none rounded-full bg-surface-raised shadow-[inset_0_0_0_1.5px_var(--ef-text-3)] transition-[box-shadow] duration-150 hover:shadow-[inset_0_0_0_1.5px_var(--ef-ink-2)] disabled:opacity-45 data-[state=checked]:shadow-[inset_0_0_0_6px_var(--ef-ink)]"
				{...props}
			/>
			<ChoiceLabel htmlFor={itemId} label={label} description={description} disabled={props.disabled} />
		</div>
	);
}

type SwitchProps = Omit<ComponentPropsWithRef<typeof SwitchPrimitive.Root>, "children"> & {
	label?: ReactNode;
	description?: ReactNode;
	tone?: "green" | "blue";
};

export function Switch({ label, description, tone = "green", id, className, onCheckedChange, ...props }: SwitchProps) {
	const auto = useId();
	const switchId = id ?? auto;
	const control = (
		<SwitchPrimitive.Root
			key={props.checked === undefined ? String(props.defaultChecked) : undefined}
			id={switchId}
			onCheckedChange={unlessReset(onCheckedChange)}
			className={cn(
				"relative h-7 w-12 flex-none rounded-pill bg-[var(--ef-switch-off)] p-0 shadow-[inset_0_0_0_1px_var(--ef-text-3)] transition-[background-color,box-shadow] duration-200 disabled:opacity-45",
				tone === "blue"
					? "data-[state=checked]:bg-blue-500 data-[state=checked]:shadow-[inset_0_0_0_1px_var(--ef-blue-600)]"
					: "data-[state=checked]:bg-green-500 data-[state=checked]:shadow-[inset_0_0_0_1px_var(--ef-green-700)]",
				!label && className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb className="absolute top-[3px] left-[3px] size-[22px] rounded-pill bg-white shadow-raised transition-transform duration-200 data-[state=checked]:translate-x-5 motion-reduce:transition-none" />
		</SwitchPrimitive.Root>
	);
	if (!label) return control;
	return (
		<div className={cn("flex min-h-11 items-center justify-between gap-4 py-1.5", className)}>
			<ChoiceLabel htmlFor={switchId} label={label} description={description} disabled={props.disabled} />
			{control}
		</div>
	);
}
