"use client";

import { Alert, Button, ProblemText, Radio, RadioGroup } from "@everyfield/ui/controls";
import { useFocusRequest } from "@everyfield/ui/foundations";
import { useId } from "react";
import { type ConflictRow, type Pick } from "./conflict.ts";

const EMPTY = "Empty";

export function SaveConflict({
	what,
	rows,
	asked,
	focus,
	disabled = false,
	onPick,
	onKeepSaved,
}: {
	what: string;
	rows: readonly ConflictRow[];
	asked: boolean;
	focus: boolean;
	disabled?: boolean;
	onPick: (field: string, pick: Pick) => void;
	onKeepSaved: () => void;
}) {
	const box = useFocusRequest<HTMLElement>(focus ? 1 : 0);
	const label = useId();
	if (!rows.length) return null;
	return (
		<section ref={box} tabIndex={-1} data-conflict aria-labelledby={label} className="flex flex-col gap-3 outline-none">
			<Alert
				tone="warning"
				role="alert"
				actions={
					<Button size="sm" variant="secondary" type="button" disabled={disabled} onClick={onKeepSaved}>
						Keep the saved version
					</Button>
				}
			>
				<p id={label} className="font-semibold">
					Someone else saved {what} while you were editing.
				</p>
				<p>
					{`Changed: ${rows.map((row) => row.label.toLowerCase()).join(", ")}. Choose what to keep. Nothing you typed is lost, and nothing is saved until you save again.`}
				</p>
			</Alert>
			{rows.map((row) => (
				<ConflictChoice
					key={row.field}
					row={row}
					asked={asked}
					disabled={disabled}
					onPick={(pick) => onPick(row.field, pick)}
				/>
			))}
		</section>
	);
}

function ConflictChoice({
	row,
	asked,
	disabled,
	onPick,
}: {
	row: ConflictRow;
	asked: boolean;
	disabled: boolean;
	onPick: (pick: Pick) => void;
}) {
	const problem = useId();
	const missing = asked && row.pick === null;
	return (
		<div data-invalid={missing || undefined} className="rounded-md bg-surface px-4 pt-3 pb-1">
			<p className="text-sm font-medium text-ink" aria-hidden="true">
				{row.label}
			</p>
			<RadioGroup
				aria-label={`${row.label}: which version to keep`}
				aria-describedby={missing ? problem : undefined}
				value={row.pick ?? ""}
				disabled={disabled}
				onValueChange={(v) => onPick(v as Pick)}
			>
				<div className="grid grid-cols-2 gap-x-4 max-app-sm:grid-cols-1">
					<Radio value="saved" label="Saved version" description={<Shown text={row.saved} />} />
					<Radio value="mine" label="Your version" description={<Shown text={row.mine} />} />
				</div>
			</RadioGroup>
			{missing ? (
				<div className="pb-2">
					<ProblemText id={problem}>Choose a version.</ProblemText>
				</div>
			) : null}
		</div>
	);
}

function Shown({ text }: { text: string }) {
	return text.trim() === "" ? (
		<span className="italic">{EMPTY}</span>
	) : (
		<span className="block max-h-32 overflow-y-auto break-words whitespace-pre-line">{text}</span>
	);
}
