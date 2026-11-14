"use client";

import type { PipelineGoals } from "@everyfield/contracts/organizations";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardActions,
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
	Input,
	Textarea,
} from "@everyfield/ui/controls";
import { useState, type FormEvent } from "react";
import { readGoals, saveGoal } from "./actions";
import { formatDay, goalHeadline, KIND_LABEL, monthLabel, plural, refusalText } from "./model";
import { Problem } from "./Problem";

type Goal = PipelineGoals["goals"][number];

/** What "Plants sent" says until commissioning and plant lineage exist (ADR-001 stage 3). Never a zero. */
const PLANTS_UNAVAILABLE = "Everyfield will count plants sent once churches are commissioned through it.";

/**
 * The goals area on the Pipeline page (REQ-MUL-007, -009), for every seat: the organization's sending goals, its own
 * pipeline counted by stage kind as of today, and leadership conversations by month and quarter. Counts and dates
 * only: no rates, forecasts or verdicts (ADR-001). Owners and Admins add and edit goals.
 */
export function GoalsArea({ initial }: { initial: PipelineGoals }) {
	const [data, setData] = useState(initial);
	const [seen, setSeen] = useState(initial);
	if (seen !== initial) {
		setSeen(initial);
		setData(initial);
	}
	const [editing, setEditing] = useState<Goal | "new" | null>(null);

	async function saved() {
		setEditing(null);
		const answer = await readGoals().catch(() => null);
		if (answer?.status === "ok") setData(answer.value);
	}

	return (
		<section
			aria-label="Sending goals and leadership conversations"
			className="mb-6 grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-4 max-app-md:grid-cols-1"
		>
			<Card>
				<CardHeader>
					<CardHeading>
						<CardTitle size="sm">Sending goals</CardTitle>
						<CardDescription>What you’re aiming for, beside what your pipeline holds today.</CardDescription>
					</CardHeading>
					{data.canEdit && data.goals.length ? (
						<CardActions>
							<Button variant="secondary" size="sm" icon={PlusSignIcon} onClick={() => setEditing("new")}>
								Add goal
							</Button>
						</CardActions>
					) : null}
				</CardHeader>
				{data.goals.length ? (
					<ul className="flex flex-col divide-y divide-line">
						{data.goals.map((goal) => (
							<li key={goal.id} className="py-4 first:pt-0 last:pb-0">
								<GoalItem goal={goal} onEdit={data.canEdit ? () => setEditing(goal) : null} />
							</li>
						))}
					</ul>
				) : (
					<div className="flex flex-col items-start gap-3 rounded-md bg-surface-2 px-4 py-4">
						<p className="text-sm text-text-2">
							{data.canEdit
								? "No goals yet. Write down what you’re aiming for, such as developing 6 leaders to plant 2 churches by 2028."
								: "No goals yet. Owners and Admins add them."}
						</p>
						{data.canEdit ? (
							<Button variant="primary" size="sm" icon={PlusSignIcon} onClick={() => setEditing("new")}>
								Add goal
							</Button>
						) : null}
					</div>
				)}
			</Card>
			<div className="flex min-w-0 flex-col gap-4">
				<Today data={data} />
				<Conversations data={data} />
			</div>
			{data.canEdit ? (
				<GoalDialog
					open={editing !== null}
					onOpenChange={(open) => (open ? null : setEditing(null))}
					goal={editing === "new" ? null : editing}
					onSaved={saved}
				/>
			) : null}
		</section>
	);
}

function GoalItem({ goal, onEdit }: { goal: Goal; onEdit: (() => void) | null }) {
	return (
		<article className="flex flex-col gap-2">
			<div className="flex items-start gap-3">
				<h3 className="min-w-0 flex-1 font-body text-md leading-snug font-semibold text-pretty text-ink">
					{goalHeadline(goal)}
				</h3>
				{onEdit ? (
					<Button variant="ghost" size="sm" icon={Edit02Icon} onClick={onEdit}>
						Edit
					</Button>
				) : null}
			</div>
			<p className="text-sm whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere]">{goal.rationale}</p>
			<dl className="mt-1 grid grid-cols-3 gap-2 max-app-sm:grid-cols-1">
				<Figure term="Leaders to develop" value={String(goal.leaderTarget)} />
				<Figure term="Churches to plant" value={String(goal.plantTarget)} />
				<Figure term="By" value={String(goal.targetYear)} />
			</dl>
			<p className="text-sm text-text-2">
				<span className="font-medium text-ink">Plants sent: Not available yet.</span> {PLANTS_UNAVAILABLE}
			</p>
		</article>
	);
}

function Figure({ term, value }: { term: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 max-app-sm:py-1.5">
			<dt className="text-xs text-text-2">{term}</dt>
			<dd className="text-sm font-semibold text-ink tabular-nums">{value}</dd>
		</div>
	);
}

/** Live people of this organization counted once each by the fixed kind of their stage, as of today. */
function Today({ data }: { data: PipelineGoals }) {
	return (
		<Card>
			<CardHeader className="mb-3">
				<CardHeading>
					<CardTitle size="sm">Your pipeline today</CardTitle>
					<CardDescription>As of {formatDay(data.asOf)}</CardDescription>
				</CardHeading>
			</CardHeader>
			<dl className="flex flex-col text-sm">
				{data.kinds.map((k) => (
					<div key={k.kind} className="flex items-baseline justify-between gap-3 border-b border-line py-2">
						<dt className="text-text-2">{KIND_LABEL[k.kind]}</dt>
						<dd className="font-semibold text-ink tabular-nums">
							{k.count}
							<span className="sr-only"> {k.count === 1 ? "person" : "people"}</span>
						</dd>
					</div>
				))}
				<div className="flex flex-col gap-0.5 pt-2">
					<div className="flex items-baseline justify-between gap-3">
						<dt className="text-text-2">Plants sent</dt>
						<dd className="font-medium text-ink">Not available yet</dd>
					</div>
					<p className="text-xs text-text-3">{PLANTS_UNAVAILABLE}</p>
				</div>
			</dl>
		</Card>
	);
}

/** Leadership conversations by the month and the quarter they happened in, oldest first. A zero stays a zero. */
function Conversations({ data }: { data: PipelineGoals }) {
	const { months, quarters } = data.conversations;
	return (
		<Card>
			<CardHeader className="mb-3">
				<CardHeading>
					<CardTitle size="sm">Leadership conversations</CardTitle>
					<CardDescription>“I see in you” conversations staff logged, by the day they happened.</CardDescription>
				</CardHeading>
			</CardHeader>
			<Row label="By month" cells={months.map((m) => ({ key: m.month, label: monthLabel(m.month), count: m.count }))} />
			<Row
				label="By quarter"
				cells={quarters.map((q) => ({
					key: `${q.year}-${q.quarter}`,
					label: `Q${q.quarter} ${q.year}`,
					count: q.count,
				}))}
			/>
			<p className="mt-3 text-xs text-text-3">Log a conversation from the person’s record.</p>
		</Card>
	);
}

function Row({ label, cells }: { label: string; cells: { key: string; label: string; count: number }[] }) {
	return (
		<div className="mt-3 first:mt-0">
			<h3 className="mb-1.5 font-body text-xs font-medium text-text-2">{label}</h3>
			<ol
				className="grid gap-1.5"
				style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
				aria-label={`Conversations ${label.toLowerCase()}`}
			>
				{cells.map((c) => (
					<li key={c.key} className="flex flex-col items-center gap-0.5 rounded-md bg-surface-2 px-1 py-2">
						<span className="text-md leading-none font-semibold text-ink tabular-nums">{c.count}</span>
						<span className="text-center text-xs leading-tight text-text-3">{c.label}</span>
						<span className="sr-only">{plural(c.count, "conversation")}</span>
					</li>
				))}
			</ol>
		</div>
	);
}

function GoalDialog({
	open,
	onOpenChange,
	goal,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	goal: Goal | null;
	onSaved: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">{open ? <GoalForm goal={goal} onSaved={onSaved} /> : null}</DialogContent>
		</Dialog>
	);
}

type Errors = { leaders?: string; plants?: string; year?: string; reason?: string };

/** A whole number of 0 or more, or the message that says why not. */
function target(text: string): number | string {
	if (text.trim() === "") return "Enter a number, or 0.";
	const n = Number(text);
	if (!Number.isInteger(n)) return "Enter a whole number.";
	if (n < 0) return "Targets can’t be less than 0.";
	if (n > 10_000) return "Enter 10,000 or less.";
	return n;
}

/** A goal's targets, year and reason. Adding names the goal's ID once per dialog, so a resend adds one goal. */
function GoalForm({ goal, onSaved }: { goal: Goal | null; onSaved: () => void }) {
	const [goalId] = useState(() => goal?.id ?? crypto.randomUUID());
	const [leaders, setLeaders] = useState(goal ? String(goal.leaderTarget) : "");
	const [plants, setPlants] = useState(goal ? String(goal.plantTarget) : "");
	const [year, setYear] = useState(goal ? String(goal.targetYear) : "");
	const [reason, setReason] = useState(goal?.rationale ?? "");
	const [errors, setErrors] = useState<Errors>({});
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const leaderTarget = target(leaders);
	const plantTarget = target(plants);
	const targetYear = Number(year);
	const preview =
		typeof leaderTarget === "number" && typeof plantTarget === "number" && /^\d{4}$/.test(year)
			? goalHeadline({ leaderTarget, plantTarget, targetYear })
			: null;

	async function submit(event: FormEvent) {
		event.preventDefault();
		const next: Errors = {
			leaders: typeof leaderTarget === "string" ? leaderTarget : undefined,
			plants: typeof plantTarget === "string" ? plantTarget : undefined,
			year:
				Number.isInteger(targetYear) && targetYear >= 2000 && targetYear <= 2200
					? undefined
					: "Enter a year between 2000 and 2200.",
			reason: reason.trim() ? undefined : "Say briefly why this goal matters.",
		};
		setErrors(next);
		if (Object.values(next).some(Boolean)) return;
		setSaving(true);
		const answer = await saveGoal({
			goalId,
			expectedRevision: goal?.revision ?? null,
			leaderTarget,
			plantTarget,
			targetYear,
			rationale: reason.trim(),
		}).catch(() => ({ status: "lost" as const }));
		setSaving(false);
		if (answer.status !== "ok") return setProblem(refusalText(answer));
		onSaved();
	}

	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={goal ? "Edit goal" : "Add a sending goal"}
				description="Saving a goal moves no one and changes no stage."
			/>
			<DialogBody className="flex flex-col gap-4">
				<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
					<Field label="Leaders to develop" error={errors.leaders}>
						<Input
							type="number"
							inputMode="numeric"
							min={0}
							step={1}
							value={leaders}
							onChange={(e) => setLeaders(e.target.value)}
						/>
					</Field>
					<Field label="Churches to plant" error={errors.plants}>
						<Input
							type="number"
							inputMode="numeric"
							min={0}
							step={1}
							value={plants}
							onChange={(e) => setPlants(e.target.value)}
						/>
					</Field>
				</div>
				<Field label="By the year" error={errors.year}>
					<Input
						type="number"
						inputMode="numeric"
						min={2000}
						max={2200}
						value={year}
						onChange={(e) => setYear(e.target.value)}
					/>
				</Field>
				<Field label="Why this goal" error={errors.reason} hint="A sentence or two your staff will see with the goal.">
					<Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
				</Field>
				{preview ? (
					<p className="rounded-md bg-surface-2 px-3 py-2.5 text-sm text-ink" aria-live="polite">
						{preview}
					</p>
				) : null}
				<Problem text={problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					{goal ? "Save" : "Add goal"}
				</Button>
			</DialogFooter>
		</form>
	);
}
