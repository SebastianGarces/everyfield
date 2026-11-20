"use client";

import { motion } from "motion/react";
import {
	createContext,
	use,
	useId,
	useMemo,
	useState,
	type ComponentPropsWithRef,
	type FocusEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import { cn } from "./cn";

type Group = { layoutId: string; shown: string | null; hover: (key: string | null) => void };
const GroupContext = createContext<Group | null>(null);

const SLIDE = { duration: 0.26, ease: [0.2, 0.8, 0.2, 1] } as const;

export function HoverGroup({
	current = null,
	className,
	onPointerLeave,
	onBlur,
	...props
}: { current?: string | null } & ComponentPropsWithRef<"div">) {
	const layoutId = useId();
	const [hovered, setHovered] = useState<string | null>(null);
	const shown = hovered ?? current;
	const group = useMemo(() => ({ layoutId, shown, hover: setHovered }), [layoutId, shown]);
	return (
		<GroupContext value={group}>
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

export function useHoverItem(
	key: string,
	background = "bg-surface-2",
): { handlers: ItemHandlers; indicator: ReactNode } {
	const group = use(GroupContext);
	if (!group) throw new Error("useHoverItem needs a HoverGroup above it.");
	const handlers: ItemHandlers = {
		onPointerEnter: (e) => {
			if (e.pointerType !== "touch") group.hover(key);
		},
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
