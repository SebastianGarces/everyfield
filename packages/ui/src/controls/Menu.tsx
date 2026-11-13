"use client";

import { DropdownMenu } from "radix-ui";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn, HoverGroup, Icon, useHoverItem, type IconSvgElement } from "../foundations";
import { Kbd } from "./Field";
import { IntentLink } from "./IntentLink";
import { usePortalContainer } from "./overlay-portal";
import { popSurface } from "./Popover";

/**
 * The menu root. Non-modal: the page around an open menu is not hidden from assistive technology, because a modal
 * menu sets aria-hidden on elements that still hold focusable controls (axe aria-hidden-focus). Focus still moves
 * into the menu, arrows move inside it, and Esc, Tab or an outside click closes it and returns focus to the trigger.
 */
export function Menu({ modal = false, ...props }: ComponentPropsWithRef<typeof DropdownMenu.Root>) {
	return <DropdownMenu.Root modal={modal} {...props} />;
}
export const MenuTrigger = DropdownMenu.Trigger;

/**
 * Menu (components.md): Label, Item, Separator and Kbd, with a danger item. WAI-ARIA menu button: Enter, Space or
 * the down arrow opens it on the first item, arrows move, typing jumps to an item, Esc closes and returns focus.
 * One highlight slides under the hovered or focused item.
 */
export function MenuContent({
	className,
	children,
	align = "start",
	sideOffset = 8,
	...props
}: ComponentPropsWithRef<typeof DropdownMenu.Content>) {
	const container = usePortalContainer();
	return (
		<DropdownMenu.Portal container={container}>
			<DropdownMenu.Content
				align={align}
				sideOffset={sideOffset}
				collisionPadding={12}
				className={cn(
					popSurface,
					"min-w-[220px] origin-[var(--radix-dropdown-menu-content-transform-origin)]",
					className,
				)}
				{...props}
			>
				<HoverGroup>{children}</HoverGroup>
			</DropdownMenu.Content>
		</DropdownMenu.Portal>
	);
}

export function MenuLabel({ className, ...props }: ComponentPropsWithRef<typeof DropdownMenu.Label>) {
	return <DropdownMenu.Label className={cn("px-2.5 pt-2 pb-1 text-xs text-text-3", className)} {...props} />;
}

type MenuItemProps = Omit<ComponentPropsWithRef<typeof DropdownMenu.Item>, "children"> & {
	icon?: IconSvgElement;
	/** A shortcut shown on the right, such as "E". */
	shortcut?: string;
	/** A destructive action. Its text says what it does ("Retire person"). */
	danger?: boolean;
	/** An item that goes to another page is a link, so a page that guards unsaved work sees it as one. */
	href?: string;
	children: ReactNode;
};

/** Radix moves focus to the highlighted item; the HoverGroup highlight follows the pointer and keyboard focus. */
const ITEM =
	"relative flex h-[38px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-md outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45";

export function MenuItem({ icon, shortcut, danger, href, className, children, textValue, ...props }: MenuItemProps) {
	const key = useId();
	const { handlers, indicator } = useHoverItem(key, danger ? "bg-magenta-50" : "bg-surface-2");
	const content = (
		<>
			{indicator}
			{icon ? <Icon icon={icon} size={18} className={danger ? "text-magenta-600" : "text-text-2"} /> : null}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{shortcut ? <Kbd className="ml-auto">{shortcut}</Kbd> : null}
		</>
	);
	return (
		<DropdownMenu.Item
			textValue={textValue}
			{...handlers}
			className={cn(ITEM, danger ? "text-magenta-600" : "text-ink", className)}
			asChild={href !== undefined}
			{...props}
		>
			{href !== undefined ? <IntentLink href={href}>{content}</IntentLink> : content}
		</DropdownMenu.Item>
	);
}

export function MenuSeparator({ className, ...props }: ComponentPropsWithRef<typeof DropdownMenu.Separator>) {
	return <DropdownMenu.Separator className={cn("mx-1 my-1.5 h-px bg-line", className)} {...props} />;
}

/** A checkable item for view switchers ("current view" in the user menu). */
export function MenuRadioGroup(props: ComponentPropsWithRef<typeof DropdownMenu.RadioGroup>) {
	return <DropdownMenu.RadioGroup {...props} />;
}

export function MenuRadioItem({ className, children, ...props }: ComponentPropsWithRef<typeof DropdownMenu.RadioItem>) {
	return (
		<DropdownMenu.RadioItem className={cn(ITEM, "text-ink data-[highlighted]:bg-surface-2", className)} {...props}>
			<span className="min-w-0 flex-1 truncate">{children}</span>
			<DropdownMenu.ItemIndicator className="ml-auto text-sm font-medium text-text-2">
				Current
			</DropdownMenu.ItemIndicator>
		</DropdownMenu.RadioItem>
	);
}
