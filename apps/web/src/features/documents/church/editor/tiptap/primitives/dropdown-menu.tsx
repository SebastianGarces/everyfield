import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { usePortalContainer } from "@everyfield/ui/controls";
import { cn } from "../tiptap-utils.ts";
import { MENU } from "../styles.ts";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
	return <DropdownMenuPrimitive.Root modal={false} {...props} />;
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
	// Everyfield change: portal into the product root, not <body>, so the product font, tokens and focus ring apply.
	const container = usePortalContainer();
	return <DropdownMenuPrimitive.Portal container={container} {...props} />;
}

const DropdownMenuTrigger = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ ...props }, ref) => <DropdownMenuPrimitive.Trigger ref={ref} {...props} />);
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

const DropdownMenuItem = DropdownMenuPrimitive.Item;

const DropdownMenuContent = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
		portal?: boolean;
	}
>(({ className, sideOffset = 4, portal = false, onEscapeKeyDown, ...props }, ref) => {
	// Everyfield change: Escape returns focus to the menu's button, as the menu button pattern asks. Choosing an item
	// still leaves focus where the item's action put it (the document), as Tiptap does.
	const escaped = React.useRef(false);
	const content = (
		<DropdownMenuPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			onEscapeKeyDown={(e) => {
				escaped.current = true;
				onEscapeKeyDown?.(e);
			}}
			onCloseAutoFocus={(e) => {
				if (!escaped.current) e.preventDefault();
				escaped.current = false;
			}}
			className={cn(MENU, className)}
			{...props}
		/>
	);

	return portal ? (
		<DropdownMenuPortal {...(typeof portal === "object" ? portal : {})}>{content}</DropdownMenuPortal>
	) : (
		content
	);
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
