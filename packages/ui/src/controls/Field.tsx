"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { createContext, use, useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";

type FieldState = { id: string; labelId: string; describedBy: string | undefined; invalid: boolean };
const FieldContext = createContext<FieldState | null>(null);

/**
 * The props a control spreads to join its Field: id (the label's target), aria-describedby (hint and error) and
 * aria-invalid. Outside a Field it returns only what the caller passed.
 *
 * A button-style trigger (Combobox, Select) passes `trigger: true`. A browser forwards a click on a label to the
 * control it targets, so a label targeting a trigger would open it, or close and reopen it. The trigger keeps the
 * label as its name through aria-labelledby and does not take the label's target id.
 */
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
	/** Help under the control, linked with aria-describedby. */
	hint?: ReactNode;
	/** An actionable error ("Enter a full phone number"). Its presence marks the control invalid. */
	error?: ReactNode;
	/** Shows "Optional" after the label. Fields are required unless they say so. */
	optional?: boolean;
	children: ReactNode;
	className?: string;
};

/**
 * Field (components.md): Label, Control, Hint and Error. The label targets the control through context, the hint and
 * error describe it, and the error is announced politely when it appears.
 */
export function Field({ label, hint, error, optional, children, className }: FieldProps) {
	const id = useId();
	const labelId = `${id}-label`;
	const hintId = hint ? `${id}-hint` : undefined;
	const errorId = error ? `${id}-error` : undefined;
	return (
		<FieldContext
			value={{
				id,
				labelId,
				describedBy: [errorId, hintId].filter(Boolean).join(" ") || undefined,
				invalid: Boolean(error),
			}}
		>
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

/** The input box look, shared by Input, the Select trigger and the Combobox trigger. */
export const inputBox =
	"flex h-11 w-full min-w-0 items-center gap-2.5 rounded-md bg-surface-raised px-3.5 text-md text-ink shadow-[0_0_0_1px_var(--control-edge,var(--ef-line-2))] transition-[box-shadow] duration-150";
/** Focus on the whole box (foundations.md: text inputs show focus on the whole field). */
export const inputFocus =
	"has-[:focus-visible]:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]";
export const inputInvalid =
	"shadow-[0_0_0_1px_var(--ef-magenta-500),0_0_0_4px_color-mix(in_srgb,var(--ef-magenta-500)_18%,transparent)]";
/**
 * Keyboard focus on an invalid field (D38, WCAG 2.4.7): the magenta edge stays and a solid 2px focus ring replaces the
 * soft halo, so focus stays visible while the field is still marked invalid.
 */
const inputInvalidFocus = "has-[:focus-visible]:shadow-[0_0_0_1px_var(--ef-magenta-500),0_0_0_3px_var(--ef-focus)]";
const textareaInvalidFocus = "focus-visible:shadow-[0_0_0_1px_var(--ef-magenta-500),0_0_0_3px_var(--ef-focus)]";

type InputProps = Omit<ComponentPropsWithRef<"input">, "size"> & {
	/** A leading icon, decorative. */
	icon?: IconSvgElement;
	/** Trailing content inside the box, such as a Kbd hint or a unit. */
	trailing?: ReactNode;
	invalid?: boolean;
	/** Classes for the outer box (width, height). `className` goes on the inner input. */
	boxClassName?: string;
};

/** Input (components.md): Icon, the input and an optional trailing Kbd. Focus and invalid states draw on the box. */
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
					"h-full min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-text-3 focus-visible:outline-none disabled:cursor-not-allowed",
					className,
				)}
			/>
			{trailing}
		</div>
	);
}

/** SearchInput: Input with the search icon, type="search" and an optional shortcut hint such as ⌘K. */
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
				"min-h-24 w-full resize-y rounded-md bg-surface-raised px-3.5 py-3 text-md leading-normal text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none transition-[box-shadow] duration-150 placeholder:text-text-3 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
				isInvalid
					? cn(inputInvalid, textareaInvalidFocus)
					: "focus-visible:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]",
				className,
			)}
		/>
	);
}

/** A keyboard shortcut hint. Screen readers read the text as written. */
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
