"use client";

import { ArrowLeft01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { Button, Sheet, Skeleton, StatePanel, toast } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { useId, useRef, useState, useTransition } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { SHORT_NAME } from "../phases/model.ts";
import { importTemplate } from "./actions.ts";
import { DescriptionView } from "./description.ts";
import { loadPreview, loadTemplates } from "./fetch.ts";
import {
	CATEGORY_LABEL,
	checklistGroups,
	dayText,
	PRIORITY_LABEL,
	problemText,
	taskCount,
	type Outcome,
	type TaskItem,
	type TemplateCatalog,
	type TemplatePreview,
} from "./model.ts";
import type { ReadFailure } from "../../components/get-reads.ts";
import { failedIcon } from "../../components/read-failed.ts";

type Load<T> =
	| { status: "loading" }
	| { status: "failed"; message: string; icon: IconSvgElement | undefined }
	| { status: "ok"; value: T };
const loadFailed = (r: Exclude<Outcome<unknown> | ReadFailure, { status: "ok" }>) => ({
	status: "failed" as const,
	icon: failedIcon(r),
	message:
		r.status === "lost"
			? "Check your connection and try again."
			: problemText(r.status === "refused" ? r.code : r.status),
});
export const phaseName = (phase: number) => `Phase ${phase} · ${SHORT_NAME[phase] ?? ""}`;
const previews = createRead((key: string) => loadPreview(key), { failed: () => ({ status: "lost" }) as const });

export function Templates({ year, onImported }: { year: number; onImported: (tasks: TaskItem[]) => void }) {
	const [open, setOpen] = useState(false);
	const [catalog, setCatalog] = useState<Load<TemplateCatalog>>({ status: "loading" });
	const [chosen, setChosen] = useState<string | null>(null);
	const [saving, startSaving] = useTransition();
	const [problem, setProblem] = useState<string | null>(null);
	const intent = useRef<string>("");
	const reading = useRef(false);
	const read = useRead(chosen ? previews : null, chosen ?? "");
	const preview: Load<TemplatePreview> =
		read.value === undefined ? { status: "loading" } : read.value.status === "ok" ? read.value : loadFailed(read.value);

	const readCatalog = () => {
		reading.current = true;
		setCatalog({ status: "loading" });
		void loadTemplates().then((r) => {
			reading.current = false;
			setCatalog(r.status === "ok" ? r : loadFailed(r));
		});
	};
	const warm = () => {
		if (catalog.status !== "ok" && !reading.current) readCatalog();
	};
	const onOpenChange = (o: boolean) => {
		setOpen(o);
		if (o) warm();
		else choose(null);
	};
	const choose = (key: string | null) => {
		if (key) previews.prefetch(key);
		setChosen(key);
		setProblem(null);
		intent.current = crypto.randomUUID();
	};

	const add = (p: TemplatePreview) =>
		startSaving(async () => {
			setProblem(null);
			const r = await importTemplate(intent.current, {
				catalogVersion: p.catalogVersion,
				checklistKey: p.checklist.key,
				itemKeys: p.checklist.tasks.map((t) => t.key),
			}).catch((): Outcome<never> => ({ status: "lost" }));
			if (r.status === "lost") {
				setProblem(problemText("lost"));
				return;
			}
			intent.current = crypto.randomUUID();
			if (r.status === "refused") {
				setProblem(problemText(r.code));
				if (r.code === "stale_catalog") {
					readCatalog();
					previews.retry(p.checklist.key);
				}
				return;
			}
			onImported(r.value.tasks);
			toast({ tone: "success", message: `Added ${taskCount(r.value.tasks.length)} from “${p.checklist.name}”.` });
			onOpenChange(false);
		});

	const shown = chosen && preview.status === "ok" ? preview.value : null;
	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
			trigger={
				<Button variant="secondary" icon={CheckListIcon} onPointerEnter={warm} onFocus={warm}>
					Phase checklists
				</Button>
			}
			title={shown ? shown.checklist.name : "Phase checklists"}
			description={
				shown
					? `${phaseName(shown.checklist.phase)} · ${CATEGORY_LABEL[shown.checklist.category]}`
					: "Ready-made task lists for each phase. Preview one, then add its tasks to your list."
			}
			size="xl"
			footer={
				chosen ? (
					<>
						<Button variant="ghost" icon={ArrowLeft01Icon} onClick={() => choose(null)}>
							All checklists
						</Button>
						<span className="flex-1" />
						<Button variant="primary" disabled={!shown} loading={saving} onClick={() => shown && add(shown)}>
							{shown ? `Add ${taskCount(shown.checklist.tasks.length)}` : "Add tasks"}
						</Button>
					</>
				) : undefined
			}
		>
			{chosen ? (
				<PreviewBody state={preview} shown={shown} year={year} problem={problem} onRetry={read.retry} />
			) : (
				<CatalogBody state={catalog} onRetry={readCatalog} onChoose={choose} />
			)}
		</Sheet>
	);
}

function CatalogBody({
	state,
	onRetry,
	onChoose,
}: {
	state: Load<TemplateCatalog>;
	onRetry: () => void;
	onChoose: (key: string) => void;
}) {
	if (state.status === "loading")
		return (
			<div aria-busy="true" className="flex flex-col gap-3">
				<span className="sr-only" role="status">
					Loading checklists
				</span>
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-16 rounded-md" />
				))}
			</div>
		);
	if (state.status === "failed")
		return (
			<StatePanel tone="error" title="The checklists did not load" icon={state.icon} headingLevel="h3">
				{state.message}{" "}
				<Button variant="secondary" size="sm" onClick={onRetry}>
					Try again
				</Button>
			</StatePanel>
		);
	const current = state.value.currentPhase;
	return (
		<div className="flex flex-col gap-6">
			{checklistGroups(state.value.checklists).map((g) => (
				<section key={g.phase} aria-labelledby={`checklist-phase-${g.phase}`}>
					<h3
						id={`checklist-phase-${g.phase}`}
						className="flex items-center gap-2 font-sans text-sm font-semibold tracking-normal text-ink"
					>
						{phaseName(g.phase)}
						{g.phase === current ? (
							<StatusBadge status="positive" size="sm">
								Current phase
							</StatusBadge>
						) : null}
					</h3>
					{g.categories.map((cat) => (
						<div key={cat.category} className="mt-2">
							<p className="section-label text-text-3">{CATEGORY_LABEL[cat.category]}</p>
							<ul className="mt-1 flex flex-col">
								{cat.checklists.map((k) => (
									<li key={k.key}>
										<button
											type="button"
											onClick={() => onChoose(k.key)}
											className="flex w-full items-start gap-3 rounded-md px-2 py-2.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
										>
											<Icon icon={CheckListIcon} size={18} className="mt-0.5 flex-none text-text-3" />
											<span className="min-w-0 flex-1">
												<span className="block font-medium text-ink">{k.name}</span>
												<span className="mt-0.5 block text-sm text-text-2">{k.description}</span>
											</span>
											<span className="flex-none pt-0.5 text-sm whitespace-nowrap text-text-3">
												{taskCount(k.taskCount)}
											</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					))}
				</section>
			))}
		</div>
	);
}

function PreviewBody({
	state,
	shown,
	year,
	problem,
	onRetry,
}: {
	state: Load<TemplatePreview>;
	shown: TemplatePreview | null;
	year: number;
	problem: string | null;
	onRetry: () => void;
}) {
	const headingId = useId();
	if (state.status === "failed")
		return (
			<StatePanel tone="error" title="This checklist did not load" icon={state.icon} headingLevel="h3">
				{state.message}{" "}
				<Button variant="secondary" size="sm" onClick={onRetry}>
					Try again
				</Button>
			</StatePanel>
		);
	if (!shown)
		return (
			<div aria-busy="true" className="flex flex-col gap-3">
				<span className="sr-only" role="status">
					Loading the checklist
				</span>
				{[0, 1, 2, 3, 4].map((i) => (
					<Skeleton key={i} className="h-12 rounded-md" />
				))}
			</div>
		);
	const k = shown.checklist;
	return (
		<div className="flex flex-col gap-4">
			<p className="text-md text-ink">{k.description}</p>
			<p className="text-sm text-text-2" role="status">
				Adds {taskCount(k.tasks.length)} to your list, assigned to you, due from today (
				{dayText(shown.anchorDate, year)}). Adding it again later adds another copy.
			</p>
			{problem ? (
				<p role="alert" className="rounded-md bg-surface px-4 py-2.5 text-sm text-ink">
					{problem}
				</p>
			) : null}
			<div className="flex flex-col gap-1">
				<h3 id={headingId} className="font-sans text-sm font-semibold tracking-normal text-ink">
					Tasks in {k.name}
				</h3>
				<ol aria-labelledby={headingId} className="flex flex-col">
					{k.tasks.map((t) => (
						<li key={t.key} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0">
							<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
								<span className="font-medium text-ink">{t.title}</span>
								<span className="text-sm whitespace-nowrap text-text-2">
									{PRIORITY_LABEL[t.priority]} · Due {dayText(t.due, year)}
								</span>
							</div>
							{t.description ? <DescriptionView value={t.description} /> : null}
						</li>
					))}
				</ol>
			</div>
		</div>
	);
}
