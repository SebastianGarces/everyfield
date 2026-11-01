import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "../tiptap-utils.ts";
import { MENU } from "../styles.ts";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
	return <DropdownMenuPrimitive.Root modal={false} {...props} />;
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
	return <DropdownMenuPrimitive.Portal {...props} />;
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
>(({ className, sideOffset = 4, portal = false, ...props }, ref) => {
	const content = (
		<DropdownMenuPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			onCloseAutoFocus={(e) => e.preventDefault()}
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
