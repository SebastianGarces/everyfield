"use client";

import {
	AREA_LABEL,
	checkNote,
	countdown,
	PRACTICES_REQUIRED,
	reviewedOf,
	type Area,
	type Milestone,
	type Plan,
	type PrepTask,
} from "@everyfield/contracts/launch";
import { nearLaunch } from "@everyfield/contracts/oversight";
import {
	Alert02Icon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	Calendar03Icon,
	StartUp02Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	CalloutLabel,
	CalloutText,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	InsightCard,
	InsightCount,
	InsightFooter,
	InsightMetric,
	InsightPill,
	InsightText,
	InsightTitle,
	InsightTop,
	Input,
	PageHeader,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useId, useState } from "react";
import { changeTaskStatus } from "../tasks/actions.ts";
import { DoneBox } from "../tasks/parts.tsx";
import { completeMilestone, postponeLaunch, reopenMilestone, setLaunchDate } from "./actions.ts";
import { DebriefCard, SummaryCard } from "./Debrief.tsx";
import { LaunchHistory } from "./History.tsx";
import { OutcomeCard } from "./Outcome.tsx";
import { daysText, gapText } from "../oversight/model.ts";
import {
	instantDate,
	isOpen,
	longDate,
	NOTE_MESSAGE,
	progressOf,
	refusalMessage,
	requestKeys,
	sent,
	shortDate,
	shownOf,
	tasksText,
} from "./model.ts";

type Viewer = { accountId: string; admin: boolean };
type DateDraft = { mode: "set" | "move" | "postpone"; date: string; reason: string; error: string | null };
const AREAS: Area[] = ["operations", "launch_team", "promotion"];

/**
 * The Launch plan (WP-045, prototype #/launch): Launch Sunday and its countdown in church-local days, and the nine
 * Playbook milestones with their prep tasks. Owners and Admins set, move and postpone the date and complete or reopen
 * milestones; anyone completes the prep tasks they hold. Every change shows at once and is confirmed or rolled back
 * from the server's answer; nothing reloads the page.
 */
export function LaunchScreen({ plan: initial, viewer }: { plan: Plan; viewer: Viewer }) {
	const toast = useToast();
	const [plan, setPlan] = useState(initial);
	const [draft, setDraft] = useState<DateDraft | null>(null);
	const [saving, setSaving] = useState(false);
	const [keys] = useState(() => requestKeys(() => crypto.randomUUID()));
	const shown = shownOf(plan);
	const dated = shown.kind === "ahead" || shown.kind === "today" || shown.kind === "overdue";

	const replaceMilestone = (m: Milestone) =>
		setPlan((p) => ({ ...p, milestones: p.milestones.map((x) => (x.id === m.id ? m : x)) }));

	async function submitDate(d: DateDraft) {
		const note = checkNote(d.reason, d.mode !== "set");
		if (!note.ok) return setDraft({ ...d, error: NOTE_MESSAGE[note.problem] });
		if (d.mode !== "postpone" && !d.date) return setDraft({ ...d, error: "Choose a date for Launch Sunday." });
		const intent = [d.mode, plan.revision, d.date, d.reason] as const;
		setSaving(true);
		const r = await sent(() =>
			d.mode === "postpone"
				? postponeLaunch(keys.keyFor(intent), plan.revision, d.reason)
				: setLaunchDate(keys.keyFor(intent), plan.revision, d.date, d.reason.trim() ? d.reason : null),
		);
		setSaving(false);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") {
			setDraft(null);
			setPlan(r.value.plan);
			if (r.value.outcome === "noop")
				toast({ message: "No change: Launch Sunday is already that date.", tone: "info" });
			return;
		}
		setDraft({ ...d, error: refusalMessage(r) });
	}

	const open = (mode: DateDraft["mode"]) =>
		setDraft({ mode, date: mode === "postpone" ? "" : (plan.launch?.targetDate ?? ""), reason: "", error: null });
	const actions = viewer.admin ? (
		dated ? (
			<>
				<Button variant="secondary" onClick={() => open("move")}>
					<Icon icon={Calendar03Icon} size={16} />
					Move date
				</Button>
				<Button variant="ghost" onClick={() => open("postpone")}>
					Postpone
				</Button>
			</>
		) : shown.kind === "completed" ? null : (
			<Button variant="primary" onClick={() => open("set")}>
				<Icon icon={Calendar03Icon} size={16} />
				Set Launch Sunday
			</Button>
		)
	) : null;

	// What happened on Launch Sunday (WP-046): first once it is recorded, after the milestones until then.
	const after = (
		<>
			<OutcomeCard plan={plan} admin={viewer.admin} keys={keys} onPlan={setPlan} />
			{plan.outcome ? <DebriefCard plan={plan} admin={viewer.admin} keys={keys} onPlan={setPlan} /> : null}
			{viewer.admin && plan.summary && plan.debrief?.submitted ? (
				<SummaryCard plan={plan} keys={keys} onPlan={setPlan} />
			) : null}
		</>
	);

	return (
		<>
			<PageHeader
				size="xl"
				title={
					<span className="inline-flex flex-wrap items-center gap-3">
						Launch plan
						<StatusBadge status={shown.tone} className="font-sans tracking-normal">
							{shown.badge}
						</StatusBadge>
					</span>
				}
				subtitle="Launch Sunday, the nine Playbook milestones, the prep work behind them and what happened on the day."
				actions={actions}
			/>
			<PreparationNotice plan={plan} />
			<div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)] items-stretch gap-5 max-app-md:grid-cols-1">
				<Countdown plan={plan} admin={viewer.admin} onSet={() => open("set")} />
				<Readiness plan={plan} />
			</div>
			{plan.outcome ? after : null}
			{plan.milestones.length ? (
				<Milestones
					plan={plan}
					viewer={viewer}
					keys={keys}
					onMilestone={replaceMilestone}
					onTask={(milestoneId, task) =>
						setPlan((p) => ({
							...p,
							milestones: p.milestones.map((m) =>
								m.id === milestoneId ? { ...m, tasks: m.tasks.map((t) => (t.id === task.id ? task : t)) } : m,
							),
						}))
					}
				/>
			) : null}
			{plan.outcome ? null : after}
			{viewer.admin ? <LaunchHistory today={plan.today} /> : null}
			{draft ? (
				<DateDialog draft={draft} saving={saving} plan={plan} onChange={setDraft} onSubmit={submitDate} />
			) : null}
		</>
	);
}

/**
 * Launch readiness (WP-047b, NIR-03): within 30 days of Launch Sunday with a required role unfilled or required training
 * not done. A sending church or network that this church shares findings and Ministry teams with sees the same concern.
 */
function PreparationNotice({ plan }: { plan: Plan }) {
	const p = plan.preparation;
	const gap = gapText(p);
	if (nearLaunch(p) !== "gap" || !gap || p.daysToLaunch === null) return null;
	return (
		<Card variant="callout" tone="amber" className="mb-5" data-concern="launch_readiness">
			<CalloutLabel tone="amber" icon={StartUp02Icon}>
				Launch readiness
			</CalloutLabel>
			<CalloutText className="text-md">
				{daysText(p.daysToLaunch)}, with {gap}. A sending church or network you share Plant Intelligence findings and
				Ministry teams with sees this too.{" "}
				<Link href="/ministries" className="cursor-pointer font-medium text-ink underline underline-offset-[3px]">
					Open Ministry teams
				</Link>
			</CalloutText>
		</Card>
	);
}

/** Launch Sunday and the countdown in church-local days (LCH-008). */
function Countdown({ plan, admin, onSet }: { plan: Plan; admin: boolean; onSet: () => void }) {
	const c = countdown(plan.launch, plan.today);
	const date = plan.launch?.targetDate ?? null;
	const body = (() => {
		switch (c.kind) {
			case "none":
				return {
					metric: null,
					title: "No launch date yet",
					text: admin
						? "Set Launch Sunday to start the countdown and the nine readiness milestones."
						: "An Owner or Admin sets Launch Sunday. The countdown and milestones start then.",
				};
			case "postponed":
				return {
					metric: null,
					title: "Postponed",
					text: admin
						? "No date is set right now. Set a new date when you are ready, and readiness picks up where it was."
						: "No date is set right now. An Owner or Admin sets the new date.",
				};
			case "today":
				return {
					metric: "Today",
					unit: null,
					title: "Launch Sunday is today",
					text: "Every milestone you have done is ready.",
				};
			case "overdue":
				return {
					metric: String(c.days),
					unit: c.days === 1 ? "day overdue" : "days overdue",
					title: "Launch Sunday has passed, not launched",
					text: admin
						? "No launch has been recorded for this date. If it was held, record it below; if not, move the date or postpone it."
						: "No launch has been recorded for this date.",
				};
			case "ahead":
				return {
					metric: String(c.days),
					unit: c.days === 1 ? "day to go" : "days to go",
					title: c.window ? "Inside the four-week launch window" : "Before the launch window",
					text: c.window
						? "These are the weeks the Playbook's final readiness milestones are for."
						: "The final four weeks start on " + longDate(addDays(date!, -28)) + ".",
				};
			case "completed":
				return {
					metric: null,
					title: "Launched",
					text: plan.outcome
						? `Held ${longDate(plan.outcome.actualDate)}${date && date !== plan.outcome.actualDate ? `, planned for ${longDate(date)}` : ""}.`
						: "Launch Sunday is recorded.",
				};
		}
	})();
	return (
		<InsightCard tone={c.kind === "overdue" ? "rose" : "field"} aria-labelledby="launch-sunday">
			<InsightTop>
				<InsightPill icon={StartUp02Icon}>Launch Sunday</InsightPill>
				{date ? <InsightCount>{longDate(date)}</InsightCount> : null}
			</InsightTop>
			{body.metric ? <InsightMetric value={body.metric} unit={body.unit ?? undefined} /> : null}
			<InsightTitle id="launch-sunday" className={body.metric ? undefined : "mt-[26px]"}>
				{body.title}
			</InsightTitle>
			<InsightText>{body.text}</InsightText>
			{admin && (c.kind === "none" || c.kind === "postponed") ? (
				<InsightFooter>
					<Button variant="light" onClick={onSet}>
						Set Launch Sunday
						<Icon icon={ArrowRight01Icon} size={16} />
					</Button>
				</InsightFooter>
			) : null}
		</InsightCard>
	);
}
const addDays = (date: string, days: number) => {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};

/** Milestones people marked complete, and the prep tasks done, from the live tasks. */
function Readiness({ plan }: { plan: Plan }) {
	const done = plan.milestones.filter((m) => m.completion && !m.needsReview).length;
	const tasks = plan.milestones.reduce(
		(sum, m) => {
			const p = progressOf(m);
			return { done: sum.done + p.done, total: sum.total + p.total };
		},
		{ done: 0, total: 0 },
	);
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Readiness</CardTitle>
					<CardDescription>Milestones you mark complete. Tasks feed them but never close them for you.</CardDescription>
				</CardHeading>
			</CardHeader>
			{plan.milestones.length ? (
				<div className="flex flex-wrap items-start gap-x-8 gap-y-5">
					<Stat
						label="Milestones"
						value={`${done} of ${plan.milestones.length}`}
						part={done / plan.milestones.length}
					/>
					<Stat
						label="Prep tasks done"
						value={`${tasks.done} of ${tasks.total}`}
						part={tasks.total ? tasks.done / tasks.total : 0}
						blue
					/>
					<ul className="flex min-w-[220px] flex-1 flex-col gap-3 border-l border-line pl-6 max-app-sm:border-l-0 max-app-sm:pl-0">
						{AREAS.map((a) => {
							const ms = plan.milestones.filter((m) => m.area === a);
							const n = ms.filter((m) => m.completion && !m.needsReview).length;
							return (
								<li key={a}>
									<div className="flex justify-between text-sm">
										<span className="text-text-2">{AREA_LABEL[a]}</span>
										<b className="font-semibold text-ink">
											{n} of {ms.length}
										</b>
									</div>
									<Bar part={ms.length ? n / ms.length : 0} />
								</li>
							);
						})}
					</ul>
				</div>
			) : (
				<p className="text-sm text-text-2">
					The nine Playbook milestones and their 23 prep tasks appear here once Launch Sunday has a date.
				</p>
			)}
		</Card>
	);
}
function Stat({ label, value, part, blue }: { label: string; value: string; part: number; blue?: boolean }) {
	return (
		<div className="flex min-w-[140px] flex-col gap-2">
			<span className="text-sm text-text-3">{label}</span>
			<span className="num text-[28px] leading-none text-ink">{value}</span>
			<Bar part={part} blue={blue} />
		</div>
	);
}
function Bar({ part, blue }: { part: number; blue?: boolean }) {
	return (
		<span aria-hidden="true" className="mt-2 block h-2 overflow-hidden rounded-pill bg-surface-2">
			<span
				className={cn("block h-full rounded-pill", blue ? "bg-blue-500" : "bg-green-500")}
				style={{ width: `${Math.round(part * 100)}%` }}
			/>
		</span>
	);
}

type Keys = ReturnType<typeof requestKeys>;
/** The nine milestones in Playbook order, grouped by area. */
function Milestones({
	plan,
	viewer,
	keys,
	onMilestone,
	onTask,
}: {
	plan: Plan;
	viewer: Viewer;
	keys: Keys;
	onMilestone: (m: Milestone) => void;
	onTask: (milestoneId: string, task: PrepTask) => void;
}) {
	const [expanded, setExpanded] = useState<string | null>(null);
	return (
		<Card className="mt-5">
			<CardHeader>
				<CardHeading>
					<CardTitle>Milestones</CardTitle>
					<CardDescription>
						From the Launch Playbook · {plan.milestones.length} milestones,{" "}
						{plan.milestones.reduce((n, m) => n + m.tasks.length, 0)} prep tasks
					</CardDescription>
				</CardHeading>
			</CardHeader>
			{AREAS.map((a) => {
				const ms = plan.milestones.filter((m) => m.area === a);
				if (!ms.length) return null;
				return (
					<section key={a} aria-labelledby={`area-${a}`}>
						<h3
							id={`area-${a}`}
							className="flex items-center gap-2.5 px-1 pt-4 pb-2 text-sm font-semibold text-text-2 first:pt-0"
						>
							{AREA_LABEL[a]}
							<span aria-hidden="true" className="h-px flex-1 bg-line" />
						</h3>
						<ul className="flex flex-col">
							{ms.map((m) => (
								<MilestoneRow
									key={m.id}
									m={m}
									plan={plan}
									viewer={viewer}
									keys={keys}
									open={expanded === m.id}
									onOpen={() => setExpanded(expanded === m.id ? null : m.id)}
									onMilestone={onMilestone}
									onTask={(t) => onTask(m.id, t)}
								/>
							))}
						</ul>
					</section>
				);
			})}
		</Card>
	);
}

function StateMark({ m }: { m: Milestone }) {
	const p = progressOf(m);
	if (m.needsReview)
		return (
			<span className="grid size-6 flex-none place-items-center rounded-full bg-amber-100 text-amber-600">
				<Icon icon={Alert02Icon} size={16} />
			</span>
		);
	if (m.completion)
		return (
			<span className="grid size-6 flex-none place-items-center rounded-full bg-green-100 text-green-700">
				<Icon icon={Tick02Icon} size={16} />
			</span>
		);
	const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
	return (
		<span
			aria-hidden="true"
			className="grid size-6 flex-none place-items-center rounded-full shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]"
			style={
				pct
					? { background: `conic-gradient(var(--ef-blue-500) ${pct}%, var(--ef-surface-2) 0)`, boxShadow: "none" }
					: undefined
			}
		>
			{pct ? <span className="size-4 rounded-full bg-surface" /> : null}
		</span>
	);
}

function MilestoneRow({
	m,
	plan,
	viewer,
	keys,
	open,
	onOpen,
	onMilestone,
	onTask,
}: {
	m: Milestone;
	plan: Plan;
	viewer: Viewer;
	keys: Keys;
	open: boolean;
	onOpen: () => void;
	onMilestone: (m: Milestone) => void;
	onTask: (t: PrepTask) => void;
}) {
	const toast = useToast();
	const panel = useId();
	const [busy, setBusy] = useState(false);
	const [stale, setStale] = useState(false);
	const p = progressOf(m);
	const openTasks = m.tasks.filter((t) => isOpen(t.status)).length;
	const meta = m.needsReview
		? `Needs review · a task reopened after it was completed${m.completion ? ` ${instantDate(m.completion.at, plan.timeZone)}` : ""}`
		: m.completion
			? `Completed ${instantDate(m.completion.at, plan.timeZone)}${m.completion.by ? ` by ${m.completion.by.displayName}` : ""}`
			: m.practices
				? `${m.practices.held} of ${PRACTICES_REQUIRED} pre-launch services held`
				: "Not complete";

	async function complete() {
		const intent = ["complete", m.id, m.revision, reviewedOf(m.tasks)] as const;
		setBusy(true);
		const r = await sent(() => completeMilestone(keys.keyFor(intent), m.revision, m.id, reviewedOf(m.tasks)));
		setBusy(false);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") {
			setStale(false);
			return onMilestone(r.value.milestone);
		}
		if (r.status === "refused" && r.error.code === "stale_review") {
			// Someone changed these tasks: show them as they are now; nothing saved until the Owner confirms again.
			setStale(true);
			return onMilestone(r.error.details.milestone);
		}
		toast({ message: refusalMessage(r), tone: "error" });
	}
	async function reopen() {
		const intent = ["reopen", m.id, m.revision] as const;
		setBusy(true);
		const r = await sent(() => reopenMilestone(keys.keyFor(intent), m.revision, m.id));
		setBusy(false);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") return onMilestone(r.value.milestone);
		toast({ message: refusalMessage(r), tone: "error" });
	}

	return (
		<li
			className={cn(
				"rounded-card",
				open
					? "my-1.5 bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line)]"
					: "border-t border-line first:border-t-0",
			)}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panel}
				onClick={onOpen}
				className="grid w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto_20px] items-center gap-3.5 rounded-card px-3 py-3.5 text-left max-app-sm:grid-cols-[24px_minmax(0,1fr)_20px]"
			>
				<StateMark m={m} />
				<span className="min-w-0">
					<span className="block font-medium text-ink">{m.title}</span>
					<span className={cn("mt-0.5 block text-sm", m.needsReview ? "text-amber-600" : "text-text-3")}>{meta}</span>
					<span className="mt-0.5 hidden text-sm text-text-3 max-app-sm:block">{tasksText(p)}</span>
				</span>
				<span className="text-sm text-text-2 max-app-sm:hidden">{tasksText(p)}</span>
				<Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={16} className="text-text-3" />
			</button>
			{open ? (
				<div id={panel} className="px-3 pb-4">
					<p className="ml-[38px] text-sm text-text-2 max-app-sm:ml-0">{m.description}</p>
					{m.practices ? (
						<p className="mt-2 ml-[38px] text-sm text-ink max-app-sm:ml-0">
							<b className="font-semibold">
								{m.practices.held} of {PRACTICES_REQUIRED}
							</b>{" "}
							pre-launch practices held, counted from Meetings. Ticking the tasks below does not count a service.
						</p>
					) : null}
					{m.tasks.length ? (
						<ul className="mt-3 ml-[38px] flex flex-col border-l-[1.5px] border-line-2 pl-3.5 max-app-sm:ml-0">
							{m.tasks.map((t) => (
								<TaskRow key={t.id} task={t} today={plan.today} viewer={viewer} onTask={onTask} />
							))}
						</ul>
					) : (
						<p className="mt-3 ml-[38px] text-sm text-text-3 max-app-sm:ml-0">This milestone has no prep tasks left.</p>
					)}
					{stale ? (
						<p
							role="alert"
							className="mt-3 ml-[38px] rounded-md bg-amber-100 px-3.5 py-2.5 text-sm text-ink max-app-sm:ml-0"
						>
							These tasks changed since you opened the page. Nothing was saved. Review them and complete the milestone
							again.
						</p>
					) : null}
					{m.completion && m.needsReview ? (
						<p className="mt-3 ml-[38px] text-sm text-text-2 max-app-sm:ml-0">
							Earlier completion: {instantDate(m.completion.at, plan.timeZone)}
							{m.completion.by ? ` by ${m.completion.by.displayName}` : ""}.
						</p>
					) : null}
					{viewer.admin ? (
						<div className="mt-3 ml-[38px] flex flex-wrap items-center gap-3 max-app-sm:ml-0">
							{!m.completion || m.needsReview ? (
								<>
									{openTasks ? (
										<span className="text-sm text-text-2">
											{openTasks === 1 ? "One task is" : `${openTasks} tasks are`} still open. You can complete the
											milestone anyway; the tasks stay open.
										</span>
									) : null}
									<Button variant="secondary" size="sm" disabled={busy} onClick={complete}>
										{m.needsReview ? "Confirm complete" : "Complete milestone"}
									</Button>
								</>
							) : null}
							{m.completion ? (
								<Button variant="ghost" size="sm" disabled={busy} onClick={reopen}>
									Reopen milestone
								</Button>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</li>
	);
}

/** One prep task. Its owner or an Owner or Admin completes and reopens it through Tasks, with Tasks' own rules. */
function TaskRow({
	task,
	today,
	viewer,
	onTask,
}: {
	task: PrepTask;
	today: string;
	viewer: Viewer;
	onTask: (t: PrepTask) => void;
}) {
	const toast = useToast();
	const [saving, setSaving] = useState(false);
	const mine = task.assignees.some((a) => a.accountId === viewer.accountId);
	async function toggle() {
		const before = task;
		const next = isOpen(task.status) ? "complete" : "not_started";
		setSaving(true);
		onTask({ ...task, status: next });
		let r;
		try {
			r = await changeTaskStatus(crypto.randomUUID(), task.revision, task.id, {
				kind: next === "complete" ? "complete" : "reopen",
			});
		} catch {
			r = { status: "lost" as const };
		}
		setSaving(false);
		if (r.status === "ok") return onTask({ ...task, status: r.value.task.status, revision: r.value.task.revision });
		onTask(before);
		toast({
			message:
				r.status === "lost"
					? "Everyfield's answer did not come back. Check the task in Tasks before trying again."
					: "That task could not change. Reload the page to see it now.",
			tone: "error",
		});
	}
	const who = task.assignees.map((a) => a.displayName || "Unnamed member").join(", ");
	return (
		<li className="flex items-center gap-3 py-2.5">
			<DoneBox task={task} canAct={viewer.admin || mine} wait={saving ? "saving" : null} onToggle={toggle} />
			<div className="min-w-0 flex-1">
				<Link
					href={`/tasks?task=${encodeURIComponent(task.id)}`}
					className={cn(
						"cursor-pointer text-ink hover:underline",
						task.status === "complete" && "text-text-3 line-through",
					)}
				>
					{task.title}
				</Link>
				{who || task.dueDate ? (
					<p className="text-xs text-text-3">
						{[task.dueDate ? `Due ${shortDate(task.dueDate, today)}` : null, who || null].filter(Boolean).join(" · ")}
					</p>
				) : null}
			</div>
		</li>
	);
}

function DateDialog({
	draft,
	saving,
	plan,
	onChange,
	onSubmit,
}: {
	draft: DateDraft;
	saving: boolean;
	plan: Plan;
	onChange: (d: DateDraft | null) => void;
	onSubmit: (d: DateDraft) => void;
}) {
	const copy = {
		set: {
			title: "Set Launch Sunday",
			description: "The countdown counts church-local days to this date. You can move it later.",
			submit: "Set date",
		},
		move: {
			title: "Move Launch Sunday",
			description: "Task due dates, assignees and the church's phase stay as they are.",
			submit: "Move date",
		},
		postpone: {
			title: "Postpone Launch Sunday",
			description: `Clears the date${plan.launch?.targetDate ? ` of ${longDate(plan.launch.targetDate)}` : ""}. Readiness and tasks stay as they are.`,
			submit: "Postpone",
		},
	}[draft.mode];
	return (
		<Dialog open onOpenChange={(next) => (next ? null : onChange(null))}>
			<DialogContent size="sm">
				<DialogHeader title={copy.title} description={copy.description} />
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit(draft);
					}}
				>
					<DialogBody className="flex flex-col gap-4">
						{draft.mode !== "postpone" ? (
							<Field label="Launch Sunday">
								<Input
									type="date"
									required
									value={draft.date}
									onChange={(e) => onChange({ ...draft, date: e.target.value, error: null })}
								/>
							</Field>
						) : null}
						<Field
							label={draft.mode === "set" ? "Note (optional)" : "Reason"}
							hint="Up to 2,000 characters. It stays in the Launch history."
							error={draft.error}
						>
							<Textarea
								rows={3}
								value={draft.reason}
								onChange={(e) => onChange({ ...draft, reason: e.target.value, error: null })}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onChange(null)}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={saving}>
							{saving ? "Saving" : copy.submit}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
