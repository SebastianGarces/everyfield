"use client";

import { ArrowLeft01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { Button, Sheet, Skeleton, StatePanel, useToast } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useId, useRef, useState } from "react";
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

// Phase checklists (TSK-009): the fixed Everyfield catalog, grouped by phase and then by kind of work, with the
// church's current phase marked. A preview shows each task and its due date; importing adds exactly those tasks to the
// list, assigned to the person who imported them. Owner and Admin only.

type Load<T> = { status: "loading" } | { status: "failed"; message: string } | { status: "ok"; value: T };
const loadFailed = (r: Exclude<Outcome<unknown>, { status: "ok" }>) => ({
	status: "failed" as const,
	message: r.status === "lost" ? "Check your connection and try again." : problemText(r.code),
});
export const phaseName = (phase: number) => `Phase ${phase} · ${SHORT_NAME[phase] ?? ""}`;

export function Templates({
	year,
	onImported,
}: {
	year: number;
	/** The confirmed new tasks, for the list to show without a reload. */
	onImported: (tasks: TaskItem[]) => void;
}) {
	const toast = useToast();
	const [open, setOpen] = useState(false);
	const [catalog, setCatalog] = useState<Load<TemplateCatalog>>({ status: "loading" });
	const [chosen, setChosen] = useState<string | null>(null);
	const [preview, setPreview] = useState<Load<TemplatePreview>>({ status: "loading" });
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	// One import intent: a lost answer is sent again with the same key, so the tasks are added once.
	const intent = useRef<string>("");
	const reading = useRef(false);

	const readCatalog = () => {
		reading.current = true;
		setCatalog({ status: "loading" });
		void loadTemplates().then((r) => {
			reading.current = false;
			setCatalog(r.status === "ok" ? r : loadFailed(r));
		});
	};
	const readPreview = (key: string) => {
		setPreview({ status: "loading" });
		void loadPreview(key).then((r) => setPreview(r.status === "ok" ? r : loadFailed(r)));
	};
	// The catalog is read on intent (pointer or focus on the button) or on open, once; a failed read offers a retry.
	const warm = () => {
		if (catalog.status !== "ok" && !reading.current) readCatalog();
	};
	const onOpenChange = (o: boolean) => {
		setOpen(o);
		if (o) warm();
		else choose(null);
	};
	const choose = (key: string | null) => {
		setChosen(key);
		setProblem(null);
		intent.current = crypto.randomUUID();
		if (key) readPreview(key);
	};

	async function add(p: TemplatePreview) {
		setSaving(true);
		setProblem(null);
		const r = await importTemplate(intent.current, {
			catalogVersion: p.catalogVersion,
			checklistKey: p.checklist.key,
			itemKeys: p.checklist.tasks.map((t) => t.key),
		}).catch((): Outcome<never> => ({ status: "lost" }));
		setSaving(false);
		if (r.status === "lost") {
			setProblem(problemText("lost"));
			return;
		}
		intent.current = crypto.randomUUID();
		if (r.status === "refused") {
			setProblem(problemText(r.code));
			// The catalog changed under the preview: show the current one.
			if (r.code === "stale_catalog") {
				readCatalog();
				readPreview(p.checklist.key);
			}
			return;
		}
		onImported(r.value.tasks);
		toast({ tone: "success", message: `Added ${taskCount(r.value.tasks.length)} from “${p.checklist.name}”.` });
		onOpenChange(false);
	}

	const shown = chosen && preview.status === "ok" && preview.value.checklist.key === chosen ? preview.value : null;
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
			className="w-[560px]"
			footer={
				chosen ? (
					<>
						<Button variant="ghost" icon={ArrowLeft01Icon} onClick={() => choose(null)}>
							All checklists
						</Button>
						<span className="flex-1" />
						<Button variant="primary" disabled={!shown} loading={saving} onClick={() => shown && void add(shown)}>
							{shown ? `Add ${taskCount(shown.checklist.tasks.length)}` : "Add tasks"}
						</Button>
					</>
				) : undefined
			}
		>
			{chosen ? (
				<PreviewBody state={preview} shown={shown} year={year} problem={problem} onRetry={() => readPreview(chosen)} />
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
			<StatePanel tone="error" title="The checklists did not load" headingLevel="h3">
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
							<p className="text-xs font-medium tracking-wide text-text-3 uppercase">{CATEGORY_LABEL[cat.category]}</p>
							<ul className="mt-1 flex flex-col">
								{cat.checklists.map((k) => (
									<li key={k.key}>
										<button
											type="button"
											onClick={() => onChoose(k.key)}
											className="flex w-full cursor-pointer items-start gap-3 rounded-md px-2 py-2.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
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

/** The chosen checklist's body: its description, what adding it does and its tasks under a heading that names it. */
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
			<StatePanel tone="error" title="This checklist did not load" headingLevel="h3">
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
