import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { usePortalContainer } from "@everyfield/ui/controls";
import { cn } from "../tiptap-utils.ts";
import { POPOVER } from "../styles.ts";
import { InToolbar } from "./toolbar.tsx";

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
	const container = usePortalContainer();
	return (
		<PopoverPrimitive.Portal container={container}>
			<InToolbar value={false}>
				<PopoverPrimitive.Content align={align} sideOffset={sideOffset} className={cn(POPOVER, className)} {...props} />
			</InToolbar>
		</PopoverPrimitive.Portal>
	);
}

export { Popover, PopoverTrigger, PopoverContent };
