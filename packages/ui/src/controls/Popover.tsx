"use client";

import { Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../foundations";
import { usePortalContainer } from "./overlay-portal";

export const popSurface =
	"ef-pop z-50 rounded-card bg-surface-raised p-1.5 text-md text-ink shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)] outline-none";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
	arrow,
	label,
	className,
	children,
	sideOffset = 8,
	align = "start",
	...props
}: ComponentPropsWithRef<typeof PopoverPrimitive.Content> & { arrow?: boolean; label?: string }) {
	const container = usePortalContainer();
	return (
		<PopoverPrimitive.Portal container={container}>
			<PopoverPrimitive.Content
				sideOffset={sideOffset}
				align={align}
				collisionPadding={12}
				aria-label={label}
				className={cn(
					popSurface,
					"max-w-[calc(100vw-24px)] min-w-[220px] origin-[var(--radix-popover-content-transform-origin)]",
					className,
				)}
				{...props}
			>
				{children}
				{arrow ? <PopoverPrimitive.Arrow width={14} height={7} className="fill-surface-raised" /> : null}
			</PopoverPrimitive.Content>
		</PopoverPrimitive.Portal>
	);
}

type TooltipProps = {
	content: ReactNode;
	tone?: "light" | "dark";
	side?: "top" | "right" | "bottom" | "left";
	children: ReactNode;
	delay?: number;
};

export function Tooltip({ content, tone = "dark", side = "top", delay = 300, children }: TooltipProps) {
	const container = usePortalContainer();
	return (
		<TooltipPrimitive.Provider delayDuration={delay} skipDelayDuration={200}>
			<TooltipPrimitive.Root>
				<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal container={container}>
					<TooltipPrimitive.Content
						side={side}
						sideOffset={8}
						collisionPadding={12}
						className={cn(
							"ef-pop z-50 inline-flex items-center gap-2.5 text-md whitespace-nowrap",
							tone === "dark"
								? "rounded-md bg-ink px-2.5 py-1.5 text-sm font-medium text-on-ink shadow-pop"
								: "rounded-pill bg-surface-raised px-4 py-2 text-ink shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)]",
						)}
					>
						{content}
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}

export function TooltipSep() {
	return <span aria-hidden="true" className="h-4 w-px bg-line-2" />;
}
