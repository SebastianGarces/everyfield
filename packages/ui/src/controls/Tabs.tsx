"use client";

import { motion } from "motion/react";
import { Tabs as TabsPrimitive, ToggleGroup } from "radix-ui";
import { createContext, use, useId, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn, HoverGroup, Icon, useHoverItem, type IconSvgElement } from "../foundations";

const SLIDE = { duration: 0.26, ease: [0.2, 0.8, 0.2, 1] } as const;

export type SegmentOption<V extends string> = { value: V; label: string; icon?: IconSvgElement; count?: number };

type SegmentedProps<V extends string> = {
	/** The group's accessible name, such as "View". */
	label: string;
	options: SegmentOption<V>[];
	value: V;
	onValueChange: (value: V) => void;
	size?: "md" | "sm";
	/** Options wrap onto more than one line. The default control scrolls sideways. */
	wrap?: boolean;
	className?: string;
};

/**
 * SegmentedControl (components.md): one choice from a few, as a radio group. Arrow keys move between options and
 * Tab leaves the group. One raised highlight slides to the hovered or focused option and rests on the selected one.
 * A selection is always kept: choosing the selected option again does nothing.
 */
export function SegmentedControl<V extends string>({
	label,
	options,
	value,
	onValueChange,
	size = "md",
	wrap = false,
	className,
}: SegmentedProps<V>) {
	return (
		<ToggleGroup.Root
			type="single"
			aria-label={label}
			value={value}
			onValueChange={(next) => next && onValueChange(next as V)}
			asChild
		>
			<HoverGroup
				current={value}
				className={cn(
					wrap
						? "flex w-full flex-wrap gap-0.5 rounded-md bg-surface-2 p-1"
						: "inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md [scrollbar-width:none] bg-surface-2 p-1",
					className,
				)}
			>
				{options.map((o) => (
					<Segment key={o.value} option={o} size={size} />
				))}
			</HoverGroup>
		</ToggleGroup.Root>
	);
}

function Segment<V extends string>({ option, size }: { option: SegmentOption<V>; size: "md" | "sm" }) {
	const { handlers, indicator } = useHoverItem(option.value, "bg-surface-raised shadow-raised");
	return (
		<ToggleGroup.Item
			value={option.value}
			{...handlers}
			className={cn(
				"relative inline-flex flex-none cursor-pointer items-center gap-1.5 rounded-md font-medium whitespace-nowrap text-text-2 transition-colors duration-150 hover:text-ink data-[state=on]:text-ink data-[state=on]:shadow-[inset_0_0_0_1px_var(--control-edge,transparent)]",
				size === "sm" ? "h-[30px] px-3 text-sm" : "h-[34px] px-3.5 text-md",
			)}
		>
			{indicator}
			{option.icon ? <Icon icon={option.icon} size={16} /> : null}
			{option.label}
			{option.count !== undefined ? <CountChip>{option.count}</CountChip> : null}
		</ToggleGroup.Item>
	);
}

/** The small count after a tab or segment label. */
export function CountChip({ children }: { children: ReactNode }) {
	return (
		<span className="num rounded-pill bg-surface-2 px-[7px] py-px font-title text-xs tracking-[-0.02em] text-text-2">
			{children}
		</span>
	);
}

type TabsState = { value: string; indicator: string };
const TabsContext = createContext<TabsState | null>(null);

type TabsProps = Omit<ComponentPropsWithRef<typeof TabsPrimitive.Root>, "value" | "defaultValue" | "onValueChange"> & {
	value?: string;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
};

/**
 * Tabs (components.md): List, Tab (with an optional Count) and Panel. Arrow keys move between tabs and select them;
 * the 2px ink underline slides to the selected tab. Controlled with value, or uncontrolled with defaultValue.
 */
export function Tabs({ value: controlled, defaultValue = "", onValueChange, ...props }: TabsProps) {
	const [inner, setInner] = useState(defaultValue);
	const value = controlled ?? inner;
	const indicator = useId();
	return (
		<TabsContext value={{ value, indicator }}>
			<TabsPrimitive.Root
				value={value}
				onValueChange={(next) => {
					setInner(next);
					onValueChange?.(next);
				}}
				{...props}
			/>
		</TabsContext>
	);
}

export function TabsList({ className, ...props }: ComponentPropsWithRef<typeof TabsPrimitive.List>) {
	return (
		<TabsPrimitive.List
			className={cn("-mx-1 flex gap-[26px] overflow-x-auto border-b border-line px-1 pt-1 max-app-sm:gap-5", className)}
			{...props}
		/>
	);
}

export function Tab({
	value,
	count,
	className,
	children,
	...props
}: ComponentPropsWithRef<typeof TabsPrimitive.Trigger> & { count?: number }) {
	const tabs = use(TabsContext);
	const selected = tabs?.value === value;
	return (
		<TabsPrimitive.Trigger
			value={value}
			className={cn(
				"relative inline-flex flex-none cursor-pointer items-center gap-2 rounded-t-xs pb-3 text-[15px] font-medium whitespace-nowrap text-text-3 transition-colors duration-150 hover:text-ink data-[state=active]:text-ink",
				className,
			)}
			{...props}
		>
			{children}
			{count !== undefined ? <CountChip>{count}</CountChip> : null}
			{selected ? (
				<motion.span
					layoutId={tabs?.indicator}
					transition={SLIDE}
					aria-hidden="true"
					className="absolute inset-x-0 -bottom-px h-0.5 bg-ink"
				/>
			) : null}
		</TabsPrimitive.Trigger>
	);
}

export function TabsPanel({ className, ...props }: ComponentPropsWithRef<typeof TabsPrimitive.Content>) {
	return <TabsPrimitive.Content className={cn("rounded-md pt-6", className)} {...props} />;
}
