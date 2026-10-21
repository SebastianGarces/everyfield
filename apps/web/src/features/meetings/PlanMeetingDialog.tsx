"use client";

import { CalendarAdd01Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Radio,
	RadioGroup,
	Select,
	Textarea,
} from "@everyfield/ui/controls";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { editMeeting, listVenues, scheduleMeeting } from "./actions.ts";
import {
	defaultTitle,
	NEW_TYPES,
	offsetText,
	timeText,
	TYPE_LABEL,
	type Detail,
	type MeetingType,
	type Venue,
} from "./model.ts";
import { Problem, useSave } from "./parts.tsx";

type Choice = { instant: string; offsetSeconds: number };
type Draft = {
	type: MeetingType;
	title: string;
	date: string;
	time: string;
	/** "keep" (edit: the copied place stays), "none", "new" or a saved place's ID. */
	place: string;
	placeName: string;
	placeAddress: string;
	notes: string;
};
const blank = (v: string) => (v.trim() === "" ? null : v.trim());

function initial(meeting: Detail | undefined): Draft {
	return {
		type: meeting?.type ?? "vision_meeting",
		title: meeting?.title ?? "",
		date: meeting?.localDate ?? "",
		time: meeting?.localTime ?? "18:30",
		place: meeting ? (meeting.venue ? "keep" : "none") : "none",
		placeName: "",
		placeAddress: "",
		notes: meeting?.notes ?? "",
	};
}

/**
 * Plan a meeting, or edit one (REQ-MTG-002, REQ-MTG-003). The place is copied into the meeting when it is saved, so a
 * later change to the saved place does not rewrite this meeting. A new place is created in the same save. A time that
 * happens twice when the clocks fall back asks which one; a time that does not exist is refused with a reason.
 */
export function PlanMeetingDialog({
	open,
	onOpenChange,
	meeting,
	onSaved,
	onPreview,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The meeting to edit. Without it the dialog plans a new one. */
	meeting?: Detail;
	onSaved?: (meeting: Detail) => void;
	/** Edit only: the meeting as it will look, shown while the save runs; null when the answer arrives. */
	onPreview?: (meeting: Detail | null) => void;
}) {
	// The form stays mounted while the dialog is closed, so an edit that fails after the dialog closed reopens with
	// the person's input and the reason.
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<Form
				open={open}
				meeting={meeting}
				onClose={() => onOpenChange(false)}
				onReopen={() => onOpenChange(true)}
				onSaved={onSaved}
				onPreview={onPreview}
			/>
		</Dialog>
	);
}

function Form({
	open,
	meeting,
	onClose,
	onReopen,
	onSaved,
	onPreview,
}: {
	open: boolean;
	meeting?: Detail;
	onClose: () => void;
	onReopen: () => void;
	onSaved?: (meeting: Detail) => void;
	onPreview?: (meeting: Detail | null) => void;
}) {
	const router = useRouter();
	const editing = meeting !== undefined;
	const [draft, setDraft] = useState(() => initial(meeting));
	const [touched, setTouched] = useState(false);
	const [choices, setChoices] = useState<Choice[] | null>(null);
	const [offset, setOffset] = useState<number | null>(null);
	const [venues, setVenues] = useState<Venue[] | null>(null);
	const { save, pending, problem, setProblem } = useSave();
	// Each opening starts from the meeting as it is now, unless it reopens after a failed save.
	const [wasOpen, setWasOpen] = useState(open);
	const [keep, setKeep] = useState(false);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open && keep) setKeep(false);
		else if (open) {
			setDraft(initial(meeting));
			setTouched(false);
			setChoices(null);
			setOffset(null);
			setProblem(null);
		}
	}
	const set = (patch: Partial<Draft>) => {
		setDraft((d) => ({ ...d, ...patch }));
		// A new date or time is a new question: an earlier fold choice no longer applies.
		if ("date" in patch || "time" in patch) {
			setChoices(null);
			setOffset(null);
		}
	};

	// Saved places load the first time the dialog opens, not with the page, and once only.
	const [asked, setAsked] = useState(false);
	if (open && !asked) setAsked(true);
	useEffect(() => {
		if (!asked) return;
		let live = true;
		listVenues({ limit: 100 }).then(
			(r) => live && setVenues(r.status === "ok" ? r.value.items : []),
			() => live && setVenues([]),
		);
		return () => {
			live = false;
		};
	}, [asked]);

	const missing = {
		date: draft.date === "",
		time: draft.time === "",
		placeName: draft.place === "new" && draft.placeName.trim() === "",
		placeAddress: draft.place === "new" && draft.placeAddress.trim() === "",
	};
	const venue =
		draft.place === "none"
			? { kind: "none" as const }
			: draft.place === "new"
				? { kind: "new" as const, venue: { name: draft.placeName.trim(), address: draft.placeAddress.trim() } }
				: draft.place === "keep"
					? undefined
					: { kind: "existing" as const, venueId: draft.place };
	const when = { date: draft.date, time: draft.time, ...(offset !== null ? { offsetSeconds: offset } : {}) };

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (Object.values(missing).some(Boolean)) return;
		if (choices && offset === null) return setProblem("ambiguous_local_time");
		if (editing) {
			const moved = draft.date !== meeting.localDate || draft.time !== meeting.localTime;
			const patch = {
				...(blank(draft.title) !== meeting.title ? { title: blank(draft.title) } : {}),
				...(blank(draft.notes) !== meeting.notes ? { notes: blank(draft.notes) } : {}),
				...(moved || offset !== null ? when : {}),
				...(venue ? { venue } : {}),
			};
			// The page shows the change at once; the answer confirms it, or the page goes back and the dialog reopens.
			const chosen = venues?.find((v) => v.id === draft.place);
			onPreview?.({
				...meeting,
				title: blank(draft.title),
				displayTitle: blank(draft.title) ?? defaultTitle(meeting),
				notes: blank(draft.notes),
				localDate: draft.date as Detail["localDate"],
				localTime: draft.time,
				venue:
					draft.place === "keep"
						? meeting.venue
						: draft.place === "none"
							? null
							: draft.place === "new"
								? { id: null, name: draft.placeName.trim(), address: draft.placeAddress.trim() }
								: chosen
									? { id: chosen.id, name: chosen.name, address: chosen.address }
									: meeting.venue,
			});
			onClose();
			const result = await save(patch, (key) => editMeeting(key, meeting.revision, meeting.id, patch));
			onPreview?.(null);
			if (!result) return;
			if (result.status === "ok") return onSaved?.(result.value.meeting);
			if (result.status === "refused" && result.choices) setChoices(result.choices);
			setKeep(true);
			onReopen();
			return;
		}
		const input = {
			type: draft.type,
			title: blank(draft.title),
			notes: blank(draft.notes),
			...when,
			venue: venue ?? { kind: "none" },
		};
		const result = await save(input, (key) => scheduleMeeting(key, input));
		if (!result) return;
		if (result.status === "refused" && result.choices) {
			setChoices(result.choices);
			return;
		}
		if (result.status === "ok") router.push(`/meetings/${result.value.meeting.id}`);
	}

	const placeOptions = [
		...(meeting?.venue ? [{ value: "keep", label: `Keep ${meeting.venue.name}` }] : []),
		{ value: "none", label: "No place yet" },
		...(venues ?? [])
			.filter((v) => v.active && v.id !== meeting?.venue?.id)
			.map((v) => ({ value: v.id, label: v.name })),
		{ value: "new", label: "Add a new place" },
	];

	if (!open) return null;
	return (
		<DialogContent aria-busy={pending || undefined} onInteractOutside={(e) => pending && e.preventDefault()}>
			<form onSubmit={submit} noValidate className="contents">
				<DialogHeader
					icon={editing ? Edit02Icon : CalendarAdd01Icon}
					tone="green"
					title={editing ? "Edit meeting" : "Plan a meeting"}
					description={
						editing ? "Changes apply to this meeting only." : "Guests with a seat get reminders 7, 3 and 1 day before."
					}
				/>
				<DialogBody className="flex flex-col gap-4">
					{editing ? null : (
						<Field label="Kind of meeting">
							<Select
								value={draft.type}
								disabled={pending}
								onValueChange={(type) => set({ type: type as MeetingType })}
								options={NEW_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
							/>
						</Field>
					)}
					<Field
						label="Title"
						optional
						hint={
							(editing ? meeting.type : draft.type) === "vision_meeting"
								? "Leave it empty to use the Vision meeting number."
								: "Leave it empty to use the kind of meeting."
						}
					>
						<Input
							value={draft.title}
							maxLength={200}
							readOnly={pending}
							autoComplete="off"
							onChange={(e) => set({ title: e.target.value })}
						/>
					</Field>
					<div className="grid grid-cols-2 gap-4">
						<Field label="Date" error={touched && missing.date ? "Choose a date." : null}>
							<Input
								type="date"
								value={draft.date}
								readOnly={pending}
								onChange={(e) => set({ date: e.target.value })}
							/>
						</Field>
						<Field
							label="Start time"
							hint="In the church's time zone."
							error={touched && missing.time ? "Choose a start time." : null}
						>
							<Input
								type="time"
								value={draft.time}
								readOnly={pending}
								onChange={(e) => set({ time: e.target.value })}
							/>
						</Field>
					</div>
					{choices ? (
						<fieldset className="flex flex-col gap-1 rounded-md bg-amber-50 px-4 py-3">
							<legend className="sr-only">Which {timeText(draft.time)}?</legend>
							<p className="text-sm font-medium text-ink" aria-hidden="true">
								{timeText(draft.time)} happens twice that night, because the clocks fall back. Which one?
							</p>
							<RadioGroup
								aria-label={`Which ${timeText(draft.time)}`}
								value={offset === null ? "" : String(offset)}
								onValueChange={(v) => {
									setOffset(Number(v));
									setProblem(null);
								}}
							>
								{choices.map((c, i) => (
									<Radio
										key={c.offsetSeconds}
										value={String(c.offsetSeconds)}
										label={
											i === 0 ? "The first one, before the clocks change" : "The second one, after the clocks change"
										}
										description={offsetText(c.offsetSeconds)}
									/>
								))}
							</RadioGroup>
						</fieldset>
					) : null}
					<Field label="Place" hint={venues === null ? "Loading saved places…" : undefined}>
						<Select
							value={draft.place}
							disabled={pending}
							onValueChange={(place) => set({ place })}
							options={placeOptions}
						/>
					</Field>
					{draft.place === "new" ? (
						<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
							<Field
								label="Place name"
								error={touched && missing.placeName ? "Enter a name, such as Reyes home." : null}
							>
								<Input
									value={draft.placeName}
									maxLength={120}
									readOnly={pending}
									autoComplete="off"
									onChange={(e) => set({ placeName: e.target.value })}
								/>
							</Field>
							<Field label="Address" error={touched && missing.placeAddress ? "Enter the address." : null}>
								<Input
									value={draft.placeAddress}
									maxLength={500}
									readOnly={pending}
									autoComplete="off"
									onChange={(e) => set({ placeAddress: e.target.value })}
								/>
							</Field>
						</div>
					) : null}
					<Field label="Notes" optional>
						<Textarea
							value={draft.notes}
							maxLength={5000}
							rows={3}
							readOnly={pending}
							onChange={(e) => set({ notes: e.target.value })}
						/>
					</Field>
					<Problem code={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" loading={pending}>
						{editing ? "Save changes" : "Plan meeting"}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}
