import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { Spinner } from "./Spinner";

/** Button variants from the prototype's .btn (components.md, Button). Text on a hue fill is ink or on-ink, never white. */
export const buttonVariants = cva(
  "relative inline-flex flex-none cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-medium select-none transition-[background-color,box-shadow,translate,opacity] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0 aria-busy:cursor-progress",
  {
    variants: {
      variant: {
        primary: "bg-ink text-on-ink shadow-pill hover:bg-[color-mix(in_srgb,var(--ef-ink)_88%,var(--ef-frame))]",
        brand: "bg-green-600 text-on-ink shadow-raised hover:bg-[color-mix(in_srgb,var(--ef-green-600)_90%,var(--ef-ink))]",
        secondary: "bg-surface-2 text-ink hover:bg-surface-3",
        outline: "bg-surface-raised text-ink shadow-[0_0_0_1px_var(--ef-line-2)] hover:bg-surface",
        ghost: "bg-transparent text-ink hover:bg-hover",
        light: "bg-white text-ink-fixed shadow-raised hover:bg-surface-2",
        glass: "bg-white/14 text-white ring-1 ring-white/25 ring-inset hover:bg-white/20",
        danger: "bg-magenta-100 text-magenta-600 hover:bg-[color-mix(in_srgb,var(--ef-magenta-100)_80%,var(--ef-magenta-300))]",
      },
      size: {
        md: "h-11 rounded-md text-[15px]",
        sm: "h-[34px] rounded-sm px-3 text-sm",
      },
    },
    compoundVariants: [
      { variant: ["primary", "brand", "secondary", "outline", "light", "glass", "danger"], size: "md", className: "px-[18px]" },
      { variant: "ghost", size: "md", className: "px-2.5" },
    ],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

type ButtonProps = ComponentPropsWithRef<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (a link) with the button look. */
    asChild?: boolean;
    /** A leading icon. Trailing icons go in children. */
    icon?: IconSvgElement;
    /** Shows a spinner, keeps the label for width and the accessible name, and blocks repeat clicks. */
    loading?: boolean;
  };

/**
 * A button or, with asChild, a link that looks like one. `loading` sets aria-busy and aria-disabled instead of
 * disabled, so the button keeps focus while the request runs.
 */
export function Button({ variant, size, asChild, icon, loading, className, children, onClick, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const iconSize = size === "sm" ? 16 : 18;
  return (
    <Comp
      type={asChild ? undefined : "button"}
      data-variant={variant ?? "secondary"}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner size={iconSize} /> : icon ? <Icon icon={icon} size={iconSize} /> : null}
          {children}
        </>
      )}
    </Comp>
  );
}

export const iconButtonVariants = cva(
  "relative grid flex-none cursor-pointer place-items-center text-ink-2 transition-[background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "rounded-full bg-transparent shadow-[0_0_0_1px_var(--ef-line-2)] hover:bg-surface-raised",
        soft: "rounded-full bg-surface-2 hover:bg-surface-3",
        square: "rounded-sm bg-transparent shadow-[0_0_0_1px_var(--ef-line-2)] hover:bg-surface-raised",
      },
      size: { md: "size-11", sm: "size-[34px]" },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

type IconButtonProps = Omit<ComponentPropsWithRef<"button">, "children" | "aria-label"> &
  VariantProps<typeof iconButtonVariants> & {
    icon: IconSvgElement;
    /** The accessible name. Required: an icon alone names nothing. */
    label: string;
  };

/**
 * An icon-only button. `label` is its accessible name; wrap it in Tooltip when sighted users need the name too
 * (foundations.md: anything that appears on hover also appears on focus).
 */
export function IconButton({ icon, label, variant, size, className, ...props }: IconButtonProps) {
  return (
    <button type="button" aria-label={label} className={cn(iconButtonVariants({ variant, size }), className)} {...props}>
      <Icon icon={icon} size={size === "sm" ? 16 : 18} />
    </button>
  );
}
