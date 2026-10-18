"use client";

import { motion } from "motion/react";
import {
	createContext,
	use,
	useId,
	useState,
	type ComponentPropsWithRef,
	type FocusEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import { cn } from "./cn";

type Group = { layoutId: string; shown: string | null; hover: (key: string | null) => void };
const GroupContext = createContext<Group | null>(null);

/** The shared slide: --ef-slide-dur (0.26s) with --ef-slide-ease. Reduced motion turns it off through MotionConfig. */
const SLIDE = { duration: 0.26, ease: [0.2, 0.8, 0.2, 1] } as const;

/**
 * One shared hover highlight per list, menu, nav, tab set or rail group (components.md, HoverGroup). The highlight
 * slides to the hovered or keyboard-focused item and rests on the current one. Items use useHoverItem.
 *
 * The group is a stacking context and the highlight sits at a negative z-index inside it, so it paints behind every
 * item's own background: the current item's fill stays on top while the highlight rests under it.
 */
export function HoverGroup({
	current = null,
	className,
	onPointerLeave,
	onBlur,
	...props
}: { current?: string | null } & ComponentPropsWithRef<"div">) {
	const layoutId = useId();
	const [hovered, setHovered] = useState<string | null>(null);
	return (
		<GroupContext value={{ layoutId, shown: hovered ?? current, hover: setHovered }}>
			<div
				{...props}
				className={cn("relative isolate", className)}
				onPointerLeave={(e) => {
					setHovered(null);
					onPointerLeave?.(e);
				}}
				onBlur={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget)) setHovered(null);
					onBlur?.(e);
				}}
			/>
		</GroupContext>
	);
}

type ItemHandlers = {
	onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
	onFocus: (e: FocusEvent<HTMLElement>) => void;
};

/**
 * Connects one item to its HoverGroup. Spread `handlers` on the item, which must be `position: relative`, and render
 * `indicator` as its first child. `background` is the highlight fill; it defaults to surface-2.
 */
export function useHoverItem(
	key: string,
	background = "bg-surface-2",
): { handlers: ItemHandlers; indicator: ReactNode } {
	const group = use(GroupContext);
	if (!group) throw new Error("useHoverItem needs a HoverGroup above it.");
	const handlers: ItemHandlers = {
		// Touch has no hover; a tap would leave the highlight on the tapped item.
		onPointerEnter: (e) => {
			if (e.pointerType !== "touch") group.hover(key);
		},
		// Keyboard focus only: a click also focuses, and the pointer already moved the highlight.
		onFocus: (e) => {
			if (e.currentTarget.matches(":focus-visible")) group.hover(key);
		},
	};
	const indicator =
		group.shown === key ? (
			<motion.span
				layoutId={group.layoutId}
				transition={SLIDE}
				aria-hidden="true"
				className={cn("pointer-events-none absolute inset-0 -z-10 rounded-[inherit]", background)}
			/>
		) : null;
	return { handlers, indicator };
}
