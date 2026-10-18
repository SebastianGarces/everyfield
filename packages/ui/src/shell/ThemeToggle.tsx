"use client";

import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { useRef, type KeyboardEvent } from "react";
import { cn, HoverGroup, Icon, useHoverItem, useProductTheme, type ProductTheme } from "../foundations";

const OPTIONS = [
	{ theme: "light", label: "Light mode", short: "Light", icon: Sun01Icon },
	{ theme: "dark", label: "Dark mode", short: "Dark", icon: Moon02Icon },
] as const;

/**
 * The product theme switch: a radio group of two buttons (the sun and moon in the rail). Arrow keys move between the
 * options and select them, as in the WAI-ARIA radio group pattern; only the checked option is in the tab order.
 * `rail` draws icon buttons with a label that appears on hover and focus; `menu` draws labelled buttons for the
 * narrow-screen menu.
 */
export function ThemeToggle({ variant, className }: { variant: "rail" | "menu"; className?: string }) {
	const { theme, setTheme } = useProductTheme();
	const refs = useRef<Partial<Record<ProductTheme, HTMLButtonElement | null>>>({});

	const onKeyDown = (e: KeyboardEvent) => {
		if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
		e.preventDefault();
		const next: ProductTheme = theme === "light" ? "dark" : "light";
		setTheme(next);
		refs.current[next]?.focus();
	};

	return (
		<HoverGroup
			role="radiogroup"
			aria-label="Theme"
			current={theme}
			onKeyDown={onKeyDown}
			className={cn(
				variant === "rail"
					? "flex w-16 flex-col items-center gap-1.5 rounded-nav bg-surface-raised py-2.5 shadow-nav"
					: "grid grid-cols-2 gap-1 rounded-nav-item bg-surface-2 p-1",
				className,
			)}
		>
			{OPTIONS.map((o) => (
				<ThemeOption
					key={o.theme}
					option={o}
					variant={variant}
					checked={theme === o.theme}
					onSelect={() => setTheme(o.theme)}
					ref={(el) => void (refs.current[o.theme] = el)}
				/>
			))}
		</HoverGroup>
	);
}

function ThemeOption({
	option,
	variant,
	checked,
	onSelect,
	ref,
}: {
	option: (typeof OPTIONS)[number];
	variant: "rail" | "menu";
	checked: boolean;
	onSelect: () => void;
	ref: (el: HTMLButtonElement | null) => void;
}) {
	const { handlers, indicator } = useHoverItem(
		option.theme,
		variant === "rail" ? "bg-surface-2" : "bg-surface-raised shadow-nav-active",
	);
	if (variant === "menu") {
		return (
			<button
				ref={ref}
				type="button"
				role="radio"
				aria-checked={checked}
				tabIndex={checked ? 0 : -1}
				onClick={onSelect}
				{...handlers}
				className="relative inline-flex h-11 items-center justify-center gap-2 rounded-[10px] text-md font-medium text-ink-2 aria-checked:text-ink"
			>
				{indicator}
				<Icon icon={option.icon} size={18} />
				{option.short}
			</button>
		);
	}
	return (
		<button
			ref={ref}
			type="button"
			role="radio"
			aria-checked={checked}
			tabIndex={checked ? 0 : -1}
			onClick={onSelect}
			{...handlers}
			className="group/ri relative grid size-[46px] place-items-center rounded-nav-item text-ink-2 aria-checked:bg-surface-2 aria-checked:text-ink"
		>
			{indicator}
			<Icon icon={option.icon} size={24} />
			<RailTip>{option.label}</RailTip>
		</button>
	);
}

/** The rail label. It is the item's accessible name and appears on hover and on keyboard focus (foundations.md). */
export function RailTip({ children }: { children: string }) {
	return (
		<span className="pointer-events-none absolute top-1/2 left-[60px] z-30 -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-[8px] bg-ink px-2.5 py-1.5 text-sm font-medium text-on-ink opacity-0 transition-[opacity,translate] duration-150 group-hover/ri:translate-x-0 group-hover/ri:opacity-100 group-focus-visible/ri:translate-x-0 group-focus-visible/ri:opacity-100">
			{children}
		</span>
	);
}
