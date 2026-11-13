"use client";

import type { PipelineBoard } from "@everyfield/contracts/organizations";
import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	IconButton,
	Input,
	Select,
} from "@everyfield/ui/controls";
import { useState } from "react";
import { saveStages } from "./actions";
import { KIND_LABEL, plural, refusalText, stageChanges } from "./model";

type Stage = PipelineBoard["stages"][number];
type Row = { id: string; label: string; kind: string; revision: string | null; count: number };

/**
 * Owners and Admins rename, add, reorder and delete stages, then review exactly what will change before anything
 * saves. A stage that still has people cannot be deleted; the editor says so at the moment someone tries.
 */
export function StageEditor({
	open,
	onOpenChange,
	stages,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	stages: Stage[];
	onSaved: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md">{open ? <Editor stages={stages} onSaved={onSaved} /> : null}</DialogContent>
		</Dialog>
	);
}

function Editor({ stages, onSaved }: { stages: Stage[]; onSaved: () => void }) {
	const [rows, setRows] = useState<Row[]>(() =>
		stages.map((s) => ({ id: s.id, label: s.label, kind: s.kind, revision: s.revision, count: s.count })),
	);
	const [blocked, setBlocked] = useState<string | null>(null);
	const [step, setStep] = useState<"edit" | "review">("edit");
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const changes = stageChanges(stages, rows);
	const labels = rows.map((r) => r.label.trim().toLowerCase());
	const invalid = labels.some((l) => !l) || new Set(labels).size !== labels.length;

	const update = (id: string, patch: Partial<Row>) =>
		setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	const move = (index: number, by: -1 | 1) =>
		setRows((all) => {
			const next = [...all];
			const [row] = next.splice(index, 1);
			next.splice(index + by, 0, row!);
			return next;
		});
	const remove = (row: Row) => {
		if (row.count > 0) {
			setBlocked(row.id);
			return;
		}
		setBlocked(null);
		setRows((all) => all.filter((r) => r.id !== row.id));
	};

	async function save() {
		setSaving(true);
		setProblem(null);
		const kept = new Set(rows.map((r) => r.id));
		const answer = await saveStages({
			stages: rows.map((r) => ({ id: r.id, label: r.label.trim(), kind: r.kind, expectedRevision: r.revision })),
			removed: stages.filter((s) => !kept.has(s.id)).map((s) => ({ id: s.id, expectedRevision: s.revision })),
		}).catch(() => ({ status: "lost" as const }));
		setSaving(false);
		if (answer.status === "ok") onSaved();
		else setProblem(refusalText(answer));
	}

	if (step === "review")
		return (
			<>
				<DialogHeader title="Review stage changes" description="Nothing is saved until you save these changes." />
				<DialogBody className="flex flex-col gap-3">
					<ul className="flex flex-col gap-2" aria-label="Changes">
						{changes.map((c) => (
							<li key={c} className="rounded-md bg-surface-2 px-3 py-2.5 text-sm text-ink">
								{c}
							</li>
						))}
					</ul>
					<p className="text-sm text-text-2">History keeps each stage’s name as it was when someone moved.</p>
					<div aria-live="polite" className="empty:hidden">
						{problem ? (
							<p className="rounded-md bg-magenta-50 px-3 py-2.5 text-sm text-magenta-600">{problem}</p>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={() => setStep("edit")} disabled={saving}>
						Back to editing
					</Button>
					<Button variant="primary" onClick={save} loading={saving}>
						Save changes
					</Button>
				</DialogFooter>
			</>
		);

	return (
		<>
			<DialogHeader
				title="Edit stages"
				description="Rename, add, reorder or delete stages. Each stage counts as one fixed kind, so totals stay comparable."
			/>
			<DialogBody className="flex flex-col gap-2">
				<ol className="flex flex-col gap-2" aria-label="Stages">
					{rows.map((row, index) => {
						const isNew = !stages.some((s) => s.id === row.id);
						return (
							<li key={row.id} className="flex flex-col gap-1.5 rounded-md bg-surface-2 p-2.5">
								<div className="flex items-center gap-2">
									<Input
										aria-label={`Stage ${index + 1} name`}
										value={row.label}
										maxLength={80}
										onChange={(e) => update(row.id, { label: e.target.value })}
										boxClassName="min-w-0 flex-1"
									/>
									<div className="flex flex-none items-center gap-1">
										<IconButton
											icon={ArrowUp01Icon}
											label={`Move ${row.label || "stage"} up`}
											size="sm"
											disabled={index === 0}
											onClick={() => move(index, -1)}
										/>
										<IconButton
											icon={ArrowDown01Icon}
											label={`Move ${row.label || "stage"} down`}
											size="sm"
											disabled={index === rows.length - 1}
											onClick={() => move(index, 1)}
										/>
										<IconButton
											icon={Delete02Icon}
											label={`Delete ${row.label || "stage"}`}
											size="sm"
											disabled={rows.length === 1}
											onClick={() => remove(row)}
										/>
									</div>
								</div>
								{isNew ? (
									<label className="flex items-center gap-2 px-1 text-xs text-text-3">
										<span className="whitespace-nowrap">New stage, counts as</span>
										<span className="w-[200px] max-w-full min-w-0">
											<Select
												aria-label={`Stage ${index + 1} counts as`}
												value={row.kind}
												onValueChange={(kind) => update(row.id, { kind })}
												options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
											/>
										</span>
									</label>
								) : (
									<p className="px-1 text-xs text-text-3">
										{`Counts as ${KIND_LABEL[row.kind]} · ${plural(row.count, "person", "people")}`}
									</p>
								)}
								<div aria-live="polite" className="empty:hidden">
									{blocked === row.id ? (
										<p className="px-1 text-sm font-medium text-ink">
											{`“${row.label}” can’t be deleted while ${plural(row.count, "person is", "people are")} in it. Move them to another stage first.`}
										</p>
									) : null}
								</div>
							</li>
						);
					})}
				</ol>
				<Button
					variant="ghost"
					icon={PlusSignIcon}
					className="self-start"
					disabled={rows.length >= 30}
					onClick={() =>
						setRows((all) => [...all, { id: crypto.randomUUID(), label: "", kind: "other", revision: null, count: 0 }])
					}
				>
					Add a stage
				</Button>
			</DialogBody>
			<DialogFooter>
				<Button variant="primary" disabled={invalid || changes.length === 0} onClick={() => setStep("review")}>
					Review changes
				</Button>
			</DialogFooter>
		</>
	);
}
