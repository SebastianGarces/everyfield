"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/cn";

/**
 * One FAQ question (Revision 26): a button that opens its answer; several can be open at once. A link to #faq-<id> opens
 * that answer (on load and on a hash change). The answer's height animates with grid rows, as in the prototype.
 */
export function FaqItem({ id, q, children }: { id: string; q: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const fromHash = () => {
			if (decodeURIComponent(location.hash.slice(1)) === id) setOpen(true);
		};
		fromHash();
		window.addEventListener("hashchange", fromHash);
		return () => window.removeEventListener("hashchange", fromHash);
	}, [id]);
	return (
		<div id={id} className="group/faq border-t border-mk-line last:border-b" data-open={open || undefined}>
			<h3 className="m-0 [font:inherit]">
				<button
					type="button"
					id={id + "-q"}
					aria-expanded={open}
					aria-controls={id + "-a"}
					onClick={() => setOpen((o) => !o)}
					className="group/faq-q flex w-full cursor-pointer items-center justify-between gap-6 border-0 bg-transparent py-[22px] text-left font-display text-[clamp(18px,1.4vw,21px)] leading-[1.3] font-medium tracking-[-0.015em] text-ink focus-visible:rounded-[6px] max-mk-cx:py-[18px]"
				>
					<span>{q}</span>
					<span
						aria-hidden="true"
						className={cn(
							"relative size-[30px] flex-none rounded-sm bg-linen [transition:background-color_.3s_var(--ease-mk)] group-hover/faq-q:bg-mk-surface-3",
							"before:absolute before:top-1/2 before:left-1/2 before:-mt-[.85px] before:-ml-1.5 before:h-[1.7px] before:w-3 before:rounded-[2px] before:bg-ink before:[transition:transform_.3s_var(--ease-mk)] before:content-['']",
							"after:absolute after:top-1/2 after:left-1/2 after:-mt-[.85px] after:-ml-1.5 after:h-[1.7px] after:w-3 after:rounded-[2px] after:bg-ink after:[transition:transform_.3s_var(--ease-mk)] after:content-[''] after:[transform:rotate(90deg)] group-data-[open]/faq:after:[transform:rotate(0deg)]",
						)}
					/>
				</button>
			</h3>
			<div
				id={id + "-a"}
				className="invisible grid grid-rows-[0fr] opacity-0 [transition:grid-template-rows_.3s_var(--ease-mk),opacity_.3s_var(--ease-mk),visibility_0s_linear_.3s] group-data-[open]/faq:visible group-data-[open]/faq:grid-rows-[1fr] group-data-[open]/faq:opacity-100 group-data-[open]/faq:[transition:grid-template-rows_.3s_var(--ease-mk),opacity_.3s_var(--ease-mk),visibility_0s]"
			>
				<div className="min-h-0 overflow-hidden">{children}</div>
			</div>
		</div>
	);
}
