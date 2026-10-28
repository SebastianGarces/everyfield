"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Combobox, Field, Spinner } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { resolveAudience, searchRecipients } from "./actions.ts";
import { audienceSize, plural, type Form } from "./composeModel.ts";
import { audienceGroups, groupLabel, type Audience, type AudienceSummary, type Recipient, type Team } from "./model.ts";

// Who: groups and teams in a searchable multi-select, people in one To field, then the counts and who is left out.

const MAX_CHIPS = 8;

/** The whole-audience counts, debounced to one request per 300 ms pause. `ready` is false while a request is out. */
export function useAudienceSummary(audience: Audience) {
	const key = JSON.stringify(audience);
	const [done, setDone] = useState<{ key: string; summary: AudienceSummary | null; failed: string | null } | null>(null);
	const empty = audienceSize(audience) === 0;
	useEffect(() => {
		if (empty) return;
		let live = true;
		const timer = setTimeout(() => {
			void resolveAudience(audience).then((result) => {
				if (!live) return;
				if (result.status !== "ok") {
					setDone({ key, summary: null, failed: "The recipient counts did not load. Try again." });
					return;
				}
				setDone({ key, summary: result.value, failed: null });
			});
		}, 300);
		return () => {
			live = false;
			clearTimeout(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	if (empty) return { summary: null, failed: null, ready: true };
	const current = done?.key === key;
	return { summary: current ? done.summary : null, failed: current ? done.failed : null, ready: current };
}

export function WhoStep({
	form,
	setForm,
	teams,
	locked,
	summary,
	failed,
}: {
	form: Form;
	setForm: (update: (current: Form) => Form) => void;
	teams: Team[];
	locked: boolean;
	summary: AudienceSummary | null;
	failed: string | null;
}) {
	const [counts, setCounts] = useState<Record<string, number>>({});
	const asked = useRef(new Set<string>());

	const options = useMemo(
		() => [
			...audienceGroups.map((group) => ({ value: `group:${group}`, label: groupLabel[group] })),
			...teams.map((team) => ({ value: `team:${team.id}`, label: team.name, description: "Team" })),
		],
		[teams],
	);
	const chosen = [
		...form.audience.groups.map((group) => `group:${group}`),
		...form.audience.teamIds.map((id) => `team:${id}`),
	];
	const labelOf = (value: string) => options.find((option) => option.value === value)?.label ?? value;

	// One request per added chip: the count for that selection alone.
	useEffect(() => {
		for (const value of chosen) {
			if (asked.current.has(value)) continue;
			asked.current.add(value);
			const [kind, id] = value.split(":") as [string, string];
			const audience = { groups: kind === "group" ? [id] : [], teamIds: kind === "team" ? [id] : [], personIds: [] };
			void resolveAudience(audience).then((result) => {
				if (result.status === "ok") setCounts((current) => ({ ...current, [value]: result.value.eligibleRecipients }));
				else asked.current.delete(value);
			});
		}
	});

	const setSelection = (values: string[]) =>
		setForm((current) => ({
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
								<Chip
									label={`${labelOf(value)}${counts[value] === undefined ? "" : ` · ${plural(counts[value]!, "person", "people")}`}`}
									remove={locked ? undefined : () => setSelection(chosen.filter((v) => v !== value))}
									removeLabel={`Remove ${labelOf(value)}`}
								/>
							</li>
						))}
					</ul>
				) : null}
				<ToField form={form} setForm={setForm} locked={locked} />
			</div>
			<Counts summary={summary} failed={failed} empty={audienceSize(form.audience) === 0} />
		</div>
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
					className="grid size-6 cursor-pointer place-items-center rounded-sm text-text-2 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)]"
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
		{ label: "Left out", value: summary ? summary.missingEmailExclusions.length : empty ? 0 : null },
	];
	return (
		<div className="flex flex-col gap-4">
			<div aria-live="polite" className="grid max-w-3xl grid-cols-3 gap-3">
				{tiles.map((tile) => (
					<div key={tile.label} className="flex flex-col gap-1 rounded-lg bg-surface px-5 py-4">
						<span className="font-title text-[40px] leading-none tracking-[-0.02em] text-ink tabular-nums">
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
					{summary.missingEmailExclusions.length === 0 ? (
						<p className="text-sm text-text-2">Everyone selected can get this email.</p>
					) : (
						<ul className="flex flex-col gap-1">
							{summary.missingEmailExclusions.map((name, index) => (
								<li key={`${name}-${index}`} className="flex justify-between gap-3 text-md text-ink">
									<span>{name}</span>
									<span className="text-text-2">No email address</span>
								</li>
							))}
						</ul>
					)}
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

/** The To field: type to search people, pick with arrows and Enter, remove with Backspace. */
function ToField({
	form,
	setForm,
	locked,
}: {
	form: Form;
	setForm: (update: (current: Form) => Form) => void;
	locked: boolean;
}) {
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Recipient[]>([]);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [status, setStatus] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [card, setCard] = useState<string | null>(null);
	const seq = useRef(0);
	const people = form.people;
	const shown = query.trim() ? results : [];
	const visible = expanded ? people : people.slice(0, MAX_CHIPS);

	useEffect(() => {
		const text = query.trim();
		const mine = ++seq.current;
		if (!text) return;
		const timer = setTimeout(() => {
			void searchRecipients(text).then((result) => {
				if (mine !== seq.current) return;
				if (result.status !== "ok") {
					setStatus("The search did not load. Try again.");
					return;
				}
				setStatus(null);
				setResults(result.value.people);
				setActive(0);
			});
		}, 300);
		return () => clearTimeout(timer);
	}, [query]);

	const picked = new Set(form.audience.personIds);
	const add = (person: Recipient) => {
		if (!person.email || picked.has(person.id)) return;
		setForm((current) => ({
			...current,
			people: [...current.people, person],
			audience: { ...current.audience, personIds: [...current.audience.personIds, person.id] },
		}));
		setQuery("");
		setResults([]);
	};
	const remove = (personId: string) =>
		setForm((current) => ({
			...current,
			people: current.people.filter((p) => p.id !== personId),
			audience: { ...current.audience, personIds: current.audience.personIds.filter((p) => p !== personId) },
		}));

	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (shown.length === 0) return;
			event.preventDefault();
			setOpen(true);
			setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
		} else if (event.key === "Enter") {
			const person = shown[active];
			if (open && person) {
				event.preventDefault();
				add(person);
			}
		} else if (event.key === "Escape") {
			if (open) {
				event.preventDefault();
				setOpen(false);
			}
		} else if (event.key === "Backspace" && query === "" && people.length > 0) {
			remove(people.at(-1)!.id);
		}
	};

	const listId = `${id}-list`;
	return (
		<Field label="To" hint="Search by name or by the start of an email name. Pick people to add them.">
			<div className="relative">
				<div
					onClick={() => input.current?.focus()}
					className="flex min-h-11 flex-wrap items-center gap-2 rounded-md bg-surface-raised px-3 py-2 shadow-[0_0_0_1px_var(--ef-line-2)] focus-within:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]"
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
									className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)]"
									onClick={(event) => {
										event.stopPropagation();
										setCard((c) => (c === person.id ? null : person.id));
									}}
								>
									{person.displayName}
								</button>
								{locked ? (
									<span className="w-2" />
								) : (
									<button
										type="button"
										aria-label={`Remove ${person.displayName}`}
										onClick={(event) => {
											event.stopPropagation();
											remove(person.id);
										}}
										className="grid size-6 cursor-pointer place-items-center rounded-sm text-text-2 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)]"
									>
										<Icon icon={Cancel01Icon} size={16} />
									</button>
								)}
							</span>
							{card === person.id ? (
								<div
									id={`${id}-card-${person.id}`}
									role="tooltip"
									className="absolute top-full left-0 z-20 mt-1 flex w-64 flex-col gap-1 rounded-md bg-surface-raised p-3 text-sm shadow-[0_0_0_1px_var(--ef-line-2),0_8px_24px_rgba(0,0,0,0.12)]"
								>
									<span className="font-medium text-ink">{person.displayName}</span>
									<span className="break-all text-text-2">{person.email ?? "Email shown at send"}</span>
									<Link
										href={`/people/${person.id}`}
										className="w-fit cursor-pointer font-medium text-ink underline underline-offset-[3px]"
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
							onClick={(event) => {
								event.stopPropagation();
								setExpanded(true);
							}}
							className="cursor-pointer rounded-md px-2 text-sm font-medium text-ink underline underline-offset-[3px]"
						>
							+{people.length - MAX_CHIPS} more
						</button>
					) : null}
					{locked ? null : (
						<input
							id={undefined}
							ref={input}
							role="combobox"
							aria-label="Add a person"
							aria-expanded={open && shown.length > 0}
							aria-controls={listId}
							aria-autocomplete="list"
							aria-activedescendant={open && shown[active] ? `${id}-opt-${active}` : undefined}
							value={query}
							placeholder={people.length === 0 ? "Type a name" : ""}
							onChange={(event) => {
								setQuery(event.target.value);
								setOpen(true);
							}}
							onFocus={() => setOpen(true)}
							onBlur={() => setOpen(false)}
							onKeyDown={onKey}
							className="min-w-[160px] flex-1 bg-transparent text-md text-ink outline-none placeholder:text-text-3"
						/>
					)}
				</div>
				{open && shown.length > 0 ? (
					<ul
						id={listId}
						role="listbox"
						aria-label="People"
						className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md bg-surface-raised p-1 shadow-[0_0_0_1px_var(--ef-line-2),0_8px_24px_rgba(0,0,0,0.12)]"
					>
						{shown.map((person, index) => {
							const disabled = !person.email || picked.has(person.id);
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
									className="flex min-h-[40px] items-center justify-between gap-3 rounded-sm px-3 py-1.5 text-md text-ink aria-disabled:cursor-not-allowed aria-disabled:text-text-3 aria-selected:bg-surface-2 [&:not([aria-disabled=true])]:cursor-pointer"
								>
									<span className="min-w-0 truncate">{person.displayName}</span>
									<span className="truncate text-sm text-text-3">
										{!person.email ? "No email address" : picked.has(person.id) ? "Added" : person.email}
									</span>
								</li>
							);
						})}
					</ul>
				) : null}
				{open && query.trim() && shown.length === 0 && !status ? (
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
