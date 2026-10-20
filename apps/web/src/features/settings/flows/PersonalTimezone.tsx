"use client";

import { Clock01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Skeleton,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useEffect, useState } from "react";
import type { PersonalTimezonePreview, TimezonePreference } from "../port";
import { refusalOf, useWrite, type Refusal } from "../save";
import { SaveError } from "../SettingsDialog";
import { useFlows } from "../store";
import { formatInstant, formatLocalDate, nextMonday, zoneLabel } from "../time";
import { ZonePicker } from "./ZonePicker";

/**
 * Your own time zone (REQ-IDN-033), separate from the church's. Until you confirm one, it says so and asks; it never
 * takes the church, device or UTC zone for you. A change starts at the first Monday after now in the new zone.
 */
export function PersonalTimezone() {
	const port = useFlows();
	const [preference, setPreference] = useState<TimezonePreference | null>(null);
	const [loadError, setLoadError] = useState<Refusal | null>(null);
	const [open, setOpen] = useState(false);
	const [session, setSession] = useState(0);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let live = true;
		port.getPersonalTimezone().then((reply) => {
			if (!live) return;
			if (reply.status === "ok") setPreference(reply.value);
			else setLoadError(refusalOf(reply.error));
		});
		return () => {
			live = false;
		};
	}, [port, attempt]);

	if (loadError) {
		return (
			<SaveError
				message="Your time zone did not load."
				reference={loadError.reference}
				action={
					<Button
						size="sm"
						variant="secondary"
						onClick={() => {
							setLoadError(null);
							setAttempt((n) => n + 1);
						}}
					>
						Try again
					</Button>
				}
			/>
		);
	}
	if (!preference) return <Skeleton shape="block" height={36} width={240} aria-label="Loading your time zone" />;

	return (
		<div className="flex flex-wrap items-center gap-3">
			{preference.status === "confirmed" ? (
				<span className="font-medium text-ink" data-personal-zone>
					{zoneLabel(preference.timeZone)}
				</span>
			) : (
				<StatusBadge status="attention" size="sm" data-personal-zone>
					Not chosen yet
				</StatusBadge>
			)}
			<Button
				size="sm"
				variant={preference.status === "confirmed" ? "secondary" : "primary"}
				onClick={() => {
					setSession((n) => n + 1);
					setOpen(true);
				}}
			>
				{preference.status === "confirmed" ? "Change" : "Choose your time zone"}
			</Button>
			<PersonalTimezoneDialog
				key={session}
				open={open}
				onOpenChange={setOpen}
				current={preference}
				onSaved={(next) => setPreference(next)}
			/>
		</div>
	);
}

function PersonalTimezoneDialog({
	open,
	onOpenChange,
	current,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: TimezonePreference;
	onSaved: (preference: TimezonePreference) => void;
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
		const result = await saving.run(input, (requestKey) =>
			port.setPersonalTimezone({ requestKey, expectedRevision: preview.expectedRevision, input }),
		);
		if (!result.ok) return;
		onSaved(result.value.preference);
		onOpenChange(false);
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
