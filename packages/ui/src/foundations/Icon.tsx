import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "./cn";

export type { IconSvgElement };

/**
 * A Hugeicons stroke-rounded icon from the free set. Decorative: the control that holds it carries the accessible name.
 * Sizes follow foundations.md: 24 in the rail and top-bar icon buttons, 18 in buttons, 16 inline.
 */
export function Icon({
	icon,
	size = 18,
	className,
}: {
	icon: IconSvgElement;
	size?: 16 | 18 | 20 | 22 | 24;
	className?: string;
}) {
	return (
		<HugeiconsIcon
			icon={icon}
			size={size}
			strokeWidth={1.6}
			aria-hidden="true"
			focusable="false"
			className={cn("block flex-none", className)}
		/>
	);
}
