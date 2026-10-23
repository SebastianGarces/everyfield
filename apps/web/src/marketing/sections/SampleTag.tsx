import { cn } from "@/components/cn";
import { COPY } from "../copy";

/** Revision 8: the "Sample data" caption in a corner of the /oversight mockups of the sample Austin Sending Network's data. */
export function SampleTag({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"pointer-events-none absolute z-8 inline-flex h-6 items-center bg-white px-2 type-xs font-semibold text-ink-2 shadow-mk-chip",
				className,
			)}
		>
			{COPY.shared.sample_label}
		</span>
	);
}
