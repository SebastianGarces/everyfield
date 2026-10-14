import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "./cn";

/**
 * A Hugeicons stroke-rounded icon. Decorative: the control that holds it carries the accessible name.
 * Stroke 1.7 keeps the weight of the marketing prototype's icons. Render icons in Server Components where possible,
 * so the icon data stays out of the client bundle.
 */
export function Icon({ icon, size = 18, className }: { icon: IconSvgElement; size?: number; className?: string }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.7} aria-hidden="true" focusable="false" className={cn("block flex-none", className)} />;
}
