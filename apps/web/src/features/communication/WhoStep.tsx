"use client";
import type { Outcome } from "@everyfield/contracts/common";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Combobox, Field, Spinner } from "@everyfield/ui/controls";
import { cn, Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useId, useState, type ElementType, type KeyboardEvent } from "react";
import { createRead, useRead, useReadWith } from "../../components/read.tsx";
import { useStore } from "../../components/store.ts";
import { resolveAudience } from "./actions.ts";
import { recipientSearches, type ComposeStore } from "./Compose.store.ts";
import { audienceSize, plural } from "./composeModel.ts";
import { audienceGroups, groupLabel, type Audience, type AudienceSummary, type Recipient, type Team } from "./model.ts";

const MAX_CHIPS = 8;

const onDay = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
const unsubscribedReason = (iso: string) => `Unsubscribed from this church's email on ${onDay(iso)}`;

const lost = <T,>(): Outcome<T> => ({ status: "lost" });

const audienceSummaries = createRead((audience: Audience) => resolveAudience(audience), {
	failed: lost<AudienceSummary>,
});
const chipAudience = (value: string): Audience => {
	const [kind, id] = value.split(":") as [string, string];
	return { groups: kind === "group" ? [id] : [], teamIds: kind === "team" ? [id] : [], personIds: [] };
};
const chipCounts = createRead((value: string) => resolveAudience(chipAudience(value)), {
	failed: lost<AudienceSummary>,
});

export function useAudienceSummary(audience: Audience, counted: Audience) {
	const empty = audienceSize(audience) === 0;
	const read = useRead(audienceSize(counted) === 0 ? null : audienceSummaries, counted);
	if (empty) return { summary: null, failed: null, ready: true };
	const current = JSON.stringify(counted) === JSON.stringify(audience) && read.value !== undefined;
	if (!current || !read.value) return { summary: null, failed: null, ready: false };
	return read.value.status === "ok"
		? { summary: read.value.value, failed: null, ready: true }
		: { summary: null, failed: "The recipient counts did not load. Try again.", ready: true };
}

export function WhoStep({
	store,
	teams,
	locked,
	summary,
	failed,
}: {
	store: ComposeStore;
	teams: Team[];
	locked: boolean;
	summary: AudienceSummary | null;
	failed: string | null;
}) {
	const form = useStore(store, (state) => state.form);
	const edit = useStore(store, (state) => state.actions.edit);
	const options = [
		...audienceGroups.map((group) => ({ value: `group:${group}`, label: groupLabel[group] })),
		...teams.map((team) => ({ value: `team:${team.id}`, label: team.name, description: "Team" })),
	];
	const chosen = [
		...form.audience.groups.map((group) => `group:${group}`),
		...form.audience.teamIds.map((id) => `team:${id}`),
	];
	const labelOf = (value: string) => options.find((option) => option.value === value)?.label ?? value;

	const setSelection = (values: string[]) =>
		edit((current) => ({
			...current,
			audience: {
				...current.audience,
				groups: values.filter((v) => v.startsWith("group:")).map((v) => v.slice(6)),
				teamIds: values.filter((v) => v.startsWith("team:")).map((v) => v.slice(5)),
			},
		}));

	return (
		<div className="flex flex-col gap-6">
			<div className="flex max-w-3xl flex-col gap-4">
				<Field label="Groups and teams" hint="Pick as many as you like. People in more than one are counted once.">
					<Combobox
						multiple
						options={options}
						value={chosen}
						onValueChange={setSelection}
						searchLabel="Search groups and teams"
						placeholder="Choose groups and teams"
					/>
				</Field>
				{chosen.length > 0 ? (
					<ul className="flex flex-wrap gap-2" aria-label="Chosen groups and teams">
						{chosen.map((value) => (
							<li key={value}>
								<ChosenChip
									value={value}
									label={labelOf(value)}
									remove={locked ? undefined : () => setSelection(chosen.filter((v) => v !== value))}
								/>
							</li>
						))}
					</ul>
				) : null}
				<ToField store={store} locked={locked} known={summary?.recipients ?? []} />
			</div>
			<Counts summary={summary} failed={failed} empty={audienceSize(form.audience) === 0} />
		</div>
	);
}

function ChosenChip({ value, label, remove }: { value: string; label: string; remove?: () => void }) {
	const count = useRead(chipCounts, value).value;
	return (
		<Chip
			label={`${label}${count?.status === "ok" ? ` · ${plural(count.value.eligibleRecipients, "person", "people")}` : ""}`}
			remove={remove}
			removeLabel={`Remove ${label}`}
		/>
	);
}

function Chip({ label, remove, removeLabel }: { label: string; remove?: () => void; removeLabel: string }) {
	return (
		<span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-2 pr-1 pl-3 text-sm font-medium text-ink">
			{label}
			{remove ? (
				<button
					type="button"
					aria-label={removeLabel}
					onClick={remove}
					className="grid size-6 place-items-center rounded-sm text-text-2 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)]"
				>
					<Icon icon={Cancel01Icon} size={16} />
				</button>
			) : (
				<span className="w-2" />
			)}
		</span>
	);
}

function Counts({
	summary,
	failed,
	empty,
}: {
	summary: AudienceSummary | null;
	failed: string | null;
	empty: boolean;
}) {
	const tiles: { label: string; value: number | null }[] = [
		{ label: "Selected, after duplicates", value: summary?.resolvedDistinctPeople ?? (empty ? 0 : null) },
		{ label: "Will get this email", value: summary?.eligibleRecipients ?? (empty ? 0 : null) },
		{
			label: "Left out",
			value: summary ? summary.missingEmailExclusions.length + summary.unsubscribedExclusions.length : empty ? 0 : null,
		},
	];
	return (
		<div className="flex flex-col gap-4">
			<div aria-live="polite" className="grid max-w-3xl grid-cols-3 gap-3">
				{tiles.map((tile) => (
					<div key={tile.label} className="flex flex-col gap-1 rounded-lg bg-surface px-5 py-4">
						<span className="font-display text-[40px] leading-none tracking-[-0.02em] text-ink tabular-nums">
							{tile.value === null ? <Spinner size={20} /> : tile.value}
						</span>
						<span className="text-sm text-text-2">{tile.label}</span>
					</div>
				))}
			</div>
			{failed ? (
				<p role="alert" className="text-sm font-medium text-magenta-600">
					{failed}
				</p>
			) : null}
			{summary ? (
				<section aria-label="Left out, and why" className="flex max-w-3xl flex-col gap-2">
					<h3 className="text-sm font-medium text-ink-2">Left out, and why</h3>
					{summary.missingEmailExclusions.length + summary.unsubscribedExclusions.length === 0 ? (
						<p className="text-sm text-text-2">Everyone selected can get this email.</p>
					) : (
						<ul className="flex flex-col gap-1">
							{summary.unsubscribedExclusions.map((person) => (
								<li key={person.id} className="flex flex-wrap justify-between gap-x-3 text-md text-ink">
									<span>{person.displayName}</span>
									<span className="text-text-2">{unsubscribedReason(person.unsubscribedAt)}</span>
								</li>
							))}
							{summary.missingEmailExclusions.map((name, index) => (
								<li key={`${name}-${index}`} className="flex justify-between gap-3 text-md text-ink">
									<span>{name}</span>
									<span className="text-text-2">No email address</span>
								</li>
							))}
						</ul>
					)}
					{summary.unsubscribedExclusions.length > 0 ? (
						<p className="text-sm text-text-2">
							Only the person can undo an unsubscribe, from the link in an email. Staff cannot clear it.
						</p>
					) : null}
					{summary.duplicateAddressesRemoved > 0 ? (
						<p className="text-sm text-text-2">
							{plural(summary.duplicateAddressesRemoved, "duplicate address", "duplicate addresses")} removed.
						</p>
					) : null}
				</section>
			) : null}
		</div>
	);
}

function ToField({
	store,
	locked,
	known,
}: {
	store: ComposeStore;
	locked: boolean;
	known: { id: string; displayName: string; email: string }[];
}) {
	const id = useId();
	const form = useStore(store, (state) => state.form);
	const { query, searched, open, active } = useStore(store, (state) => state.search);
	const actions = useStore(store, (state) => state.actions);
	const [expanded, setExpanded] = useState(false);
	const [card, setCard] = useState<string | null>(null);
	const answer = useReadWith(searched ? recipientSearches : null, [searched], { showPrevious: true });
	const found = answer.value;
	const results = found?.status === "ok" ? found.value.people : [];
	const status = found && found.status !== "ok" ? "The search did not load. Try again." : null;
	const byId = new Map(known.map((person) => [person.id, person]));
	const people = form.people.map((person) => ({
		...person,
		displayName: person.displayName ?? byId.get(person.id)?.displayName ?? "Person on this message",
		email: person.email ?? byId.get(person.id)?.email ?? null,
	}));
	const shown = query.trim() ? results : [];
	const searching = query.trim() !== "" && (searched !== query.trim() || answer.status !== "ready");
	const visible = expanded ? people : people.slice(0, MAX_CHIPS);

	const picked = new Set(form.audience.personIds);
	const add = (person: Recipient) => {
		if (!person.email || person.unsubscribedAt || picked.has(person.id)) return;
		actions.edit((current) => ({
			...current,
			people: [...current.people, person],
			audience: { ...current.audience, personIds: [...current.audience.personIds, person.id] },
		}));
		actions.clearSearch();
	};
	const remove = (personId: string) =>
		actions.edit((current) => ({
			...current,
			people: current.people.filter((p) => p.id !== personId),
			audience: { ...current.audience, personIds: current.audience.personIds.filter((p) => p !== personId) },
		}));

	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (shown.length === 0) return;
			event.preventDefault();
			actions.move(event.key === "ArrowDown" ? 1 : -1, shown.length);
		} else if (event.key === "Enter") {
			const person = shown[active];
			if (open && person) {
				event.preventDefault();
				add(person);
			}
		} else if (event.key === "Escape") {
			if (open) {
				event.preventDefault();
				actions.openList(false);
			}
		} else if (event.key === "Backspace" && query === "" && people.length > 0) {
			remove(people.at(-1)!.id);
		}
	};

	const listId = `${id}-list`;
	const inputId = `${id}-input`;
	const Box: ElementType = locked ? "div" : "label";
	return (
		<Field label="To" hint="Search by name or by the start of an email name. Pick people to add them.">
			<div className="relative">
				<Box
					htmlFor={locked ? undefined : inputId}
					className={cn(
						"flex min-h-11 flex-wrap items-center gap-2 rounded-md bg-surface-raised px-3 py-2 shadow-[0_0_0_1px_var(--ef-line-2)] focus-within:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]",
						!locked && "cursor-text",
					)}
				>
					{visible.map((person) => (
						<span
							key={person.id}
							className="relative"
							onMouseEnter={() => setCard(person.id)}
							onMouseLeave={() => setCard((c) => (c === person.id ? null : c))}
							onFocus={() => setCard(person.id)}
							onBlur={() => setCard((c) => (c === person.id ? null : c))}
						>
							<span className="inline-flex h-8 items-center gap-1 rounded-md bg-surface-2 pr-1 pl-3 text-sm font-medium text-ink">
								<button
									type="button"
									aria-label={`${person.displayName}, details`}
									aria-describedby={card === person.id ? `${id}-card-${person.id}` : undefined}
									className="rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)]"
									onClick={() => setCard(person.id)}
								>
									{person.displayName}
								</button>
								{locked ? (
									<span className="w-2" />
								) : (
									<button
										type="button"
										aria-label={`Remove ${person.displayName}`}
										onClick={() => remove(person.id)}
										className="grid size-6 place-items-center rounded-sm text-text-2 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)]"
									>
										<Icon icon={Cancel01Icon} size={16} />
									</button>
								)}
							</span>
							{card === person.id ? (
								<div
									id={`${id}-card-${person.id}`}
									role="tooltip"
									className="absolute top-full left-0 z-20 mt-1 flex w-64 flex-col gap-1 rounded-md bg-surface-raised p-3 text-sm shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)]"
								>
									<span className="font-medium text-ink">{person.displayName}</span>
									<span className="break-all text-text-2">{person.email ?? "Loading email"}</span>
									<Link
										href={`/people/${person.id}`}
										className="w-fit font-medium text-ink underline underline-offset-[3px]"
									>
										Open person
									</Link>
								</div>
							) : null}
						</span>
					))}
					{!expanded && people.length > MAX_CHIPS ? (
						<button
							type="button"
							onClick={() => setExpanded(true)}
							className="rounded-md px-2 text-sm font-medium text-ink underline underline-offset-[3px]"
						>
							+{people.length - MAX_CHIPS} more
						</button>
					) : null}
					{locked ? null : (
						<input
							id={inputId}
							role="combobox"
							aria-label="Add a person"
							aria-expanded={open && shown.length > 0}
							aria-controls={listId}
							aria-autocomplete="list"
							aria-activedescendant={open && shown[active] ? `${id}-opt-${active}` : undefined}
							value={query}
							placeholder={people.length === 0 ? "Type a name" : ""}
							onChange={(event) => actions.type(event.target.value)}
							onFocus={() => actions.openList(true)}
							onBlur={() => actions.openList(false)}
							onKeyDown={onKey}
							className="min-w-[160px] flex-1 bg-transparent text-md text-ink outline-none placeholder:text-text-3"
						/>
					)}
				</Box>
				{open && shown.length > 0 ? (
					<ul
						id={listId}
						role="listbox"
						aria-label="People"
						className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md bg-surface-raised p-1 shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)]"
					>
						{shown.map((person, index) => {
							const disabled = !person.email || Boolean(person.unsubscribedAt) || picked.has(person.id);
							return (
								<li
									key={person.id}
									id={`${id}-opt-${index}`}
									role="option"
									aria-selected={index === active}
									aria-disabled={disabled}
									onMouseDown={(event) => {
										event.preventDefault();
										if (!disabled) add(person);
									}}
									className="flex min-h-[40px] flex-wrap items-center justify-between gap-x-3 rounded-sm px-3 py-1.5 text-md text-ink aria-disabled:text-text-3 aria-selected:bg-surface-2"
								>
									<span className="min-w-0 truncate">{person.displayName}</span>
									<span className={`min-w-0 text-sm text-text-3 ${person.unsubscribedAt ? "" : "truncate"}`}>
										{!person.email
											? "No email address"
											: person.unsubscribedAt
												? unsubscribedReason(person.unsubscribedAt)
												: picked.has(person.id)
													? "Added"
													: person.email}
									</span>
								</li>
							);
						})}
					</ul>
				) : null}
				{open && query.trim() && shown.length === 0 && !status && !searching ? (
					<p className="absolute z-20 mt-1 w-full rounded-md bg-surface-raised p-3 text-sm text-text-3 shadow-[0_0_0_1px_var(--ef-line-2)]">
						No people match.
					</p>
				) : null}
			</div>
			{status ? (
				<p role="alert" className="mt-1 text-sm font-medium text-magenta-600">
					{status}
				</p>
			) : null}
		</Field>
	);
}
