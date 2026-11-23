"use client";

import { ArrowDown01Icon, Calendar03Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { cn, Icon } from "../foundations";
import { Button } from "./Button";
import { Radio, RadioGroup } from "./Choice";
import { Field, Input } from "./Field";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./Popover";

export type DateRange = { start: string; end: string };
export type DatePreset = { key: string; label: string; range: DateRange };

const CUSTOM = "custom";
const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fmtYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function day(iso: string): Date {
	const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
	return new Date(y, m - 1, d);
}

export function formatRange({ start, end }: DateRange): string {
	const a = day(start);
	const b = day(end);
	const f = a.getFullYear() === b.getFullYear() ? fmt : fmtYear;
	return `${f.format(a)} to ${f.format(b)}`;
}

type DateRangePickerProps = {
	value: DateRange;
	onValueChange: (range: DateRange) => void;
	presets: DatePreset[];
	compareLabel?: string;
	className?: string;
};

export function DateRangePicker({ value, onValueChange, presets, compareLabel, className }: DateRangePickerProps) {
	const matching = presets.find((p) => p.range.start === value.start && p.range.end === value.end)?.key ?? CUSTOM;
	const [choice, setChoice] = useState(matching);
	const [draft, setDraft] = useState(value);
	const invalid = choice === CUSTOM && draft.start && draft.end && draft.end < draft.start;
	const incomplete = choice === CUSTOM && (!draft.start || !draft.end);

	return (
		<div className={cn("inline-flex h-[46px] max-w-full items-center gap-1 rounded-md bg-surface-2 p-1", className)}>
			<Popover
				onOpenChange={(open) => {
					if (open) {
						setChoice(matching);
						setDraft(value);
					}
				}}
			>
				<PopoverTrigger className="inline-flex h-[38px] items-center gap-2 rounded-md bg-surface-raised px-3 text-[15px] font-medium whitespace-nowrap text-ink shadow-raised">
					<Icon icon={Calendar03Icon} size={18} />
					<span>
						<span className="sr-only">Date range: </span>
						{formatRange(value)}
					</span>
					<Icon icon={ArrowDown01Icon} size={16} className="text-text-3" />
				</PopoverTrigger>
				<PopoverContent label="Choose a date range" className="w-[320px] p-4">
					<RadioGroup aria-label="Date range" value={choice} onValueChange={setChoice} className="gap-y-0">
						{presets.map((p) => (
							<Radio key={p.key} value={p.key} label={p.label} description={formatRange(p.range)} />
						))}
						<Radio value={CUSTOM} label="Custom range" />
					</RadioGroup>
					{choice === CUSTOM ? (
						<div className="mt-2 grid grid-cols-2 gap-3">
							<Field label="Start">
								<Input
									type="date"
									value={draft.start}
									max={draft.end || undefined}
									onChange={(e) => setDraft({ ...draft, start: e.target.value })}
								/>
							</Field>
							<Field label="End" error={invalid ? "End is before start." : undefined}>
								<Input
									type="date"
									value={draft.end}
									min={draft.start || undefined}
									onChange={(e) => setDraft({ ...draft, end: e.target.value })}
								/>
							</Field>
						</div>
					) : null}
					<div className="mt-4 flex justify-end gap-2">
						<PopoverClose asChild>
							<Button size="sm" variant="ghost">
								Cancel
							</Button>
						</PopoverClose>
						<PopoverClose asChild>
							<Button
								size="sm"
								variant="primary"
								disabled={Boolean(invalid || incomplete)}
								onClick={() =>
									onValueChange(choice === CUSTOM ? draft : (presets.find((p) => p.key === choice)?.range ?? value))
								}
							>
								Apply
							</Button>
						</PopoverClose>
					</div>
				</PopoverContent>
			</Popover>
			{compareLabel ? (
				<span className="min-w-0 truncate px-3 text-[15px] text-text-3 max-app-sm:px-2 max-app-sm:text-sm">
					{compareLabel}
				</span>
			) : null}
		</div>
	);
}
