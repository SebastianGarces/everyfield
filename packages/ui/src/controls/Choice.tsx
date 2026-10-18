"use client";

import { Checkbox as CheckboxPrimitive, RadioGroup as RadioPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../foundations";

/** The label and optional description next to a checkbox, radio or switch. Clicking the label toggles the control. */
function ChoiceLabel({ htmlFor, label, description, disabled }: { htmlFor: string; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <label htmlFor={htmlFor} className={cn("font-medium text-ink", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>{label}</label>
      {description ? <span className="mt-0.5 block text-sm text-text-3">{description}</span> : null}
    </span>
  );
}

type CheckboxProps = Omit<ComponentPropsWithRef<typeof CheckboxPrimitive.Root>, "children"> & {
  /** Visible label. Without one, pass aria-label (a row-selection box in a table). */
  label?: ReactNode;
  description?: ReactNode;
  shape?: "square" | "round";
};

/**
 * Checkbox (components.md): checked, unchecked or mixed ("indeterminate"), square or round. 20px box inside a 44px
 * target when it has a label, because the label is part of the hit area.
 */
export function Checkbox({ label, description, shape = "square", id, className, ...props }: CheckboxProps) {
  const auto = useId();
  const boxId = id ?? auto;
  const box = (
    <CheckboxPrimitive.Root
      id={boxId}
      className={cn(
        "group/check grid size-5 flex-none cursor-pointer place-items-center bg-surface-raised shadow-[inset_0_0_0_1.5px_var(--ef-text-3)] transition-[background-color,box-shadow] duration-150 hover:shadow-[inset_0_0_0_1.5px_var(--ef-ink-2)] disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-ink data-[state=checked]:shadow-none data-[state=indeterminate]:bg-ink data-[state=indeterminate]:shadow-none",
        shape === "round" ? "rounded-full" : "rounded-xs",
        !label && className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center text-on-ink">
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" className="group-data-[state=indeterminate]/check:hidden">
          <path d="M2.5 6.2 4.9 8.5 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span aria-hidden="true" className="hidden h-0.5 w-[9px] rounded-full bg-current group-data-[state=indeterminate]/check:block" />
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

/** RadioGroup (components.md): a labelled group; arrow keys move the choice, Tab enters and leaves the group. */
export function RadioGroup({ className, orientation = "vertical", ...props }: ComponentPropsWithRef<typeof RadioPrimitive.Root>) {
  return <RadioPrimitive.Root orientation={orientation} className={cn("flex gap-x-6", orientation === "vertical" && "flex-col", className)} {...props} />;
}

type RadioProps = Omit<ComponentPropsWithRef<typeof RadioPrimitive.Item>, "children"> & { label: ReactNode; description?: ReactNode };

export function Radio({ label, description, id, className, ...props }: RadioProps) {
  const auto = useId();
  const itemId = id ?? auto;
  return (
    <div className={cn("flex min-h-11 items-start gap-3 py-3", className)}>
      <RadioPrimitive.Item
        id={itemId}
        className="size-5 flex-none cursor-pointer rounded-full bg-surface-raised shadow-[inset_0_0_0_1.5px_var(--ef-text-3)] transition-[box-shadow] duration-150 hover:shadow-[inset_0_0_0_1.5px_var(--ef-ink-2)] disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:shadow-[inset_0_0_0_6px_var(--ef-ink)]"
        {...props}
      />
      <ChoiceLabel htmlFor={itemId} label={label} description={description} disabled={props.disabled} />
    </div>
  );
}

type SwitchProps = Omit<ComponentPropsWithRef<typeof SwitchPrimitive.Root>, "children"> & {
  label?: ReactNode;
  description?: ReactNode;
  /** green (default) or blue for the on state. */
  tone?: "green" | "blue";
};

/**
 * Switch (components.md): a settings toggle that takes effect at once. With a label it is a full row: label and
 * description on the left, the switch on the right.
 */
export function Switch({ label, description, tone = "green", id, className, ...props }: SwitchProps) {
  const auto = useId();
  const switchId = id ?? auto;
  const control = (
    <SwitchPrimitive.Root
      id={switchId}
      className={cn(
        "relative h-7 w-12 flex-none cursor-pointer rounded-full bg-[var(--ef-switch-off)] p-0 shadow-[inset_0_0_0_1px_var(--ef-text-3)] transition-[background-color,box-shadow] duration-200 disabled:cursor-not-allowed disabled:opacity-45",
        tone === "blue" ? "data-[state=checked]:bg-blue-500 data-[state=checked]:shadow-[inset_0_0_0_1px_var(--ef-blue-600)]" : "data-[state=checked]:bg-green-500 data-[state=checked]:shadow-[inset_0_0_0_1px_var(--ef-green-700)]",
        !label && className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="absolute top-[3px] left-[3px] size-[22px] rounded-full bg-white shadow-raised transition-transform duration-200 data-[state=checked]:translate-x-5 motion-reduce:transition-none" />
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
