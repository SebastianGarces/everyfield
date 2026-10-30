"use client";

import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState } from "react";
import type { Step } from "./next-step.ts";

const STATE_WORD = { done: "done", current: "current step", later: "later" } as const;

/**
 * The meeting's life as three steps with their counts. A status display, not navigation: nothing in it is a control.
 * Where the steps do not fit, the list scrolls sideways and takes a tab stop so the keyboard can reach all of it.
 */
export function Stepper({ steps }: { steps: Step[] }) {
	const list = useRef<HTMLOListElement>(null);
	const [scrolls, setScrolls] = useState(false);
	useEffect(() => {
		const el = list.current;
		if (!el) return;
		const measure = () => setScrolls(el.scrollWidth > el.clientWidth);
		measure();
		const watch = new ResizeObserver(measure);
		watch.observe(el);
		return () => watch.disconnect();
	}, []);
	return (
		<ol
			ref={list}
			aria-label="Meeting steps"
			tabIndex={scrolls ? 0 : undefined}
			className="relative flex gap-3 overflow-x-auto rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
		>
			{steps.map((s, i) => (
				<li
					key={s.id}
					aria-current={s.state === "current" ? "step" : undefined}
					className={`flex min-w-[17rem] flex-1 items-center gap-3 rounded-lg border px-4 py-3 ${
						s.state === "current"
							? "border-ink bg-ink text-on-ink"
							: s.state === "done"
								? "border-line bg-surface text-ink"
								: "border-dashed border-line text-text-2"
					}`}
				>
					<span
						aria-hidden="true"
						className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${
							s.state === "current"
								? "bg-on-ink text-ink"
								: s.state === "done"
									? "bg-green-500 text-white"
									: "bg-surface-2 text-text-2"
						}`}
					>
						{s.state === "done" ? <Icon icon={CheckmarkCircle02Icon} size={18} /> : i + 1}
					</span>
					<span className="min-w-0">
						<span className="block text-md font-semibold">
							{s.label}
							<span className="sr-only"> ({STATE_WORD[s.state]})</span>
						</span>
						<span className={`block text-sm ${s.state === "current" ? "text-on-ink" : "text-text-2"}`}>{s.line}</span>
					</span>
				</li>
			))}
		</ol>
	);
}
