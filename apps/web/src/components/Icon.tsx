import { cn } from "@everyfield/ui/foundations";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function Icon({
	icon,
	size = 18,
	stroke = 1.7,
	className,
}: {
	icon: IconSvgElement;
	size?: number;
	stroke?: number;
	className?: string;
}) {
	return (
		<HugeiconsIcon
			icon={icon}
			size={size}
			strokeWidth={stroke}
			aria-hidden="true"
			focusable="false"
			className={cn("block flex-none", className)}
		/>
	);
}
