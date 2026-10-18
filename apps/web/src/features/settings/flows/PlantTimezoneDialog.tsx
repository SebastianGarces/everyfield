"use client";

import { Clock01Icon } from "@hugeicons/core-free-icons";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { useState } from "react";
import type { PlantTimezonePreview, SectionResult } from "../port";
import { useWrite } from "../save";
import { SaveError } from "../SettingsDialog";
import { useSettings } from "../store";
import { formatInstant, formatLocalDate, zoneLabel } from "../time";
import { ZonePicker } from "./ZonePicker";

type PlantSection = Extract<SectionResult, { section: "plant" }>;

const WARNING_TEXT: Record<PlantTimezonePreview["warnings"][number], string> = {
	dst_fold_earlier: "A time falls on a clock change that happens twice. The earlier one is used.",
	dst_gap_shifted: "A time falls in the hour a clock change skips. It moves forward by the skipped time.",
	more_results: "There are more changes than shown here. Saving changes all of them the same way.",
};

/**
 * Changing the church time zone (REQ-IDN-011, REQ-TSK-018): choose a zone, see what moves, then save. Saving needs an
 * unexpired preview of that exact zone; a stale preview asks for a new one. Past times, one-time appointments and
 * due dates keep their values. The parent gives each opening a new key, so every opening starts clean.
 */
export function PlantTimezoneDialog({
	open,
	onOpenChange,
	section,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	section: PlantSection;
	onSaved: (section: SectionResult) => void;
}) {
	const { port } = useSettings();
	const oldZone = section.values.timeZone;
	const [zone, setZone] = useState<string | null>(null);
	const [preview, setPreview] = useState<PlantTimezonePreview | null>(null);
	const previewing = useWrite("plant-timezone-preview");
	const saving = useWrite("plant-timezone");

	const choose = (next: string) => {
		setZone(next);
		setPreview(null);
		saving.setRefusal(null);
	};

	const runPreview = async () => {
		if (!zone) return;
		saving.setRefusal(null);
		const result = await previewing.run({ zone, at: Date.now() }, () =>
			port.previewPlantTimezone({ plant: section.plant, timeZone: zone }),
		);
		if (result.ok) setPreview(result.value);
	};

	const save = async () => {
		if (!preview) return;
		const input = { plant: section.plant, timeZone: preview.newZone, previewId: preview.previewId };
		const result = await saving.run(input, (requestKey) =>
			port.setPlantTimezone({ requestKey, expectedRevision: preview.expectedRevision, input }),
		);
		if (!result.ok) return;
		const saved = result.value;
		onSaved({ ...section, revision: saved.revision, values: { ...section.values, timeZone: saved.timeZone } });
		onOpenChange(false);
	};

	const stale = saving.refusal?.code === "stale_preview" || saving.refusal?.code === "conflict";
	const sameZone = zone === oldZone;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md">
				<DialogHeader
					icon={Clock01Icon}
					tone="blue"
					title="Change time zone"
					description={`Now ${zoneLabel(oldZone)}. See what moves before you save.`}
				/>
				<DialogBody className="flex flex-col gap-5 pb-2">
					<ZonePicker
						label="New time zone"
						value={zone}
						onChange={choose}
						error={sameZone ? "This is already your church's time zone." : undefined}
					/>
					{preview ? <PreviewList preview={preview} oldZone={oldZone} /> : null}
					{previewing.refusal ? (
						<SaveError message={previewing.refusal.message} reference={previewing.refusal.reference} />
					) : null}
					{saving.refusal ? (
						<SaveError
							message={saving.refusal.message}
							reference={saving.refusal.reference}
							action={
								stale ? (
									<Button size="sm" variant="secondary" onClick={runPreview} loading={previewing.pending}>
										Preview again
									</Button>
								) : undefined
							}
						/>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					{preview && !stale ? (
						<Button variant="primary" onClick={save} loading={saving.pending}>
							Change to {zoneLabel(preview.newZone).split(" · ")[0]} time
						</Button>
					) : (
						<Button variant="primary" onClick={runPreview} loading={previewing.pending} disabled={!zone || sameZone}>
							Preview changes
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function PreviewList({ preview, oldZone }: { preview: PlantTimezonePreview; oldZone: string }) {
	const groups = [
		{ title: "Meetings", rows: preview.meetings },
		{ title: "Digests", rows: preview.digests },
		{ title: "Reminders", rows: preview.reminders },
	];
	const total = groups.reduce((n, g) => n + g.rows.length, 0);
	return (
		<section aria-label="What changes" className="flex flex-col gap-4 rounded-md bg-surface px-5 py-4">
			<p className="text-ink">
				{total === 0
					? "No future meetings, digests or reminders move."
					: `${total} future ${total === 1 ? "time keeps" : "times keep"} the same clock time in the new zone.`}{" "}
				<span className="text-text-2">Past times and one-time appointments do not change.</span>
			</p>
			{groups
				.filter((g) => g.rows.length > 0)
				.map((g) => (
					<div key={g.title}>
						<h3 className="text-sm font-medium text-ink-2">
							{g.title} <span className="text-text-3">· {g.rows.length}</span>
						</h3>
						<ul className="mt-1.5 flex flex-col gap-1 text-sm text-text-2">
							{g.rows.slice(0, 5).map((row) => (
								<li key={row.id} className="num">
									{formatInstant(row.before, oldZone)} <span aria-hidden="true">→</span>
									<span className="sr-only">becomes</span> {formatInstant(row.after, preview.newZone)}
								</li>
							))}
							{g.rows.length > 5 ? <li className="text-text-3">and {g.rows.length - 5} more</li> : null}
						</ul>
					</div>
				))}
			{preview.preservedTaskDates.length > 0 ? (
				<p className="text-sm text-text-2">
					Due dates stay on the same day:{" "}
					{preview.preservedTaskDates
						.slice(0, 6)
						.map((t) => formatLocalDate(t.date))
						.join(", ")}
					{preview.preservedTaskDates.length > 6 ? ` and ${preview.preservedTaskDates.length - 6} more` : ""}.
				</p>
			) : null}
			{preview.completeness === "bounded" || preview.warnings.length > 0 ? (
				<ul className="flex flex-col gap-1.5 text-sm text-amber-600">
					{preview.completeness === "bounded" && !preview.warnings.includes("more_results") ? (
						<li>{WARNING_TEXT.more_results}</li>
					) : null}
					{preview.warnings.map((w) => (
						<li key={w}>{WARNING_TEXT[w]}</li>
					))}
				</ul>
			) : null}
			<p className="text-xs text-text-3">
				This preview is valid until {formatInstant(preview.expiresAt, preview.newZone)}.
			</p>
		</section>
	);
}
