"use client";

import { defaultTitle, timeText } from "@everyfield/contracts/common";

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
import { useState } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { editMeeting, listMinistries, listVenues, scheduleMeeting } from "./actions.ts";
import { offsetText } from "../shared/dates.ts";
import { problemText, TYPE_LABEL, TYPES, type Detail, type MeetingType, type Outcome, type Venue } from "./model.ts";
import {
	DialogNotice,
	focusFirstProblem,
	NoticeInDialog,
	SaveButton,
	type SaveIntent,
} from "../../components/save/parts.tsx";
import { Problem } from "./parts.tsx";

type Choice = { instant: string; offsetSeconds: number };
type Fold = { choices: Choice[]; offset: number | null };
type Ministry = { id: string; name: string };
type Draft = {
	type: MeetingType;
	teamId: string;
	title: string;
	date: string;
	time: string;
	place: string;
	placeName: string;
	placeAddress: string;
	notes: string;
};
type Kept = { draft: Draft; fold: Fold | null };
const blank = (v: string) => (v.trim() === "" ? null : v.trim());

const savedPlaces = createRead(() => listVenues({ limit: 100 }).then((r) => (r.status === "ok" ? r.value.items : [])), {
	failed: (): Venue[] => [],
});
const teamMinistries = createRead(() => listMinistries().then((r) => (r.status === "ok" ? r.value : [])), {
	failed: (): Ministry[] => [],
});

function initial(meeting: Detail | undefined, ministry: Ministry | undefined): Draft {
	return {
		type: meeting?.type ?? (ministry ? "team_meeting" : "vision_meeting"),
		teamId: ministry?.id ?? "",
		title: meeting?.title ?? "",
		date: meeting?.localDate ?? "",
		time: meeting?.localTime ?? "18:30",
		place: meeting ? (meeting.venue ? "keep" : "none") : "none",
		placeName: "",
		placeAddress: "",
		notes: meeting?.notes ?? "",
	};
}

export function PlanMeetingDialog<E extends { problem?: string }>({
	open,
	onOpenChange,
	lane,
	meeting,
	onSaved,
	onPreview,
	onStale,
	ministry,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	lane: SaveIntent<E>;
	meeting?: Detail;
	ministry?: Ministry;
	onSaved?: (meeting: Detail) => void;
	onPreview?: (meeting: Detail | null) => void;
	onStale?: () => Promise<unknown>;
}) {
	const [kept, setKept] = useState<Kept | null>(null);
	const close = () => {
		setKept(null);
		onOpenChange(false);
	};
	return (
		<NoticeInDialog {...lane.noticeProps}>
			<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
				{open ? (
					<Form
						lane={lane}
						meeting={meeting}
						kept={kept}
						onClose={close}
						onReopen={() => onOpenChange(true)}
						onKeep={(next) => {
							setKept(next);
							onOpenChange(true);
						}}
						onSaved={onSaved}
						onPreview={onPreview}
						onStale={onStale}
						ministry={ministry}
					/>
				) : null}
			</Dialog>
		</NoticeInDialog>
	);
}

function Form<E extends { problem?: string }>({
	lane,
	meeting,
	kept,
	onClose,
	onReopen,
	onKeep,
	onSaved,
	onPreview,
	onStale,
	ministry,
}: {
	lane: SaveIntent<E>;
	meeting?: Detail;
	kept: Kept | null;
	onClose: () => void;
	onReopen: () => void;
	onKeep: (kept: Kept) => void;
	onSaved?: (meeting: Detail) => void;
	onPreview?: (meeting: Detail | null) => void;
	onStale?: () => Promise<unknown>;
	ministry?: Ministry;
}) {
	const editing = meeting !== undefined;
	const [draft, setDraft] = useState(() => kept?.draft ?? initial(meeting, ministry));
	const [touched, setTouched] = useState(kept !== null);
	const [fold, setFold] = useState<Fold | null>(kept?.fold ?? null);
	const [problem, setProblem] = useState<string | null>(null);
	const venues = useRead(savedPlaces).value;
	const ministries = useRead(editing ? null : teamMinistries).value;
	const choices = fold?.choices ?? null;
	const offset = fold?.offset ?? null;
	const pending = lane.saving;
	const set = (patch: Partial<Draft>) => {
		setDraft((d) => ({ ...d, ...patch }));
		if ("date" in patch || "time" in patch) setFold(null);
	};

	const team = !editing && draft.type === "team_meeting";

	const missing = {
		teamId: team && draft.teamId === "",
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
		setProblem(null);
		if (lane.wait) return;
		if (Object.values(missing).some(Boolean)) return focusFirstProblem(event.currentTarget as HTMLFormElement);
		if (choices && offset === null) return setProblem("ambiguous_local_time");
		if (editing) {
			const moved = draft.date !== meeting.localDate || draft.time !== meeting.localTime;
			const patch = {
				...(blank(draft.title) !== meeting.title ? { title: blank(draft.title) } : {}),
				...(blank(draft.notes) !== meeting.notes ? { notes: blank(draft.notes) } : {}),
				...(moved || offset !== null ? when : {}),
				...(venue ? { venue } : {}),
			};
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
			let answered: Choice[] | undefined;
			await lane.save({
				what: "The meeting",
				send: (key) =>
					editMeeting(key, meeting.revision, meeting.id, patch).then((r) => {
						if (r.status === "refused" && r.choices) answered = r.choices;
						return r;
					}),
				ok: (value: { meeting: Detail }) => {
					onPreview?.(null);
					onSaved?.(value.meeting);
				},
				refused: (code) => {
					onPreview?.(null);
					if (code === "conflict" && onStale) return void onStale().then(onReopen);
					onKeep({ draft, fold: answered ? { choices: answered, offset } : fold });
				},
			});
			return;
		}
		const input = {
			type: draft.type,
			...(team ? { teamId: draft.teamId } : {}),
			title: blank(draft.title),
			notes: blank(draft.notes),
			...when,
			venue: venue ?? { kind: "none" },
		};
		await lane.save({
			what: "The meeting",
			done: "planned",
			send: (key) => scheduleMeeting(key, input).then((r) => (r ? keepChoices(r) : new Promise<never>(() => {}))),
			ok: () => {},
		});
	}
	function keepChoices<T extends Outcome<unknown>>(r: T): T {
		const answered = r.status === "refused" ? r.choices : undefined;
		if (answered) setFold((f) => ({ choices: answered, offset: f?.offset ?? null }));
		return r;
	}

	const placeOptions = [
		...(meeting?.venue ? [{ value: "keep", label: `Keep ${meeting.venue.name}` }] : []),
		{ value: "none", label: "No place yet" },
		...(venues ?? [])
			.filter((v) => v.active && v.id !== meeting?.venue?.id)
			.map((v) => ({ value: v.id, label: v.name })),
		{ value: "new", label: "Add a new place" },
	];

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
								options={TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
							/>
						</Field>
					)}
					{team ? (
						<Field
							label="Ministry"
							hint={
								ministries === undefined
									? "Loading ministries…"
									: ministries.length === 0
										? "Add a ministry in Ministries first."
										: "Everyone serving in it now joins the guest list."
							}
							error={touched && missing.teamId ? "Choose a ministry." : null}
						>
							<Select
								value={draft.teamId}
								disabled={pending}
								placeholder="Choose a ministry"
								onValueChange={(teamId) => set({ teamId })}
								options={ministryOptions(ministries, ministry)}
							/>
						</Field>
					) : null}
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
									setFold((f) => f && { ...f, offset: Number(v) });
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
					<Field label="Place" hint={venues === undefined ? "Loading saved places…" : undefined}>
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
					<DialogNotice />
					<Problem text={problem ? problemText(problem) : undefined} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<SaveButton wait={lane.wait} saving={pending}>
						{editing ? "Save changes" : "Plan meeting"}
					</SaveButton>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

function ministryOptions(list: Ministry[] | undefined, preset: Ministry | undefined) {
	const all = list ?? (preset ? [preset] : []);
	return all.map((m) => ({ value: m.id, label: m.name }));
}
