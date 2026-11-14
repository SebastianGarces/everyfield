"use client";

import type { ProgramPlan, ProgramRhythm, ProgramVersion } from "@everyfield/contracts/organizations";
import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Button, Checkbox, Field, IconButton, Input, SearchInput, Select, Textarea } from "@everyfield/ui/controls";
import { useId, useState, type ReactNode } from "react";
import { findReadings } from "./actions";
import { RHYTHM } from "./model";

/** The plan as the editor holds it: numbers stay text while someone types. */
export type PlanDraft = {
	rhythm: ProgramRhythm;
	expectedMonths: string;
	stages: { key: string; label: string; min: string; max: string }[];
	milestones: { key: string; lineage: string; title: string; description: string; handsOn: boolean }[];
	readings: { revisionId: string; title: string; source: "global" | "organization" }[];
};

const key = () => crypto.randomUUID();

/** An editable copy of a version's plan. Milestones keep their lineage, so the next version knows them. */
export function draftFrom(
	v: Pick<ProgramVersion, "rhythm" | "expectedMonths" | "stages" | "milestones" | "readings">,
): PlanDraft {
	return {
		rhythm: v.rhythm,
		expectedMonths: String(v.expectedMonths),
		stages: v.stages.map((s) => ({ key: key(), label: s.label, min: String(s.minMonths), max: String(s.maxMonths) })),
		milestones: v.milestones.map((m) => ({
			key: key(),
			lineage: m.lineage,
			title: m.title,
			description: m.description ?? "",
			handsOn: m.handsOn,
		})),
		readings: v.readings.map((r) => ({ revisionId: r.revisionId, title: r.title, source: r.source })),
	};
}

const whole = (text: string) => (/^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : null);

/** The plan to send, or the first thing to fix, in words. */
export function planFrom(d: PlanDraft): { plan: ProgramPlan } | { problem: string } {
	const months = whole(d.expectedMonths);
	if (!months || months > 120) return { problem: "Enter the expected length in whole months, from 1 to 120." };
	const stages: ProgramPlan["stages"] = [];
	for (const [i, s] of d.stages.entries()) {
		const min = whole(s.min),
			max = whole(s.max);
		if (!s.label.trim()) return { problem: `Name stage ${i + 1}.` };
		if (min === null || max === null || max > 120) return { problem: `Enter whole months for “${s.label.trim()}”.` };
		if (max < min) return { problem: `“${s.label.trim()}” ends before it starts. Check its months.` };
		stages.push({ label: s.label.trim(), minMonths: min, maxMonths: max });
	}
	if (new Set(stages.map((s) => s.label.toLowerCase())).size !== stages.length)
		return { problem: "Two stages can’t have the same name." };
	const milestones: ProgramPlan["milestones"] = [];
	for (const [i, m] of d.milestones.entries()) {
		if (!m.title.trim()) return { problem: `Give milestone ${i + 1} a title.` };
		if (m.handsOn && !m.description.trim()) return { problem: `Describe the hands-on assignment “${m.title.trim()}”.` };
		milestones.push({
			lineage: m.lineage,
			title: m.title.trim(),
			description: m.description.trim() || null,
			handsOn: m.handsOn,
		});
	}
	return {
		plan: {
			rhythm: d.rhythm,
			expectedMonths: months,
			stages,
			milestones,
			readings: d.readings.map((r) => ({ revisionId: r.revisionId as never })),
		},
	};
}

function move<T>(list: T[], index: number, by: -1 | 1) {
	const next = [...list];
	const [item] = next.splice(index, 1);
	next.splice(index + by, 0, item!);
	return next;
}

/** Rhythm, expected length, stages with month ranges, milestones and the Wiki reading list (REQ-MUL-010). */
export function PlanEditor({ value, onChange }: { value: PlanDraft; onChange: (next: PlanDraft) => void }) {
	const set = (patch: Partial<PlanDraft>) => onChange({ ...value, ...patch });
	// Row keys are random per render pass, so ids that reach the HTML come from React instead.
	const base = useId();
	return (
		<div className="flex flex-col gap-6">
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<Field label="Meeting rhythm">
					<Select
						value={value.rhythm}
						onValueChange={(rhythm) => set({ rhythm: rhythm as ProgramRhythm })}
						options={Object.entries(RHYTHM).map(([v, label]) => ({ value: v, label }))}
					/>
				</Field>
				<Field label="Expected length" hint="In months, from start to finish.">
					<Input
						inputMode="numeric"
						value={value.expectedMonths}
						onChange={(e) => set({ expectedMonths: e.target.value })}
						trailing={<span className="text-sm text-text-3">months</span>}
					/>
				</Field>
			</div>

			<Section title="Stages" hint="In order. Each has a month range; enrollments move through them.">
				<ol className="flex flex-col gap-2" aria-label="Stages">
					{value.stages.map((s, i) => {
						const update = (patch: Partial<PlanDraft["stages"][number]>) =>
							set({ stages: value.stages.map((x) => (x.key === s.key ? { ...x, ...patch } : x)) });
						return (
							<li key={s.key} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 p-2.5">
								<Input
									aria-label={`Stage ${i + 1} name`}
									value={s.label}
									maxLength={80}
									onChange={(e) => update({ label: e.target.value })}
									boxClassName="min-w-[180px] flex-1"
								/>
								<span className="flex items-center gap-1.5 text-sm text-text-2">
									<span className="w-16 flex-none">
										<Input
											aria-label={`${s.label || `Stage ${i + 1}`}: fewest months`}
											inputMode="numeric"
											value={s.min}
											onChange={(e) => update({ min: e.target.value })}
										/>
									</span>
									to
									<span className="w-16 flex-none">
										<Input
											aria-label={`${s.label || `Stage ${i + 1}`}: most months`}
											inputMode="numeric"
											value={s.max}
											onChange={(e) => update({ max: e.target.value })}
										/>
									</span>
									months
								</span>
								<Order
									name={s.label || "stage"}
									index={i}
									count={value.stages.length}
									onMove={(by) => set({ stages: move(value.stages, i, by) })}
									onRemove={() => set({ stages: value.stages.filter((x) => x.key !== s.key) })}
								/>
							</li>
						);
					})}
				</ol>
				<Button
					variant="secondary"
					size="sm"
					icon={PlusSignIcon}
					className="self-start"
					onClick={() => set({ stages: [...value.stages, { key: key(), label: "", min: "1", max: "2" }] })}
				>
					Add stage
				</Button>
			</Section>

			<Section
				title="Milestones"
				hint="What each person finishes along the way. A hands-on assignment needs a description, and the director can give dated feedback on it."
			>
				<ol className="flex flex-col gap-2" aria-label="Milestones">
					{value.milestones.map((m, i) => {
						const update = (patch: Partial<PlanDraft["milestones"][number]>) =>
							set({ milestones: value.milestones.map((x) => (x.key === m.key ? { ...x, ...patch } : x)) });
						return (
							<li key={m.key} className="flex flex-col gap-2 rounded-md bg-surface-2 p-2.5">
								<div className="flex items-center gap-2">
									<Input
										aria-label={`Milestone ${i + 1} title`}
										value={m.title}
										maxLength={200}
										onChange={(e) => update({ title: e.target.value })}
										boxClassName="min-w-0 flex-1"
									/>
									<Order
										name={m.title || "milestone"}
										index={i}
										count={value.milestones.length}
										onMove={(by) => set({ milestones: move(value.milestones, i, by) })}
										onRemove={() => set({ milestones: value.milestones.filter((x) => x.key !== m.key) })}
									/>
								</div>
								<Textarea
									aria-label={`Milestone ${i + 1} description`}
									placeholder={m.handsOn ? "Describe the assignment" : "Description (optional)"}
									value={m.description}
									maxLength={2000}
									rows={2}
									onChange={(e) => update({ description: e.target.value })}
								/>
								<Checkbox
									id={`${base}-hands-on-${i}`}
									label="Hands-on assignment"
									checked={m.handsOn}
									onCheckedChange={(checked) => update({ handsOn: checked === true })}
								/>
							</li>
						);
					})}
				</ol>
				<Button
					variant="secondary"
					size="sm"
					icon={PlusSignIcon}
					className="self-start"
					onClick={() =>
						set({
							milestones: [
								...value.milestones,
								{ key: key(), lineage: crypto.randomUUID(), title: "", description: "", handsOn: false },
							],
						})
					}
				>
					Add milestone
				</Button>
			</Section>

			<Readings value={value.readings} onChange={(readings) => set({ readings })} />
		</div>
	);
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5">
			<div>
				<h3 className="font-body text-sm font-semibold tracking-normal text-ink">{title}</h3>
				<p className="text-sm text-text-2">{hint}</p>
			</div>
			{children}
		</section>
	);
}

function Order({
	name,
	index,
	count,
	onMove,
	onRemove,
}: {
	name: string;
	index: number;
	count: number;
	onMove: (by: -1 | 1) => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex flex-none items-center gap-1">
			<IconButton
				icon={ArrowUp01Icon}
				label={`Move ${name} up`}
				size="sm"
				disabled={index === 0}
				onClick={() => onMove(-1)}
			/>
			<IconButton
				icon={ArrowDown01Icon}
				label={`Move ${name} down`}
				size="sm"
				disabled={index === count - 1}
				onClick={() => onMove(1)}
			/>
			<IconButton icon={Delete02Icon} label={`Remove ${name}`} size="sm" onClick={onRemove} />
		</div>
	);
}

/** The reading list: search the Wiki the organization reads, add an article or its own version, remove one. */
function Readings({
	value,
	onChange,
}: {
	value: PlanDraft["readings"];
	onChange: (next: PlanDraft["readings"]) => void;
}) {
	const [q, setQ] = useState("");
	const [found, setFound] = useState<PlanDraft["readings"] | null>(null);
	const [searching, setSearching] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	async function search() {
		setSearching(true);
		setProblem(null);
		const answer = await findReadings(q.trim()).catch(() => ({ status: "lost" as const }));
		setSearching(false);
		if (answer.status === "ok") setFound(answer.value);
		else setProblem("We couldn’t search the Wiki. Try again.");
	}
	const chosen = new Set(value.map((r) => r.revisionId));
	return (
		<Section
			title="Reading list"
			hint="Wiki articles for everyone in the program. Your church’s own version is marked."
		>
			{value.length ? (
				<ol className="flex flex-col gap-1.5" aria-label="Reading list">
					{value.map((r, i) => (
						<li
							key={r.revisionId}
							className="flex items-center gap-2 rounded-md bg-surface-2 py-1.5 pr-1.5 pl-3 text-sm"
						>
							<span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-ink">
								{r.title}
								{r.source === "organization" ? <span className="text-text-3"> · Your version</span> : null}
							</span>
							<Order
								name={r.title}
								index={i}
								count={value.length}
								onMove={(by) => onChange(move(value, i, by))}
								onRemove={() => onChange(value.filter((x) => x.revisionId !== r.revisionId))}
							/>
						</li>
					))}
				</ol>
			) : (
				<p className="text-sm text-text-3">No readings yet.</p>
			)}
			{/* Not a form: the reading list sits inside the program's own form. Enter searches. */}
			<div role="search" className="flex gap-2">
				<SearchInput
					aria-label="Search Wiki articles"
					placeholder="Search Wiki articles by title"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						e.preventDefault();
						void search();
					}}
					boxClassName="min-w-0 flex-1"
				/>
				<Button variant="secondary" loading={searching} onClick={() => void search()}>
					Search
				</Button>
			</div>
			{problem ? <p className="text-sm text-magenta-600">{problem}</p> : null}
			{found ? (
				found.length ? (
					<ul className="flex flex-col gap-1" aria-label="Search results">
						{found.map((r) => (
							<li key={r.revisionId} className="flex items-center gap-2 text-sm">
								<span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-ink">
									{r.title}
									{r.source === "organization" ? <span className="text-text-3"> · Your version</span> : null}
								</span>
								<Button
									size="sm"
									variant="ghost"
									icon={PlusSignIcon}
									disabled={chosen.has(r.revisionId)}
									onClick={() => onChange([...value, r])}
								>
									{chosen.has(r.revisionId) ? "Added" : "Add"}
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-3">No articles match.</p>
				)
			) : null}
		</Section>
	);
}
