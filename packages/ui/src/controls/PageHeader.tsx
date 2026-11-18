import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { cn, Icon } from "../foundations";
import { IntentLink } from "./IntentLink";

export type Crumb = { label: string; href?: string };

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
	return (
		<nav aria-label="Breadcrumb" className={className}>
			<ol className="flex flex-wrap items-center gap-2 text-md text-text-3">
				{items.map((item, i) => {
					const last = i === items.length - 1;
					return (
						<li key={`${item.label}-${i}`} className="flex items-center gap-2">
							{last ? (
								<span aria-current="page" className="text-text-2">
									{item.label}
								</span>
							) : item.href ? (
								<IntentLink
									href={item.href}
									className="rounded-xs underline-offset-[3px] transition-colors hover:text-ink hover:underline"
								>
									{item.label}
								</IntentLink>
							) : (
								<span>{item.label}</span>
							)}
							{last ? null : <Icon icon={ArrowRight01Icon} size={16} />}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

type PageHeaderProps = {
	title: ReactNode;
	breadcrumb?: Crumb[];
	subtitle?: ReactNode;
	actions?: ReactNode;
	size?: "default" | "xl";
	className?: string;
};

export function PageHeader({ title, breadcrumb, subtitle, actions, size = "default", className }: PageHeaderProps) {
	return (
		<header
			className={cn(
				"mb-[26px] flex items-end justify-between gap-6 max-app-md:flex-col max-app-md:items-start max-app-md:gap-4",
				className,
			)}
		>
			<div className="min-w-0">
				{breadcrumb?.length ? <Breadcrumb items={breadcrumb} className="mb-2.5" /> : null}
				<h1
					className={cn(
						"leading-[1.05] tracking-[-0.02em] text-ink text-balance",
						size === "xl" ? "text-[52px] max-app-sm:text-[36px]" : "text-display-sm max-app-sm:text-title-lg",
					)}
				>
					{title}
				</h1>
				{subtitle ? <p className="mt-2 max-w-[760px] text-[15px] text-text-2 text-pretty">{subtitle}</p> : null}
			</div>
			{actions ? <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2.5">{actions}</div> : null}
		</header>
	);
}
