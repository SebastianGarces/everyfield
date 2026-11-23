import type { ComponentPropsWithoutRef } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";

const SIZE = { xs: "text-xs font-medium", sm: "text-sm" } as const;

type ProblemTextProps = Omit<ComponentPropsWithoutRef<"p">, "role" | "style"> & {
	size?: keyof typeof SIZE;
	icon?: IconSvgElement;
	as?: "p" | "span";
	live?: "alert" | "region";
};

export function ProblemText({
	size = "xs",
	icon,
	as: Tag = "p",
	live = "alert",
	className,
	children,
	...props
}: ProblemTextProps) {
	return (
		<Tag
			{...props}
			role={live === "alert" ? "alert" : undefined}
			className={cn(SIZE[size], icon && "flex items-center gap-1.5", "text-magenta-600", className)}
		>
			{icon ? <Icon icon={icon} size={16} /> : null}
			{children}
		</Tag>
	);
}
