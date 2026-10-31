import { Icon } from "@/components/Icon";
import { cn } from "@/components/cn";
import { ICONS, type IconName } from "../icons";

const SIZE = {
	// The phase cards and the Evry cards: 72 px, 60 px on the phase cards at 560 px and narrower (the caller adds it).
	lg: "size-[72px] [&_svg]:size-[34px]",
	// The sending tiles.
	md: "size-14 [&_svg]:size-7",
} as const;

/**
 * The frosted icon box (OPS-82): a cream icon on a blurred, translucent ink square over a photo. It holds no app UI.
 * Decorative: the card around it carries the text.
 */
export function FrostIcon({
	icon,
	size = "lg",
	className,
}: {
	icon: IconName;
	size?: keyof typeof SIZE;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid flex-none place-items-center bg-mk-ink-40 text-cream shadow-mk-frost backdrop-blur-[10px]",
				SIZE[size],
				className,
			)}
		>
			<Icon icon={ICONS[icon]} size={34} stroke={1.5} />
		</span>
	);
}
