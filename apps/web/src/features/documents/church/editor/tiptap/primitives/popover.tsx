import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { usePortalContainer } from "@everyfield/ui/controls";
import { cn } from "../tiptap-utils.ts";
import { POPOVER } from "../styles.ts";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
	return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
	return <PopoverPrimitive.Trigger {...props} />;
}

function PopoverContent({
	className,
	align = "center",
	sideOffset = 4,
	...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
	// Everyfield change: portal into the product root, not <body>, so the product font, tokens and focus ring apply.
	const container = usePortalContainer();
	return (
		<PopoverPrimitive.Portal container={container}>
			<PopoverPrimitive.Content align={align} sideOffset={sideOffset} className={cn(POPOVER, className)} {...props} />
		</PopoverPrimitive.Portal>
	);
}

export { Popover, PopoverTrigger, PopoverContent };
