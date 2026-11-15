import Link from "next/link";
import { cn } from "@everyfield/ui/foundations";

type View = "overview" | "trends" | "journey" | "attestations";
const VIEWS: { key: View; label: string; href: string }[] = [
	{ key: "overview", label: "Assessment", href: "/intelligence" },
	{ key: "trends", label: "Trends", href: "/intelligence/trends" },
	{ key: "journey", label: "Journey", href: "/intelligence/journey" },
	{ key: "attestations", label: "Attestations", href: "/intelligence/attestations" },
];

/**
 * The Plant Intelligence views (prototype .intel-tabs): the assessment, its trends, the phase journey and Attestations.
 * The count is what needs the admin's attention on Attestations: answers to renew and signals nobody answered. It
 * shows only where it is already known.
 */
export function IntelligenceTabs({ current, count }: { current: View; count?: number }) {
	const tab = (active: boolean) =>
		cn(
			"inline-flex items-center gap-2 rounded-md px-3.5 py-2 font-medium whitespace-nowrap text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] max-app-sm:px-2.5",
			active && "bg-surface-raised shadow-[var(--ef-shadow-raised)]",
		);
	return (
		<nav
			aria-label="Plant Intelligence views"
			className="mb-5 flex w-max max-w-full gap-1 overflow-x-auto rounded-md bg-surface-2 p-1"
		>
			{VIEWS.map((v) => (
				<Link
					key={v.key}
					href={v.href}
					aria-current={current === v.key ? "page" : undefined}
					className={tab(current === v.key)}
				>
					{v.label}
					{v.key === "attestations" && count ? (
						<span className="inline-grid h-5 min-w-5 place-items-center rounded-pill bg-amber-100 px-1.5 text-xs font-semibold text-amber-600">
							{count}
							<span className="sr-only"> need attention</span>
						</span>
					) : null}
				</Link>
			))}
		</nav>
	);
}
