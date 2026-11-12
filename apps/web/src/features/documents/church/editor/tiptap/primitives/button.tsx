import * as React from "react";

// --- Tiptap UI Primitive ---
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

// --- Lib ---
import { cn, parseShortcutKeys } from "../tiptap-utils.ts";
import { BUTTON, BUTTON_BASE, BUTTON_GROUP } from "../styles.ts";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	className?: string;
	showTooltip?: boolean;
	tooltip?: React.ReactNode;
	shortcutKeys?: string;
}

export const ShortcutDisplay: React.FC<{ shortcuts: string[] }> = ({ shortcuts }) => {
	if (shortcuts.length === 0) return null;

	return (
		<div>
			{shortcuts.map((key, index) => (
				<React.Fragment key={index}>
					{index > 0 && <kbd>+</kbd>}
					<kbd>{key}</kbd>
				</React.Fragment>
			))}
		</div>
	);
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, children, tooltip, showTooltip = true, shortcutKeys, "aria-label": ariaLabel, ...props }, ref) => {
		const shortcuts = React.useMemo(() => parseShortcutKeys({ shortcutKeys }), [shortcutKeys]);
		// Everyfield change: a `className` replaces the default box (size, padding, gap and justify), so a call site's
		// `h-8` or `justify-between` is the only class for its property and takes effect.
		const classes = className ? cn(BUTTON_BASE, className) : BUTTON;

		if (!tooltip || !showTooltip) {
			return (
				<button className={classes} ref={ref} aria-label={ariaLabel} {...props}>
					{children}
				</button>
			);
		}

		return (
			<Tooltip delay={200}>
				<TooltipTrigger className={classes} ref={ref} aria-label={ariaLabel} {...props}>
					{children}
				</TooltipTrigger>
				<TooltipContent>
					{tooltip}
					<ShortcutDisplay shortcuts={shortcuts} />
				</TooltipContent>
			</Tooltip>
		);
	},
);

Button.displayName = "Button";

export const ButtonGroup = React.forwardRef<
	HTMLDivElement,
	React.ComponentProps<"div"> & {
		orientation?: "horizontal" | "vertical";
	}
>(({ className, children, orientation = "vertical", ...props }, ref) => {
	return (
		<div ref={ref} className={cn(BUTTON_GROUP, className)} data-orientation={orientation} role="group" {...props}>
			{children}
		</div>
	);
});
ButtonGroup.displayName = "ButtonGroup";
