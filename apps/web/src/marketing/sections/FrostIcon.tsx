import { cn } from "@everyfield/ui/foundations";
import { Icon } from "@/components/Icon";
import { ICONS, type IconName } from "../icons";

const SIZE = {
	lg: "size-[72px] [&_svg]:size-[34px]",
	md: "size-14 [&_svg]:size-7",
} as const;

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
