"use client";

import { cn, useDocumentHidden, useReducedMotion } from "@everyfield/ui/foundations";
import { useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";

type Tab = { id: string; label: string; line: string; icon: ReactNode };

const STEP: Record<string, (i: number, n: number) => number> = {
	ArrowRight: (i, n) => (i + 1) % n,
	ArrowDown: (i, n) => (i + 1) % n,
	ArrowLeft: (i, n) => (i + n - 1) % n,
	ArrowUp: (i, n) => (i + n - 1) % n,
	Home: () => 0,
	End: (_, n) => n - 1,
};

export function Tour({ label, tabs, panels }: { label: string; tabs: readonly Tab[]; panels: readonly ReactNode[] }) {
	const [turn, setTurn] = useState({ current: 0, picked: false, run: 0 });
	const [hold, setHold] = useState<"free" | "held" | "due">("free");
	const still = useReducedMotion();
	const hidden = useDocumentHidden();
	const { current } = turn;
	const next = () => setTurn((t) => ({ current: (t.current + 1) % tabs.length, picked: false, run: t.run + 1 }));
	const select = (i: number) => {
		setTurn((t) => ({ current: i, picked: true, run: t.run + 1 }));
		if (hold === "due") setHold("held");
	};
	const advance = () => {
		if (still) return;
		if (hold === "free") next();
		else setHold("due");
	};
	const release = () => {
		if (hold === "due") next();
		setHold("free");
	};
	const keyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
		const step = STEP[e.key];
		if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
		e.preventDefault();
		const next = step(current, tabs.length);
		select(next);
		document.getElementById(`tour-tab-${tabs[next]?.id}`)?.focus();
	};
	const focusIn = (e: FocusEvent<HTMLDivElement>) => {
		if (!e.target.matches(":focus-visible")) release();
		else if (hold === "free") setHold("held");
	};
	const focusOut = (e: FocusEvent<HTMLDivElement>) => {
		if (!e.currentTarget.contains(e.relatedTarget)) release();
	};
	return (
		<div
			id="tour"
			data-held={hold !== "free" || hidden || undefined}
			className="group/tour mx-auto max-w-[1280px] text-left"
			onFocus={focusIn}
			onBlur={focusOut}
		>
			<div
				role="tablist"
				aria-label={label}
				className="grid grid-cols-4 bg-white shadow-[var(--ui-ring),0_0_0_1px_var(--color-mk-line)] max-mk-cx:grid-cols-2"
			>
				{tabs.map((t, i) => {
					const on = i === current;
					return (
						<button
							key={t.id}
							type="button"
							role="tab"
							id={`tour-tab-${t.id}`}
							aria-selected={on}
							aria-controls={`tour-panel-${t.id}`}
							tabIndex={on ? 0 : -1}
							onClick={() => select(i)}
							onKeyDown={keyDown}
							className={cn(
								"relative grid min-h-11 grid-cols-[22px_minmax(0,1fr)] content-start gap-x-3 border-0 px-5 pt-[18px] pb-5 text-left [transition:background-color_.15s,color_.15s]",
								"focus-visible:z-2 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-green-700",
								"max-mk-cx:content-center max-mk-cx:gap-x-[9px] max-mk-cx:px-3 max-mk-cx:py-3.5",
								i > 0 && "shadow-[inset_1px_0_0_var(--color-mk-line)]",
								i === 2 && "max-mk-cx:shadow-none",
								i > 1 && "max-mk-cx:border-t max-mk-cx:border-mk-line",
								on ? "bg-ink text-mk-cream-90" : "bg-white text-text-2 hover:bg-mk-canvas",
							)}
						>
							{on && (
								<span
									key={turn.run}
									aria-hidden="true"
									onAnimationEnd={advance}
									className={cn(
										"absolute inset-x-0 top-0 h-1 origin-left bg-green",
										!still &&
											(turn.picked ? "motion-safe:animate-mk-tab-fill-picked" : "motion-safe:animate-mk-tab-fill"),
										"group-data-held/tour:[animation-play-state:paused]",
									)}
								/>
							)}
							<span className="mt-0.5">{t.icon}</span>
							<span
								className={cn("type-lg leading-[1.4] font-semibold max-mk-cx:type-md", on ? "text-cream" : "text-ink")}
							>
								{t.label}
							</span>
							<span className="col-start-2 mt-1 type-md leading-[1.45] text-pretty max-mk-cx:hidden">{t.line}</span>
						</button>
					);
				})}
			</div>
			<div
				aria-hidden="true"
				className="hidden bg-mk-canvas-94 px-4 py-3.5 type-lg leading-[1.45] text-ink max-mk-cx:grid"
			>
				{tabs.map((t, i) => (
					<p key={t.id} className={cn("col-start-1 row-start-1", i !== current && "invisible")}>
						{t.line}
					</p>
				))}
			</div>
			<div className="mt-2.5 grid grid-cols-[minmax(0,1fr)] max-mk-cx:mt-1.5">
				{tabs.map((t, i) => {
					const on = i === current;
					return (
						<div
							key={t.id}
							role="tabpanel"
							id={`tour-panel-${t.id}`}
							aria-labelledby={`tour-tab-${t.id}`}
							tabIndex={on ? 0 : -1}
							inert={!on}
							className={cn(
								"col-start-1 row-start-1 flex min-w-0 flex-col focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-green-700",
								on ? "motion-safe:animate-mk-tab-in" : "invisible",
							)}
						>
							{panels[i]}
						</div>
					);
				})}
			</div>
		</div>
	);
}
