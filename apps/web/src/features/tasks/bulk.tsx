"use client";

import { Calendar03Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Checkbox,
	Field,
	IconButton,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Select,
} from "@everyfield/ui/controls";
import { useRef, useState, type FormEvent } from "react";
import { bulkOutcomeText, type BulkOutcome, type DueInput } from "./model.ts";

// Bulk changes (REQ-TSK-008): the bar over a selection and the report of what each selected task did.

const onInk = "text-on-ink hover:bg-on-ink-soft focus-visible:outline-on-ink";

/**
 * The bar for the selected tasks: select every task on the page, complete them, give them one due date, or clear the
 * selection. Owner and Admin only.
 */
export function BulkBar({
	count,
	all,
	onAll,
	onClear,
	onComplete,
	onReschedule,
}: {
	count: number;
	/** Whether every task on this page is selected. */
	all: boolean;
	onAll: () => void;
	onClear: () => void;
	onComplete: () => void;
	onReschedule: (due: DueInput) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div
			role="toolbar"
			aria-label="Selected tasks"
			className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-card bg-ink py-2 pr-2 pl-3 text-on-ink shadow-pop max-app-sm:bottom-2"
		>
			<label className="-my-1 grid size-11 flex-none cursor-pointer place-items-center">
				<Checkbox
					aria-label="Select every task on this page"
					checked={all ? true : "indeterminate"}
					onCheckedChange={onAll}
					className="bg-on-ink-soft shadow-[inset_0_0_0_1.5px_var(--ef-on-ink)] data-[state=checked]:bg-on-ink-soft data-[state=indeterminate]:bg-on-ink-soft"
				/>
			</label>
			<span className="grow font-medium" aria-live="polite">
				{count} selected
			</span>
			{/* On a phone the actions take their own row, so the labels never wrap. */}
			<div className="flex gap-2 max-app-sm:order-last max-app-sm:grid max-app-sm:basis-full max-app-sm:grid-cols-2">
				<Button variant="ghost" size="sm" icon={Tick02Icon} className={onInk} onClick={onComplete}>
					Complete
				</Button>
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="sm" icon={Calendar03Icon} className={onInk}>
							Reschedule
						</Button>
					</PopoverTrigger>
					<PopoverContent label="Reschedule the selected tasks" align="end" side="top" className="w-[300px] p-4">
						<RescheduleForm
							count={count}
							onSubmit={(due) => {
								setOpen(false);
								onReschedule(due);
							}}
						/>
					</PopoverContent>
				</Popover>
			</div>
			<IconButton
				icon={Cancel01Icon}
				label="Clear the selection"
				size="sm"
				className={`shadow-none ${onInk}`}
				onClick={onClear}
			/>
		</div>
	);
}

function RescheduleForm({ count, onSubmit }: { count: number; onSubmit: (due: DueInput) => void }) {
	const [kind, setKind] = useState<"local_date" | "undated">("local_date");
	const [date, setDate] = useState("");
	const [touched, setTouched] = useState(false);
	const day = useRef<HTMLInputElement>(null);
	const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setTouched(true);
		if (kind === "undated") return onSubmit({ kind: "undated" });
		// A refused submit moves focus to the day that needs an answer.
		if (!valid) return day.current?.focus();
		onSubmit({ kind: "local_date", date: date as never });
	};
	return (
		<form onSubmit={submit} noValidate className="flex flex-col gap-3">
			<Field label="New due date">
				<Select
					value={kind}
					onValueChange={(v) => setKind(v === "undated" ? "undated" : "local_date")}
					options={[
						{ value: "local_date", label: "Due on a day" },
						{ value: "undated", label: "No due date" },
					]}
				/>
			</Field>
			{kind === "local_date" ? (
				<Field label="Day" error={touched && !valid ? "Pick a day." : null}>
					<Input ref={day} type="date" value={date} autoFocus onChange={(e) => setDate(e.target.value)} />
				</Field>
			) : null}
			<p className="text-xs text-text-3">
				Closed tasks keep their due dates. To set a time of day, edit one task at a time.
			</p>
			<Button variant="primary" size="sm" type="submit">
				Reschedule {count} {count === 1 ? "task" : "tasks"}
			</Button>
		</form>
	);
}

export type Report = {
	kind: "complete" | "reschedule";
	changed: number;
	/** The selected tasks that did not change, with why. */
	unchanged: { id: string; title: string; outcome: BulkOutcome }[];
	/** How many of those are still open and still selected. */
	remaining: number;
};

/** What a bulk change did: how many changed and, for each task that did not, why. Nothing is hidden behind a total. */
export function BulkReport({
	report,
	onOpen,
	onClose,
}: {
	report: Report;
	onOpen: (id: string) => void;
	onClose: () => void;
}) {
	const verb = report.kind === "complete" ? "Completed" : "Rescheduled";
	const total = report.changed + report.unchanged.length;
	return (
		<div role="status" className="mx-1.5 mb-2 flex flex-col gap-2 rounded-md bg-surface px-4 py-3">
			<div className="flex items-start gap-2">
				<p className="grow pt-1.5 font-medium text-ink">
					{verb} {report.changed} of {total} {total === 1 ? "task" : "tasks"}.
					{report.remaining
						? ` ${report.remaining === 1 ? "The open one that did not change is" : `The ${report.remaining} open ones that did not change are`} still selected.`
						: ""}
				</p>
				<IconButton icon={Cancel01Icon} label="Close this report" size="sm" className="shadow-none" onClick={onClose} />
			</div>
			<ul className="flex flex-col">
				{report.unchanged.map((t) => (
					<li key={t.id} className="border-t border-line py-2 text-sm first:border-t-0">
						<button
							type="button"
							onClick={() => onOpen(t.id)}
							className="cursor-pointer rounded-xs text-left font-medium text-ink underline-offset-[3px] hover:underline"
						>
							{t.title}
						</button>
						<span className="text-text-2"> · {bulkOutcomeText(t.outcome, report.kind)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
