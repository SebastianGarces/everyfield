import * as React from "react";
import { Separator } from "./separator";
import { cn } from "../tiptap-utils.ts";
import { TOOLBAR, TOOLBAR_GROUP } from "../styles.ts";
import { useMenuNavigation } from "../use-menu-navigation.ts";
import { useComposedRef } from "../use-composed-ref.ts";

type BaseProps = React.HTMLAttributes<HTMLDivElement>;

// Everyfield change: the toolbar is one Tab stop (WAI-ARIA toolbar pattern). Tab and Shift+Tab move in and out of it,
// the arrow keys move between its enabled buttons from the one that has focus, and Enter or Space reaches the focused
// button natively. Only the remembered button has tabindex 0; the list follows buttons that mount, unmount or turn
// disabled.
const ITEMS = 'button:not([disabled]), [role="button"]:not([disabled]), [tabindex]:not([disabled])';

const useToolbarNavigation = (toolbarRef: React.RefObject<HTMLDivElement | null>) => {
	const [items, setItems] = React.useState<HTMLElement[]>([]);

	const { selectedIndex, setSelectedIndex } = useMenuNavigation<HTMLElement>({
		containerRef: toolbarRef,
		items,
		orientation: "horizontal",
		autoSelectFirstItem: false,
	});

	React.useEffect(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar) return;

		const updateItems = () => {
			const next = Array.from(toolbar.querySelectorAll<HTMLElement>(ITEMS));
			setItems(next);
			const focused = next.indexOf(document.activeElement as HTMLElement);
			if (focused !== -1) setSelectedIndex(focused);
		};

		updateItems();
		const observer = new MutationObserver(updateItems);
		observer.observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

		return () => observer.disconnect();
	}, [toolbarRef, setSelectedIndex]);

	React.useEffect(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar) return;

		// Arrow keys move from the button that has focus, however it got there (Tab, a click, a script).
		const handleFocusIn = (e: FocusEvent) => {
			const index = items.indexOf(e.target as HTMLElement);
			if (index !== -1) setSelectedIndex(index);
		};

		toolbar.addEventListener("focusin", handleFocusIn);

		return () => {
			toolbar.removeEventListener("focusin", handleFocusIn);
		};
	}, [toolbarRef, items, setSelectedIndex]);

	React.useEffect(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar || !items.length) return;
		const current = selectedIndex !== undefined && items[selectedIndex] ? selectedIndex : 0;
		items.forEach((item, index) => {
			item.tabIndex = index === current ? 0 : -1;
		});
		// Move focus only while it is in the toolbar: a button that turns on or off while someone types in the
		// document never takes the focus.
		const item = items[current];
		if (item && toolbar.contains(document.activeElement) && document.activeElement !== item) item.focus();
	}, [selectedIndex, items, toolbarRef]);
};

export const Toolbar = React.forwardRef<HTMLDivElement, BaseProps>(({ children, className, ...props }, ref) => {
	const toolbarRef = React.useRef<HTMLDivElement>(null);
	const composedRef = useComposedRef(toolbarRef, ref);
	useToolbarNavigation(toolbarRef);

	return (
		<div
			ref={composedRef}
			role="toolbar"
			aria-label="Document formatting"
			className={cn(TOOLBAR, className)}
			{...props}
		>
			{children}
		</div>
	);
});
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
