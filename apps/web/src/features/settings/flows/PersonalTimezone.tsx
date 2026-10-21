"use client";

import { Clock01Icon } from "@hugeicons/core-free-icons";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useState } from "react";
import type { PersonalTimezonePreview, TimezonePreference } from "../port";
import { useWrite, type Outcome, type Refusal } from "../save";
import { SaveError } from "../SettingsDialog";
import { useFlows } from "../store";
import { formatInstant, formatLocalDate, nextMonday, zoneLabel } from "../time";
import { ZonePicker } from "./ZonePicker";

/**
 * Your own time zone (REQ-IDN-033), separate from the church's. Until you confirm one, it says so and asks; it never
 * takes the church, device or UTC zone for you. A change starts at the first Monday after now in the new zone. The
 * saved zone comes with Your account, so this row asks the server nothing until you choose a zone.
 *
 * Saving closes the dialog and shows the new zone at once. A refusal puts the saved zone back and says why, with a way
 * back into the dialog, which keeps the choice and its request key, so a retry after a lost reply is not saved twice.
 */
export function PersonalTimezone({
	preference,
	onSaved,
}: {
	preference: TimezonePreference;
	onSaved: (preference: TimezonePreference) => void;
}) {
	const [open, setOpen] = useState(false);
	const [session, setSession] = useState(0);
	const [pending, setPending] = useState<TimezonePreference | null>(null);
	const [failure, setFailure] = useState<Refusal | null>(null);
	const shown = pending ?? preference;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				{shown.status === "confirmed" ? (
					<span className="font-medium text-ink" data-personal-zone>
						{zoneLabel(shown.timeZone)}
					</span>
				) : (
					<StatusBadge status="attention" size="sm" data-personal-zone>
						Not chosen yet
					</StatusBadge>
				)}
				<Button
					size="sm"
					variant={shown.status === "confirmed" ? "secondary" : "primary"}
					onClick={() => {
						if (!failure) setSession((n) => n + 1);
						setFailure(null);
						setOpen(true);
					}}
				>
					{shown.status === "confirmed" ? "Change" : "Choose your time zone"}
				</Button>
				<span role="status" className="text-sm text-text-3">
					{pending ? "Saving…" : null}
				</span>
			</div>
			{failure ? (
				<SaveError
					message={`Your time zone was not saved. ${failure.message}`}
					reference={failure.reference}
					action={
						<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
							Try again
						</Button>
					}
				/>
			) : null}
			<PersonalTimezoneDialog
				key={session}
				open={open}
				onOpenChange={setOpen}
				current={preference}
				onSaving={(next) => {
					setFailure(null);
					setPending(next);
					setOpen(false);
				}}
				onSettled={(result) => {
					setPending(null);
					if (result.ok) onSaved(result.value);
					else setFailure(result.refusal);
				}}
			/>
		</div>
	);
}

function PersonalTimezoneDialog({
	open,
	onOpenChange,
	current,
	onSaving,
	onSettled,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: TimezonePreference;
	/** The zone being saved, shown in the row before the reply. */
	onSaving: (preference: TimezonePreference) => void;
	onSettled: (result: Outcome<TimezonePreference>) => void;
}) {
	const port = useFlows();
	const [zone, setZone] = useState<string | null>(null);
	const [preview, setPreview] = useState<PersonalTimezonePreview | null>(null);
	const previewing = useWrite("personal-timezone-preview");
	const saving = useWrite("personal-timezone");
	const currentZone = current.status === "confirmed" ? current.timeZone : null;

	const choose = async (next: string) => {
		setZone(next);
		setPreview(null);
		saving.setRefusal(null);
		if (next === currentZone) return;
		const result = await previewing.run({ next, at: Date.now() }, () =>
			port.previewPersonalTimezone({ timeZone: next }),
		);
		if (result.ok) setPreview(result.value);
	};

	const save = async () => {
		if (!preview) return;
		const input = { timeZone: preview.newZone, previewId: preview.previewId, confirmed: true as const };
		onSaving({ status: "confirmed", timeZone: preview.newZone, revision: preview.expectedRevision });
		const result = await saving.run(input, (requestKey) =>
			port.setPersonalTimezone({ requestKey, expectedRevision: preview.expectedRevision, input }),
		);
		onSettled(result.ok ? { ok: true, value: result.value.preference } : result);
	};

	const stale = saving.refusal?.code === "stale_preview" || saving.refusal?.code === "conflict";
	const city = preview ? zoneLabel(preview.newZone).split(" · ")[0] : "";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">
				<DialogHeader
					icon={Clock01Icon}
					tone="violet"
					title={currentZone ? "Change your time zone" : "Choose your time zone"}
					description="Only you see things that use it. Your church's time zone does not change."
				/>
				<DialogBody className="flex flex-col gap-4">
					<ZonePicker
						label="Your time zone"
						value={zone}
						onChange={(z) => void choose(z)}
						error={zone && zone === currentZone ? "This is already your time zone." : undefined}
					/>
					{previewing.pending ? (
						<p role="status" className="text-sm text-text-3">
							Checking when the change starts…
						</p>
					) : null}
					{preview && !stale ? (
						<p role="status" className="rounded-md bg-surface px-4 py-3 text-ink-2">
							Your week will start on Monday at midnight in {city}, from{" "}
							<b className="font-semibold text-ink">{formatLocalDate(nextMonday(preview.asOf, preview.newZone))}</b>.
							Weeks that already started stay as they are.
							<span className="mt-1 block text-xs text-text-3">
								Valid until {formatInstant(preview.expiresAt, preview.newZone)}.
							</span>
						</p>
					) : null}
					{previewing.refusal ? (
						<SaveError message={previewing.refusal.message} reference={previewing.refusal.reference} />
					) : null}
					{saving.refusal ? (
						<SaveError
							message={saving.refusal.message}
							reference={saving.refusal.reference}
							action={
								stale && zone ? (
									<Button size="sm" variant="secondary" onClick={() => void choose(zone)}>
										Check again
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
					<Button variant="primary" onClick={save} loading={saving.pending} disabled={!preview || stale}>
						{preview ? `Use ${city} time` : "Use this time zone"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
