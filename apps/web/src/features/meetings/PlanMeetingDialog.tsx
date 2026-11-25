"use client";

import { dayText, defaultTitle, timeText } from "@everyfield/contracts/common";

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
	InlineAlert,
} from "@everyfield/ui/controls";
import { useState } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { editMeeting, scheduleMeeting } from "./actions.ts";
import { listMinistries, listVenues } from "./fetch.ts";
import { offsetText } from "../../components/dates.ts";
import { problemText, TYPE_LABEL, TYPES, type Detail, type MeetingType, type Outcome, type Venue } from "./model.ts";
import { changesKept, CHOOSE_FIRST, type ConflictField } from "../../components/save/conflict.ts";
import {
	DialogNotice,
	NoticeInDialog,
	SaveButton,
	useProblemFocus,
	type SaveIntent,
} from "../../components/save/parts.tsx";
import { useMergedDraft } from "../../components/save/useMergedDraft.ts";
import { SaveConflict } from "../../components/save/SaveConflict.tsx";

type Choice = { instant: string; offsetSeconds: number };
type Fold = { choices: Choice[]; offset: number | null };
type Ministry = { id: string; name: string };
type Place = { choice: string; name: string; address: string };
type Draft = {
	type: MeetingType;
	teamId: string;
	title: string;
	date: string;
	time: string;
	place: Place;
	notes: string;
};
type Kept = { base: Draft; draft: Draft; fold: Fold | null; problem?: "conflict" };
const blank = (v: string) => (v.trim() === "" ? null : v.trim());

const savedPlaces = createRead(() => listVenues({ limit: 100 }).then((r) => (r.status === "ok" ? r.value.items : [])), {
	failed: (): Venue[] => [],
});
const teamMinistries = createRead(() => listMinistries().then((r) => (r.status === "ok" ? r.value : [])), {
	failed: (): Ministry[] => [],
});

export function prefetchPlanReads(editing: boolean) {
	savedPlaces.prefetch();
	if (!editing) teamMinistries.prefetch();
}

function initial(meeting: Detail | undefined, ministry: Ministry | undefined): Draft {
	return {
		type: meeting?.type ?? (ministry ? "team_meeting" : "vision_meeting"),
		teamId: ministry?.id ?? "",
		title: meeting?.title ?? "",
		date: meeting?.localDate ?? "",
		time: meeting?.localTime ?? "18:30",
		place: placeOf(meeting),
		notes: meeting?.notes ?? "",
	};
}

const NO_PLACE: Place = { choice: "none", name: "", address: "" };
function placeOf(meeting: Detail | undefined): Place {
	const venue = meeting?.venue;
	return venue ? { choice: venue.id ?? "copied", name: venue.name, address: venue.address } : NO_PLACE;
}

const MEETING = "this meeting";
const FIELDS: readonly ConflictField<Draft>[] = [
	{ key: "title", label: "Title", text: (d) => d.title },
	{ key: "date", label: "Date", text: (d) => (d.date ? dayText(d.date) : "") },
	{ key: "time", label: "Start time", text: (d) => (d.time ? timeText(d.time) : "") },
	{ key: "place", label: "Place", text: (d) => d.place.name || "No place yet" },
	{ key: "notes", label: "Notes", text: (d) => d.notes },
];

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
	onKeep: (kept: Kept) => void;
	onSaved?: (meeting: Detail) => void;
	onPreview?: (meeting: Detail | null) => void;
	onStale?: () => Promise<unknown>;
	ministry?: Ministry;
}) {
	const editing = meeting !== undefined;
	const latest = initial(meeting, ministry);
	const merged = useMergedDraft({
		base: kept?.base ?? latest,
		latest,
		start: kept?.draft,
		fields: editing ? FIELDS : [],
	});
	const draft = merged.values;
	const [touched, setTouched] = useState(kept !== null && !kept.problem);
	const [fold, setFold] = useState<Fold | null>(kept?.fold ?? null);
	const [problem, setProblem] = useState<string | null>(
		kept?.problem && !merged.rows.length ? changesKept(MEETING) : null,
	);
	const [focusProblem, refuseProblem] = useProblemFocus();
	const venues = useRead(savedPlaces).value;
	const ministries = useRead(editing ? null : teamMinistries).value;
	const choices = fold?.choices ?? null;
	const offset = fold?.offset ?? null;
	const pending = lane.saving;
	const set = (patch: Partial<Draft>) => {
		merged.set(patch);
		if ("date" in patch || "time" in patch) setFold(null);
	};

	const team = !editing && draft.type === "team_meeting";

	const missing = {
		teamId: team && draft.teamId === "",
		date: draft.date === "",
		time: draft.time === "",
		placeName: draft.place.choice === "new" && draft.place.name.trim() === "",
		placeAddress: draft.place.choice === "new" && draft.place.address.trim() === "",
	};
	const typedPlace = { name: draft.place.name.trim(), address: draft.place.address.trim() };
	const samePlace = editing && JSON.stringify(draft.place) === JSON.stringify(latest.place);
	const venue = samePlace
		? undefined
		: draft.place.choice === "none"
			? { kind: "none" as const }
			: draft.place.choice === "new" || draft.place.choice === "copied"
				? { kind: "new" as const, venue: typedPlace }
				: { kind: "existing" as const, venueId: draft.place.choice };
	const when = { date: draft.date, time: draft.time, ...(offset !== null ? { offsetSeconds: offset } : {}) };

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		setProblem(null);
		if (lane.wait) return;
		if (Object.values(missing).some(Boolean) || merged.unchosen) return refuseProblem();
		if (choices && offset === null) return setProblem(problemText("ambiguous_local_time"));
		if (editing) {
			const moved = draft.date !== meeting.localDate || draft.time !== meeting.localTime;
			const patch = {
				...(blank(draft.title) !== meeting.title ? { title: blank(draft.title) } : {}),
				...(blank(draft.notes) !== meeting.notes ? { notes: blank(draft.notes) } : {}),
				...(moved || offset !== null ? when : {}),
				...(venue ? { venue } : {}),
			};
			onPreview?.({
				...meeting,
				title: blank(draft.title),
				displayTitle: blank(draft.title) ?? defaultTitle(meeting),
				notes: blank(draft.notes),
				localDate: draft.date as Detail["localDate"],
				localTime: draft.time,
				venue: samePlace
					? meeting.venue
					: draft.place.choice === "none"
						? null
						: {
								...typedPlace,
								id: venue?.kind === "existing" ? (venue.venueId as NonNullable<Detail["venue"]>["id"]) : null,
							},
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
					if (code === "conflict" && onStale) {
						lane.dismiss();
						return void onStale().then(() => onKeep({ base: latest, draft, fold, problem: "conflict" }));
					}
					onKeep({ base: latest, draft, fold: answered ? { choices: answered, offset } : fold });
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

	const held = [latest.place, kept?.base.place, kept?.draft.place, draft.place].filter(
		(p, i, all): p is Place =>
			!!p && p.choice !== "none" && p.choice !== "new" && all.findIndex((q) => q?.choice === p.choice) === i,
	);
	const pickPlace = (choice: string) => {
		const known = held.find((p) => p.choice === choice) ?? venues?.find((v) => v.id === choice);
		return set({ place: known ? { choice, name: known.name, address: known.address } : { ...NO_PLACE, choice } });
	};
	const placeOptions = [
		...held.map((p) => ({ value: p.choice, label: p === latest.place ? `Keep ${p.name}` : p.name })),
		{ value: "none", label: "No place yet" },
		...(venues ?? [])
			.filter((v) => v.active && !held.some((p) => p.choice === v.id))
			.map((v) => ({ value: v.id, label: v.name })),
		{ value: "new", label: "Add a new place" },
	];

	return (
		<DialogContent aria-busy={pending || undefined} onInteractOutside={(e) => pending && e.preventDefault()}>
			<form ref={focusProblem} onSubmit={submit} noValidate className="contents">
				<DialogHeader
					icon={editing ? Edit02Icon : CalendarAdd01Icon}
					tone="green"
					title={editing ? "Edit meeting" : "Plan a meeting"}
					description={
						editing ? "Changes apply to this meeting only." : "Guests with a seat get reminders 7, 3 and 1 day before."
					}
				/>
				<DialogBody className="flex flex-col gap-4">
					<SaveConflict
						what={MEETING}
						rows={merged.rows}
						asked={touched}
						focus={kept?.problem === "conflict"}
						disabled={pending}
						onPick={(field, pick) => {
							merged.choose(field, pick);
							if (field === "date" || field === "time") setFold(null);
						}}
						onKeepSaved={onClose}
					/>
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
						<Select value={draft.place.choice} disabled={pending} onValueChange={pickPlace} options={placeOptions} />
					</Field>
					{draft.place.choice === "new" ? (
						<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
							<Field
								label="Place name"
								error={touched && missing.placeName ? "Enter a name, such as Reyes home." : null}
							>
								<Input
									value={draft.place.name}
									maxLength={120}
									readOnly={pending}
									autoComplete="off"
									onChange={(e) => set({ place: { ...draft.place, name: e.target.value } })}
								/>
							</Field>
							<Field label="Address" error={touched && missing.placeAddress ? "Enter the address." : null}>
								<Input
									value={draft.place.address}
									maxLength={500}
									readOnly={pending}
									autoComplete="off"
									onChange={(e) => set({ place: { ...draft.place, address: e.target.value } })}
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
					<InlineAlert>{problem ?? (touched && merged.unchosen ? CHOOSE_FIRST : undefined)}</InlineAlert>
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
