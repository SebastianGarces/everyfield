"use client";

import { Add01Icon, ArrowLeft01Icon, Location01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	ConfirmDialog,
	EmptyState,
	Field,
	Input,
	SearchInput,
	Sheet,
	Skeleton,
	StatePanel,
	Switch,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, List, ListRow, Tag } from "@everyfield/ui/display";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { changeVenue, createVenue, getVenue, listVenues } from "./actions.ts";
import { problemText, type Outcome, type Venue } from "./model.ts";
import { Problem, useSave } from "./parts.tsx";

type History = Extract<Awaited<ReturnType<typeof getVenue>>, { status: "ok" }>["value"];
/** `saved` is the place a save just answered with: the screen shows it at once and loads only its history. */
type Screen =
	{ kind: "list" } | { kind: "new" } | { kind: "venue"; id: string; saved?: Venue } | { kind: "edit"; venue: Venue };

/**
 * Places (REQ-MTG-003, REQ-MTG-004): the church's saved venues. Archived places are hidden unless asked for, and stay
 * on the meetings that used them. A correction records a reason in the place's history. Members read; Owners and
 * Admins add, change, archive and restore.
 */
export function VenuesSheet({
	open,
	onOpenChange,
	canWrite,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	canWrite: boolean;
}) {
	const [screen, setScreen] = useState<Screen>({ kind: "list" });
	const close = (next: boolean) => {
		onOpenChange(next);
		if (!next) setScreen({ kind: "list" });
	};
	return (
		<Sheet
			open={open}
			onOpenChange={close}
			title={screen.kind === "new" ? "Add a place" : screen.kind === "edit" ? "Change a place" : "Places"}
			description={
				screen.kind === "list"
					? "Where your meetings happen. A meeting keeps the place details it was saved with."
					: undefined
			}
			className="w-[480px]"
		>
			{!open ? null : screen.kind === "list" ? (
				<Places
					canWrite={canWrite}
					onOpen={(id) => setScreen({ kind: "venue", id })}
					onAdd={() => setScreen({ kind: "new" })}
				/>
			) : screen.kind === "venue" ? (
				<Place
					key={screen.id + (screen.saved?.revision ?? "")}
					id={screen.id}
					saved={screen.saved}
					canWrite={canWrite}
					onBack={() => setScreen({ kind: "list" })}
					onEdit={(venue) => setScreen({ kind: "edit", venue })}
				/>
			) : (
				<VenueForm
					venue={screen.kind === "edit" ? screen.venue : undefined}
					onDone={(id, saved) => setScreen(id ? { kind: "venue", id, saved } : { kind: "list" })}
				/>
			)}
		</Sheet>
	);
}

function Places({ canWrite, onOpen, onAdd }: { canWrite: boolean; onOpen: (id: string) => void; onAdd: () => void }) {
	const [search, setSearch] = useState("");
	const [archived, setArchived] = useState(false);
	const [round, setRound] = useState(0);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const [query, setQuery] = useState("");
	// The answer for the current search; an answer for an older search is never shown.
	const key = `${archived}:${query}:${round}`;
	const [got, setGot] = useState<{ key: string; value: Outcome<{ items: Venue[]; total: number }> } | null>(null);
	const result = got?.key === key ? got.value : null;
	useEffect(() => {
		let live = true;
		listVenues({ archived: archived ? "include" : "exclude", ...(query ? { search: query } : {}), limit: 100 }).then(
			(value) => live && setGot({ key, value }),
			() => live && setGot({ key, value: { status: "lost" } }),
		);
		return () => {
			live = false;
		};
	}, [archived, query, key]);
	useEffect(() => () => clearTimeout(timer.current), []);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<div className="min-w-0 flex-1">
					<SearchInput
						aria-label="Search places"
						placeholder="Search name or address"
						value={search}
						maxLength={120}
						onChange={(e) => {
							const next = e.target.value;
							setSearch(next);
							clearTimeout(timer.current);
							timer.current = setTimeout(() => setQuery(next.trim()), 300);
						}}
					/>
				</div>
				{canWrite ? (
					<Button variant="primary" size="sm" icon={Add01Icon} onClick={onAdd}>
						Add a place
					</Button>
				) : null}
			</div>
			<Switch label="Show archived places" checked={archived} onCheckedChange={setArchived} />
			{result === null ? (
				<div aria-busy="true" className="flex flex-col gap-3">
					<span className="sr-only" role="status">
						Loading places
					</span>
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-14 rounded-md" />
					))}
				</div>
			) : result.status !== "ok" ? (
				<StatePanel
					tone="error"
					title="Places did not load"
					headingLevel="h3"
					className="py-8"
					actions={
						<Button variant="secondary" size="sm" onClick={() => setRound((r) => r + 1)}>
							Try again
						</Button>
					}
				>
					Nothing was changed. Try again in a moment.
				</StatePanel>
			) : result.value.items.length === 0 ? (
				<EmptyState icon={Location01Icon} title={query ? "No places match" : "No places yet"} headingLevel="h3">
					{query
						? "Try another name or part of the address."
						: canWrite
							? "Add the homes, halls and schools where you meet. You can also add one while you plan a meeting."
							: "When an Owner or Admin adds a place, it appears here."}
				</EmptyState>
			) : (
				<List>
					{result.value.items.map((v) => (
						<ListRow
							key={v.id}
							title={v.name}
							subtitle={v.address}
							icon={Location01Icon}
							tone={v.active ? "teal" : "ink"}
							trailing={v.active ? null : <Tag>Archived</Tag>}
							onClick={() => onOpen(v.id)}
						/>
					))}
				</List>
			)}
		</div>
	);
}

function Place({
	id,
	saved,
	canWrite,
	onBack,
	onEdit,
}: {
	id: string;
	saved?: Venue;
	canWrite: boolean;
	onBack: () => void;
	onEdit: (venue: Venue) => void;
}) {
	const toast = useToast();
	const [got, setGot] = useState<Outcome<History> | null>(() =>
		saved ? { status: "ok", value: { status: "available", venue: saved, history: [] } } : null,
	);
	// After a save the place shows from the save's answer; only its history is still on the way.
	const [historyPending, setHistoryPending] = useState(saved !== undefined);
	const [, startTransition] = useTransition();
	const [active, setActive] = useOptimistic<boolean | null>(null);
	const [archiving, setArchiving] = useState(false);
	const archive = useSave();
	useEffect(() => {
		let live = true;
		getVenue(id).then(
			(r) => {
				if (!live) return;
				setHistoryPending(false);
				if (r.status === "ok" || !saved) setGot(r);
			},
			() => {
				if (!live) return;
				setHistoryPending(false);
				if (!saved) setGot({ status: "lost" });
			},
		);
		return () => {
			live = false;
		};
	}, [id, saved]);

	const back = (
		<Button variant="ghost" size="sm" icon={ArrowLeft01Icon} onClick={onBack} className="self-start">
			All places
		</Button>
	);
	if (got === null)
		return (
			<div aria-busy="true" className="flex flex-col gap-3">
				{back}
				<span className="sr-only" role="status">
					Loading the place
				</span>
				<Skeleton className="h-8 w-1/2" />
				<Skeleton className="h-40 rounded-md" />
			</div>
		);
	if (got.status !== "ok" || got.value.status !== "available")
		return (
			<div className="flex flex-col gap-3">
				{back}
				<StatePanel tone="error" title="This place did not load" headingLevel="h3" className="py-8">
					{got.status === "ok" ? "It may have been removed." : "Nothing was changed. Try again in a moment."}
				</StatePanel>
			</div>
		);
	const loaded = got.value;
	const venue = loaded.venue;
	const isActive = active ?? venue.active;

	/** Archive or restore at once on screen; the answer confirms it or puts it back with the reason. */
	function toggle(to: "archive" | "restore", reason?: string) {
		startTransition(async () => {
			setActive(to === "restore");
			const input = { venueId: venue.id, ...(reason ? { reason } : {}) };
			const r = await archive.save({ to, input }, (key) => changeVenue(to, key, venue.revision, input));
			if (r?.status === "ok") {
				startTransition(() => setGot({ status: "ok", value: { ...loaded, venue: r.value.venue } }));
				toast({
					message: to === "archive" ? `${venue.name} is archived.` : `${venue.name} is restored.`,
					tone: "success",
				});
			} else if (r) {
				toast({ message: problemText(r.status === "lost" ? "lost" : r.code), tone: "error" });
				if (r.status === "refused" && r.code === "conflict") getVenue(venue.id).then(setGot);
			}
		});
	}

	return (
		<div className="flex flex-col gap-5">
			{back}
			<div>
				<h3 className="flex flex-wrap items-center gap-2 font-title text-title-sm tracking-[-0.02em] text-ink">
					{venue.name}
					{isActive ? null : <Tag>Archived</Tag>}
				</h3>
				<p className="mt-1 text-md text-text-2">{venue.address}</p>
			</div>
			<KeyValueList>
				<KeyValue size="sm" k="Contact" value={venue.contactName ?? "Not recorded"} />
				<KeyValue size="sm" k="Phone" value={venue.phone ?? "Not recorded"} />
				<KeyValue size="sm" k="Email" value={venue.email ?? "Not recorded"} />
				<KeyValue size="sm" k="Cost" value={venue.costDescription ?? "Not recorded"} />
				<KeyValue
					size="sm"
					k="Capacity"
					value={venue.capacity === null ? "Not recorded" : `${venue.capacity} people`}
				/>
			</KeyValueList>
			{venue.notes ? <p className="text-md whitespace-pre-line text-text-2">{venue.notes}</p> : null}
			{canWrite ? (
				<div className="flex flex-wrap gap-2.5">
					<Button variant="secondary" size="sm" onClick={() => onEdit(venue)} disabled={!isActive}>
						Change details
					</Button>
					{isActive ? (
						<Button variant="ghost" size="sm" onClick={() => setArchiving(true)}>
							Archive
						</Button>
					) : (
						<Button variant="secondary" size="sm" onClick={() => toggle("restore")}>
							Restore
						</Button>
					)}
				</div>
			) : null}
			{canWrite ? (
				<ConfirmDialog
					open={archiving}
					onOpenChange={setArchiving}
					title={`Archive ${venue.name}?`}
					consequences={[
						"It leaves the place list and cannot be chosen for a new meeting.",
						"Meetings that already use it keep its details.",
						"You can restore it later from Show archived places.",
					]}
					confirmLabel="Archive place"
					onConfirm={() => toggle("archive")}
				/>
			) : null}
			<section aria-labelledby="place-history">
				<h4 id="place-history" className="mb-2 text-sm font-semibold text-ink">
					History
				</h4>
				{historyPending ? (
					<p role="status" className="text-sm text-text-3">
						Loading history…
					</p>
				) : loaded.history.length === 0 ? (
					<p className="text-sm text-text-3">No changes yet.</p>
				) : (
					<ol className="flex flex-col">
						{loaded.history.map((h) => (
							<li key={h.id} className="border-t border-line py-2.5 text-sm first:border-t-0">
								<span className="font-medium text-ink">{HISTORY_LABEL[h.kind] ?? "Changed"}</span>
								<span className="text-text-3"> · {dayText(h.occurredAt)}</span>
								{h.after ? (
									<span className="block text-text-2">{Object.keys(h.after).map(fieldName).join(", ")}</span>
								) : null}
								{h.reason ? <span className="block text-text-2">Reason: {h.reason}</span> : null}
							</li>
						))}
					</ol>
				)}
			</section>
		</div>
	);
}

const HISTORY_LABEL: Record<string, string> = {
	create: "Added",
	edit: "Changed",
	correct: "Corrected",
	archive: "Archived",
	restore: "Restored",
	noop: "Saved with no change",
};
const FIELD_NAME: Record<string, string> = {
	name: "name",
	address: "address",
	contactName: "contact",
	phone: "phone",
	email: "email",
	costDescription: "cost",
	capacity: "capacity",
	notes: "notes",
	active: "archived state",
};
const fieldName = (k: string) => FIELD_NAME[k] ?? k;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 12, 2026" from an instant, by its UTC day, so the server and browser print the same words. */
const dayText = (at: string) => {
	const d = new Date(at);
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};

type VenueDraft = Record<
	"name" | "address" | "contactName" | "phone" | "email" | "costDescription" | "capacity" | "notes" | "reason",
	string
>;
const text = (v: string | null) => v ?? "";

/** Add a place, or change one. A change with a reason is a correction and keeps the reason in the history. */
function VenueForm({ venue, onDone }: { venue?: Venue; onDone: (id: string | null, saved?: Venue) => void }) {
	const [draft, setDraft] = useState<VenueDraft>({
		name: text(venue?.name ?? null),
		address: text(venue?.address ?? null),
		contactName: text(venue?.contactName ?? null),
		phone: text(venue?.phone ?? null),
		email: text(venue?.email ?? null),
		costDescription: text(venue?.costDescription ?? null),
		capacity: venue?.capacity ? String(venue.capacity) : "",
		notes: text(venue?.notes ?? null),
		reason: "",
	});
	const [touched, setTouched] = useState(false);
	const { save, pending, problem } = useSave();
	const set = (k: keyof VenueDraft) => (e: { target: { value: string } }) =>
		setDraft((d) => ({ ...d, [k]: e.target.value }));
	const capacity = draft.capacity.trim() === "" ? null : Number(draft.capacity);
	const errors = {
		name: draft.name.trim() === "" ? "Enter a name, such as Reyes home." : null,
		address: draft.address.trim() === "" ? "Enter the address." : null,
		email:
			draft.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())
				? "Enter a full email address, such as host@example.com."
				: null,
		capacity:
			capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100_000)
				? "Enter a whole number of people, 1 or more."
				: null,
	};

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (Object.values(errors).some(Boolean)) return;
		const fields = {
			name: draft.name.trim(),
			address: draft.address.trim(),
			contactName: draft.contactName.trim() || null,
			phone: draft.phone.trim() || null,
			email: draft.email.trim() || null,
			costDescription: draft.costDescription.trim() || null,
			capacity,
			notes: draft.notes.trim() || null,
		};
		if (!venue) {
			const r = await save(fields, (key) => createVenue(key, fields));
			if (r?.status === "ok") onDone(r.value.venue.id, r.value.venue);
			return;
		}
		const patch = Object.fromEntries(
			Object.entries(fields).filter(([k, v]) => v !== (venue as Record<string, unknown>)[k]),
		);
		if (Object.keys(patch).length === 0) return onDone(venue.id);
		const reason = draft.reason.trim();
		const op = reason ? "correct" : "edit";
		const input = { venueId: venue.id, patch, ...(reason ? { reason } : {}) };
		const r = await save({ op, input }, (key) => changeVenue(op, key, venue.revision, input));
		if (r?.status === "ok") onDone(venue.id, r.value.venue);
	}

	const show = (k: keyof typeof errors) => (touched ? errors[k] : null);
	return (
		<form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-busy={pending || undefined}>
			<Field label="Name" error={show("name")}>
				<Input
					value={draft.name}
					onChange={set("name")}
					maxLength={120}
					autoComplete="off"
					readOnly={pending}
					autoFocus
				/>
			</Field>
			<Field label="Address" error={show("address")}>
				<Input value={draft.address} onChange={set("address")} maxLength={500} autoComplete="off" readOnly={pending} />
			</Field>
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<Field label="Contact" optional>
					<Input
						value={draft.contactName}
						onChange={set("contactName")}
						maxLength={120}
						autoComplete="off"
						readOnly={pending}
					/>
				</Field>
				<Field label="Phone" optional>
					<Input
						type="tel"
						value={draft.phone}
						onChange={set("phone")}
						maxLength={40}
						autoComplete="off"
						readOnly={pending}
					/>
				</Field>
				<Field label="Email" optional error={show("email")}>
					<Input
						type="email"
						value={draft.email}
						onChange={set("email")}
						maxLength={320}
						autoComplete="off"
						readOnly={pending}
					/>
				</Field>
				<Field label="Capacity" optional error={show("capacity")}>
					<Input
						inputMode="numeric"
						value={draft.capacity}
						onChange={set("capacity")}
						maxLength={6}
						autoComplete="off"
						readOnly={pending}
					/>
				</Field>
			</div>
			<Field label="Cost" optional hint="Such as Free, or $50 for the evening.">
				<Input
					value={draft.costDescription}
					onChange={set("costDescription")}
					maxLength={500}
					autoComplete="off"
					readOnly={pending}
				/>
			</Field>
			<Field label="Notes" optional>
				<Textarea value={draft.notes} onChange={set("notes")} maxLength={2000} rows={3} readOnly={pending} />
			</Field>
			{venue ? (
				<Field
					label="Reason for a correction"
					optional
					hint="Fill this in when you fix a mistake. The reason stays in the place's history."
				>
					<Input value={draft.reason} onChange={set("reason")} maxLength={2000} autoComplete="off" readOnly={pending} />
				</Field>
			) : null}
			<Problem code={problem} />
			<div className="flex flex-wrap justify-end gap-2.5">
				<Button variant="secondary" type="button" onClick={() => onDone(venue?.id ?? null)} disabled={pending}>
					Cancel
				</Button>
				<Button variant="primary" type="submit" loading={pending}>
					{venue ? "Save changes" : "Add place"}
				</Button>
			</div>
		</form>
	);
}
