import Link from "next/link";
import { cn } from "@everyfield/ui/foundations";

/**
 * The Plant Intelligence views (prototype .intel-tabs): Overview and Attestations. The count is what needs the admin's
 * attention on Attestations: answers to renew and signals nobody answered. It shows only where it is already known.
 */
export function IntelligenceTabs({ current, count }: { current: "overview" | "attestations"; count?: number }) {
	const tab = (active: boolean) =>
		cn(
			"inline-flex cursor-pointer items-center gap-2 rounded-md px-3.5 py-2 font-medium text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)]",
			active && "bg-surface-raised text-ink shadow-[var(--ef-shadow-raised)]",
		);
	return (
		<nav aria-label="Plant Intelligence views" className="mb-5 flex w-max max-w-full gap-1 rounded-md bg-surface-2 p-1">
			<Link
				href="/intelligence"
				aria-current={current === "overview" ? "page" : undefined}
				className={tab(current === "overview")}
			>
				Overview
			</Link>
			<Link
				href="/intelligence/attestations"
				aria-current={current === "attestations" ? "page" : undefined}
				className={tab(current === "attestations")}
			>
				Attestations
				{count ? (
					<span className="inline-grid h-5 min-w-5 place-items-center rounded-pill bg-amber-100 px-1.5 text-xs font-semibold text-amber-600">
						{count}
						<span className="sr-only"> need attention</span>
					</span>
				) : null}
			</Link>
		</nav>
	);
}
