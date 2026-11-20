"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { createContext, use, useId, useMemo, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";

type FieldState = { id: string; labelId: string; describedBy: string | undefined; invalid: boolean };
const FieldContext = createContext<FieldState | null>(null);

export function useFieldControl(props: {
	id?: string;
	"aria-describedby"?: string;
	"aria-invalid"?: ComponentPropsWithRef<"input">["aria-invalid"];
	trigger?: boolean;
	"aria-label"?: string;
}) {
	const field = use(FieldContext);
	return {
		id: props.id ?? (props.trigger ? undefined : field?.id),
		"aria-labelledby": props.trigger && field && !props["aria-label"] ? field.labelId : undefined,
		"aria-describedby": [field?.describedBy, props["aria-describedby"]].filter(Boolean).join(" ") || undefined,
		"aria-invalid": props["aria-invalid"] ?? (field?.invalid || undefined),
	};
}

type FieldProps = {
	label: ReactNode;
	hint?: ReactNode;
	error?: ReactNode;
	optional?: boolean;
	children: ReactNode;
	className?: string;
};

export function Field({ label, hint, error, optional, children, className }: FieldProps) {
	const id = useId();
	const labelId = `${id}-label`;
	const hintId = hint ? `${id}-hint` : undefined;
	const errorId = error ? `${id}-error` : undefined;
	const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
	const invalid = Boolean(error);
	const field = useMemo(() => ({ id, labelId, describedBy, invalid }), [id, labelId, describedBy, invalid]);
	return (
		<FieldContext value={field}>
			<div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
				<label id={labelId} htmlFor={id} className="text-sm font-medium text-ink-2">
					{label}
					{optional ? <span className="font-normal text-text-3"> · Optional</span> : null}
				</label>
				{children}
				{hint ? (
					<p id={hintId} className="text-xs text-text-3">
						{hint}
					</p>
				) : null}
				<div aria-live="polite" className="empty:hidden">
					{error ? (
						<p id={errorId} className="text-xs font-medium text-magenta-600">
							{error}
						</p>
					) : null}
				</div>
			</div>
		</FieldContext>
	);
}

export const inputBox =
	"flex h-11 w-full min-w-0 items-center gap-2.5 rounded-md bg-surface-raised px-3.5 text-md text-ink shadow-[0_0_0_1px_var(--control-edge,var(--ef-line-2))] transition-[box-shadow] duration-150";
const inputFocus =
	"has-[:focus-visible]:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]";
export const inputInvalid =
	"shadow-[0_0_0_1px_var(--ef-magenta-500),0_0_0_4px_color-mix(in_srgb,var(--ef-magenta-500)_18%,transparent)]";
const inputInvalidFocus = "has-[:focus-visible]:shadow-[0_0_0_1px_var(--ef-magenta-500),0_0_0_3px_var(--ef-focus)]";
const textareaInvalidFocus = "focus-visible:shadow-[0_0_0_1px_var(--ef-magenta-500),0_0_0_3px_var(--ef-focus)]";

type InputProps = Omit<ComponentPropsWithRef<"input">, "size"> & {
	icon?: IconSvgElement;
	trailing?: ReactNode;
	invalid?: boolean;
	boxClassName?: string;
};

export function Input({ icon, trailing, invalid, boxClassName, className, id, ...props }: InputProps) {
	const control = useFieldControl({
		id,
		"aria-describedby": props["aria-describedby"],
		"aria-invalid": invalid || props["aria-invalid"],
	});
	const isInvalid = control["aria-invalid"] === true || control["aria-invalid"] === "true";
	return (
		<div
			className={cn(
				inputBox,
				isInvalid ? cn(inputInvalid, inputInvalidFocus) : inputFocus,
				props.disabled && "opacity-60",
				boxClassName,
			)}
		>
			{icon ? <Icon icon={icon} size={18} className="text-text-3" /> : null}
			<input
				{...props}
				{...control}
				className={cn(
					"h-full min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-text-3 focus-visible:outline-none",
					className,
				)}
			/>
			{trailing}
		</div>
	);
}

export function SearchInput({ shortcut, ...props }: Omit<InputProps, "icon" | "type"> & { shortcut?: string }) {
	return <Input type="search" icon={Search01Icon} trailing={shortcut ? <Kbd>{shortcut}</Kbd> : undefined} {...props} />;
}

export function Textarea({
	invalid,
	className,
	id,
	...props
}: ComponentPropsWithRef<"textarea"> & { invalid?: boolean }) {
	const control = useFieldControl({
		id,
		"aria-describedby": props["aria-describedby"],
		"aria-invalid": invalid || props["aria-invalid"],
	});
	const isInvalid = control["aria-invalid"] === true || control["aria-invalid"] === "true";
	return (
		<textarea
			{...props}
			{...control}
			className={cn(
				"min-h-24 w-full resize-y rounded-md bg-surface-raised px-3.5 py-3 text-md leading-normal text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none transition-[box-shadow] duration-150 placeholder:text-text-3 focus-visible:outline-none disabled:opacity-60",
				isInvalid
					? cn(inputInvalid, textareaInvalidFocus)
					: "focus-visible:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]",
				className,
			)}
		/>
	);
}

export function Kbd({ className, ...props }: ComponentPropsWithRef<"kbd">) {
	return (
		<kbd
			className={cn(
				"flex-none rounded-md bg-surface-2 px-[7px] py-[3px] font-sans text-xs font-medium text-text-2 shadow-[inset_0_0_0_1px_var(--ef-line)]",
				className,
			)}
			{...props}
		/>
	);
}
