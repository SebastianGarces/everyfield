import { cn } from "@everyfield/ui/foundations";
import Link from "next/link";
import { PIPELINE_PATH } from "./model";

/** People and Programs, the two halves of the Pipeline page (Nora's Nov 13 call). */
export function PipelineTabs({ current }: { current: "people" | "programs" }) {
	return (
		<nav aria-label="Pipeline" className="mb-5 flex gap-1 border-b border-line">
			{(
				[
					["people", "People", PIPELINE_PATH],
					["programs", "Programs", `${PIPELINE_PATH}/programs`],
				] as const
			).map(([key, label, href]) => (
				<Link
					key={key}
					href={href}
					aria-current={current === key ? "page" : undefined}
					className={cn(
						"-mb-px cursor-pointer border-b-2 px-3 pt-1 pb-2.5 text-sm font-medium transition-colors",
						current === key ? "border-ink text-ink" : "border-transparent text-text-2 hover:text-ink",
					)}
				>
					{label}
				</Link>
			))}
		</nav>
	);
}
