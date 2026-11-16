import * as React from "react";
import { Separator } from "./separator";
import { cn } from "../tiptap-utils.ts";
import { TOOLBAR, TOOLBAR_GROUP } from "../styles.ts";

type BaseProps = React.HTMLAttributes<HTMLDivElement>;

const ITEMS = 'button:not([disabled]), [role="button"]:not([disabled]), [tabindex]:not([disabled])';

export const InToolbar = React.createContext(false);

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable="true"]';

function passPointerFocusOn(toolbar: HTMLElement) {
	const outer = toolbar.parentElement?.closest<HTMLElement>(FOCUSABLE);
	if (outer) outer.focus({ preventScroll: true });
	else toolbar.blur();
}

const itemsOf = (toolbar: HTMLElement) => Array.from(toolbar.querySelectorAll<HTMLElement>(ITEMS));

function arrowTarget(key: string, index: number, count: number) {
	switch (key) {
		case "ArrowLeft":
			return (index - 1 + count) % count;
		case "ArrowRight":
			return (index + 1) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}

export const Toolbar = React.forwardRef<HTMLDivElement, BaseProps>(
	({ children, className, onKeyDownCapture, onFocus, onBlur, ...props }, ref) => {
		const remembered = React.useRef(0);
		const [entry, setEntry] = React.useState(true);

		return (
			<div
				ref={ref}
				role="toolbar"
				aria-label="Document formatting"
				tabIndex={entry ? 0 : -1}
				className={cn(TOOLBAR, "outline-none", className)}
				{...props}
				onKeyDownCapture={(event) => {
					onKeyDownCapture?.(event);
					const toolbar = event.currentTarget;
					if (event.key === "Tab") {
						if (event.shiftKey && toolbar.contains(event.target as Node)) setEntry(false);
						return;
					}
					const items = itemsOf(toolbar);
					const index = items.indexOf(event.target as HTMLElement);
					if (index === -1) return;
					const next = arrowTarget(event.key, index, items.length);
					if (next === null) return;
					event.preventDefault();
					items[next]?.focus();
				}}
				onFocus={(event) => {
					onFocus?.(event);
					const toolbar = event.currentTarget;
					const items = itemsOf(toolbar);
					if (event.target !== toolbar) {
						const index = items.indexOf(event.target as HTMLElement);
						if (index !== -1) remembered.current = index;
					} else if (toolbar.matches(":focus-visible")) {
						(items[remembered.current] ?? items[0])?.focus();
					} else {
						passPointerFocusOn(toolbar);
					}
				}}
				onBlur={(event) => {
					onBlur?.(event);
					if (!event.currentTarget.contains(event.relatedTarget)) setEntry(true);
				}}
			>
				<InToolbar value>{children}</InToolbar>
			</div>
		);
	},
);
Toolbar.displayName = "Toolbar";

export const ToolbarGroup = React.forwardRef<HTMLDivElement, BaseProps>(({ children, className, ...props }, ref) => (
	<div ref={ref} role="group" className={cn(TOOLBAR_GROUP, className)} {...props}>
		{children}
	</div>
));
ToolbarGroup.displayName = "ToolbarGroup";

export const ToolbarSeparator = React.forwardRef<HTMLDivElement, BaseProps>(({ ...props }, ref) => (
	<Separator ref={ref} orientation="vertical" decorative {...props} />
));
ToolbarSeparator.displayName = "ToolbarSeparator";
