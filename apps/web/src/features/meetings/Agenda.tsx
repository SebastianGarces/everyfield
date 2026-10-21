"use client";

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete02Icon,
	Edit02Icon,
	Note01Icon,
} from "@hugeicons/core-free-icons";
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
	EmptyState,
	IconButton,
	Input,
} from "@everyfield/ui/controls";
import { useState } from "react";
import { replaceAgenda } from "./actions.ts";
import { addMinutes, durationText, timeText, type AgendaSection, type Detail } from "./model.ts";
import { Problem, useSave } from "./parts.tsx";

/** The agenda (REQ-MTG-005): sections with their start times from the meeting's start, and the total length. */
export function AgendaCard({
	meeting,
	canWrite,
	onSaved,
}: {
	meeting: Detail;
	canWrite: boolean;
	onSaved: (agenda: Detail["agenda"]) => void;
}) {
	const [editing, setEditing] = useState(false);
	const { sections, totalMinutes } = meeting.agenda;
	// Each section starts when the one before it ends, counted from the meeting's start.
	const starts = sections.reduce<string[]>(
		(all, s, i) => [...all, i === 0 ? meeting.localTime : addMinutes(all[i - 1]!, sections[i - 1]!.minutes)],
		[],
	);
	return (
		<Card as="section" aria-labelledby="agenda-title">
			<CardHeader>
				<CardHeading>
					<CardTitle id="agenda-title">Agenda</CardTitle>
					<CardDescription>{sections.length ? durationText(totalMinutes) : "No sections yet"}</CardDescription>
				</CardHeading>
				{canWrite ? (
					<CardActions>
						<IconButton icon={Edit02Icon} label="Edit agenda" size="sm" onClick={() => setEditing(true)} />
					</CardActions>
				) : null}
			</CardHeader>
			{sections.length === 0 ? (
				<EmptyState
					icon={Note01Icon}
					title="No agenda yet"
					headingLevel="h3"
					action={
						canWrite ? (
							<Button variant="secondary" size="sm" icon={Add01Icon} onClick={() => setEditing(true)}>
								Add sections
							</Button>
						) : null
					}
				>
					Plan the order and the time for each part.
				</EmptyState>
			) : (
				<ol className="flex flex-col gap-2.5">
					{sections.map((s, i) => {
						const start = starts[i]!;
						return (
							<li
								key={s.id}
								className="flex items-center gap-4 rounded-md bg-surface-raised px-4 py-3 shadow-[0_1px_2px_var(--ef-line)]"
							>
								<span className="w-[60px] flex-none text-sm text-text-3 tabular-nums">{timeText(start)}</span>
								<span className="min-w-0 flex-1">
									<span className="block font-medium text-ink">{s.title}</span>
									<span className="block text-sm text-text-3">{s.minutes} min</span>
								</span>
							</li>
						);
					})}
				</ol>
			)}
			<Dialog open={editing} onOpenChange={setEditing}>
				{editing ? (
					<AgendaForm
						meeting={meeting}
						onClose={() => setEditing(false)}
						onSaved={(agenda) => {
							onSaved(agenda);
							setEditing(false);
						}}
					/>
				) : null}
			</Dialog>
		</Card>
	);
}

type Row = { id: string; title: string; minutes: string };

/** Add, remove, reorder and retime sections. The whole agenda is saved at once; a problem names the row. */
function AgendaForm({
	meeting,
	onClose,
	onSaved,
}: {
	meeting: Detail;
	onClose: () => void;
	onSaved: (agenda: Detail["agenda"]) => void;
}) {
	const [rows, setRows] = useState<Row[]>(() =>
		meeting.agenda.sections.map((s) => ({ id: s.id, title: s.title, minutes: String(s.minutes) })),
	);
	const [touched, setTouched] = useState(false);
	const { save, pending, problem } = useSave();
	const errorOf = (r: Row) => {
		const m = Number(r.minutes);
		if (r.title.trim() === "") return "Enter a title.";
		if (r.minutes.trim() === "" || !Number.isInteger(m) || m < 0 || m > 600) return "Enter 0 to 600 minutes.";
		return null;
	};
	const total = rows.reduce((sum, r) => sum + (Number.isInteger(Number(r.minutes)) ? Number(r.minutes) : 0), 0);
	const update = (i: number, patch: Partial<Row>) =>
		setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	const move = (i: number, by: -1 | 1) =>
		setRows((all) => {
			const next = [...all];
			[next[i], next[i + by]] = [next[i + by]!, next[i]!];
			return next;
		});

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (rows.some(errorOf)) return;
		const sections: AgendaSection[] = rows.map((r) => ({
			id: r.id,
			title: r.title.trim(),
			minutes: Number(r.minutes),
		}));
		const r = await save(sections, (key) => replaceAgenda(key, meeting.revision, meeting.id, sections));
		if (r?.status === "ok") onSaved(r.value.agenda);
	}

	return (
		<DialogContent size="lg" aria-busy={pending || undefined}>
			<form onSubmit={submit} noValidate className="contents">
				<DialogHeader
					icon={Note01Icon}
					title="Edit agenda"
					description={`${rows.length} ${rows.length === 1 ? "section" : "sections"} · ${durationText(total)}`}
				/>
				<DialogBody className="flex flex-col gap-3">
					{rows.length === 0 ? <p className="text-md text-text-3">No sections. Add the first one.</p> : null}
					<ol className="flex flex-col gap-2.5">
						{rows.map((r, i) => {
							const error = touched ? errorOf(r) : null;
							return (
								<li key={r.id} className="flex flex-col gap-1">
									<div className="flex items-center gap-2">
										<span className="w-6 flex-none text-right text-sm text-text-3 tabular-nums">{i + 1}</span>
										<div className="min-w-0 flex-1">
											<Input
												aria-label={`Section ${i + 1} title`}
												value={r.title}
												maxLength={120}
												invalid={Boolean(error && r.title.trim() === "")}
												onChange={(e) => update(i, { title: e.target.value })}
												autoComplete="off"
											/>
										</div>
										<div className="w-[104px] flex-none">
											<Input
												aria-label={`Section ${i + 1} minutes`}
												inputMode="numeric"
												value={r.minutes}
												maxLength={3}
												invalid={Boolean(error && r.title.trim() !== "")}
												onChange={(e) => update(i, { minutes: e.target.value })}
												trailing={<span className="text-sm text-text-3">min</span>}
											/>
										</div>
										<IconButton
											icon={ArrowUp01Icon}
											label={`Move section ${i + 1} up`}
											size="sm"
											disabled={i === 0}
											onClick={() => move(i, -1)}
										/>
										<IconButton
											icon={ArrowDown01Icon}
											label={`Move section ${i + 1} down`}
											size="sm"
											disabled={i === rows.length - 1}
											onClick={() => move(i, 1)}
										/>
										<IconButton
											icon={Delete02Icon}
											label={`Remove section ${i + 1}`}
											size="sm"
											onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
										/>
									</div>
									{error ? <p className="pl-8 text-xs font-medium text-magenta-600">{error}</p> : null}
								</li>
							);
						})}
					</ol>
					<Button
						variant="ghost"
						size="sm"
						icon={Add01Icon}
						className="self-start"
						disabled={rows.length >= 40}
						onClick={() => setRows((all) => [...all, { id: crypto.randomUUID(), title: "", minutes: "10" }])}
					>
						Add section
					</Button>
					<Problem code={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={pending}>
						Save agenda
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}
