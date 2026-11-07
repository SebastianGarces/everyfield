"use client";

import { Clock01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	Card,
	CardDescription,
	CardFooter,
	CardHeader,
	CardHeading,
	CardTitle,
} from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { previewPersonalTimezone, setPersonalTimezone } from "../settings/actions";
import { ZonePicker } from "../settings/flows/ZonePicker";
import type { PersonalTimezonePreview } from "../settings/port";
import { OFFLINE_REFERENCE, useWrite, type Refusal } from "../settings/save";
import { SaveError } from "../settings/SettingsDialog";
import { zoneLabel } from "../settings/time";
import { CheckInHeader } from "./Header.tsx";
import { mondayDate, weekStartIn } from "./model.ts";

/**
 * No personal time zone yet (REQ-IDN-033): the check-in week starts on the author's own Monday, so the zone comes first,
 * on this screen. It reuses Settings' preview and save, so the same server rules hold. The picker starts empty: nothing
 * is taken from the church, the device or UTC. The preview names the week the check-in opens on, which is the week that
 * holds now in the chosen zone (privateCare readWeeks), and the save waits for it. After the save the page reloads its
 * server data in place and shows this week's form. A retry of the same save reuses its request key, so a lost reply is
 * never saved twice.
 */
export function ZoneStep({ name }: { name: string }) {
	const router = useRouter();
	const [zone, setZone] = useState<string | null>(null);
	const [preview, setPreview] = useState<PersonalTimezonePreview | null>(null);
	const [opening, startOpening] = useTransition();
	const [saved, setSaved] = useState(false);
	const previewing = useWrite("personal-timezone-preview");
	const saving = useWrite("personal-timezone");

	const choose = async (next: string) => {
		setZone(next);
		setPreview(null);
		saving.setRefusal(null);
		const result = await previewing.run({ next, at: Date.now() }, () => previewPersonalTimezone({ timeZone: next }));
		if (result.ok) setPreview(result.value);
	};

	const save = async () => {
		if (!preview) return;
		const input = { timeZone: preview.newZone, previewId: preview.previewId, confirmed: true as const };
		const send = () =>
			saving.run(input, (requestKey) =>
				setPersonalTimezone({ requestKey, expectedRevision: preview.expectedRevision, input }),
			);
		// A lost reply may hide a saved zone. The same request key asks again, and the server answers from its record.
		let result = await send();
		if (!result.ok && result.refusal.reference === OFFLINE_REFERENCE) result = await send();
		if (!result.ok) return;
		setSaved(true);
		startOpening(() => router.refresh());
	};

	const stale = saving.refusal?.code === "stale_preview" || saving.refusal?.code === "conflict";
	const city = zone ? zoneLabel(zone).split(" · ")[0] : "";
	const week = preview ? mondayDate(weekStartIn(preview.asOf, preview.newZone)) : null;
	const busy = saving.pending || opening || saved;

	return (
		<>
			<CheckInHeader name={name} subtitle="A short check-in for you, not for the church." />
			<Card className="max-w-[720px]">
				<CardHeader>
					<span
						aria-hidden="true"
						className="grid size-11 flex-none place-items-center rounded-card bg-violet-100 text-violet-600"
					>
						<Icon icon={Clock01Icon} size={22} />
					</span>
					<CardHeading>
						<CardTitle>First, choose your time zone</CardTitle>
						<CardDescription>
							Your check-in week starts on Monday at midnight where you are. Everyfield does not guess it from your
							church or your device.
						</CardDescription>
					</CardHeading>
				</CardHeader>
				<div className="flex flex-col gap-4">
					<ZonePicker
						label="Your time zone"
						value={zone}
						onChange={(z) => void choose(z)}
						hint="Only you see things that use it. Your church's time zone does not change."
					/>
					{previewing.pending ? (
						<p role="status" className="text-sm text-text-3">
							Checking your week in {city}…
						</p>
					) : null}
					{preview && week && !stale ? (
						<p role="status" data-zone-preview className="rounded-md bg-surface-2 px-4 py-3 text-ink-2">
							Your check-in will open for the week of <b className="font-semibold text-ink">{week}</b>. Your weeks start
							on Monday at midnight in <b className="font-semibold text-ink">{zoneLabel(preview.newZone)}</b>. Nothing
							is saved until you confirm.
						</p>
					) : null}
					{previewing.refusal && zone ? (
						<SaveError
							message={notSaved(previewing.refusal, false)}
							reference={refOf(previewing.refusal)}
							action={
								<Button size="sm" variant="secondary" onClick={() => void choose(zone)}>
									Try again
								</Button>
							}
						/>
					) : null}
					{saving.refusal ? (
						<SaveError
							message={notSaved(saving.refusal, true)}
							reference={refOf(saving.refusal)}
							action={
								stale && zone ? (
									<Button size="sm" variant="secondary" onClick={() => void choose(zone)}>
										Check again
									</Button>
								) : (
									<Button size="sm" variant="secondary" onClick={() => void save()}>
										Try again
									</Button>
								)
							}
						/>
					) : null}
				</div>
				<CardFooter>
					<Button variant="primary" onClick={() => void save()} loading={busy} disabled={!preview || stale}>
						{preview ? `Use ${city} time` : "Use this time zone"}
					</Button>
					<Link href="/settings/account" className={buttonVariants({ variant: "ghost" })}>
						Open Settings instead
					</Link>
					<span role="status" className="text-sm text-text-3">
						{saved ? "Saved. Opening this week's check-in…" : null}
					</span>
				</CardFooter>
			</Card>
		</>
	);
}

/**
 * A refusal in plain words: the zone was not saved, and why. A lost save reply may hide a saved zone, so that case says
 * so; a retry reuses the request key and cannot save it twice.
 */
function notSaved(refusal: Refusal, sent: boolean) {
	if (refusal.reference !== OFFLINE_REFERENCE) return `Your time zone was not saved. ${refusal.message}`;
	return sent
		? "Everyfield could not be reached, so your time zone may not be saved. Try again; it will not be saved twice."
		: "Your time zone was not saved: Everyfield could not be reached. Check your connection and try again.";
}
const refOf = (refusal: Refusal) => (refusal.reference === OFFLINE_REFERENCE ? undefined : refusal.reference);
