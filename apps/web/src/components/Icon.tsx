import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "./cn";

/**
 * A Hugeicons stroke-rounded icon. Decorative: the control that holds it carries the accessible name.
 * Stroke 1.7 keeps the weight of the marketing prototype's icons. The default 18 px is the prototype's product-visual size
 * (its `.ef svg.i` rule also won over most smaller per-component sizes, so most panel icons are 18 px). Render icons in Server Components where possible,
 * so the icon data stays out of the client bundle.
 */
export function Icon({
	icon,
	size = 18,
	stroke = 1.7,
	className,
}: {
	icon: IconSvgElement;
	size?: number;
	/** The large marketing icons (frosted boxes, journey stops) draw thinner, as in the prototype. */
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
