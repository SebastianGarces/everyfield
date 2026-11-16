"use client";

import { Alert02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import {
	Checkbox,
	Field,
	IconButton,
	Radio,
	RadioGroup,
	SearchInput,
	Spinner,
	Textarea,
} from "@everyfield/ui/controls";
import { createDebouncer } from "@everyfield/ui/foundations";
import { useId, useState, type ReactNode } from "react";
import { Await, createRead, useRead, type ReadState } from "../../components/read.tsx";
import type { PersonHit } from "@everyfield/domain/people";
import { searchPeople } from "./actions.ts";
import type { Wait } from "../../components/save/model.ts";
import { RecordDialog } from "../../components/save/parts.tsx";
import type { Outcome } from "./model.ts";

export function ReasonDialog({
	title,
	description,
	consequences,
	confirmLabel,
	danger,
	initial = "",
	problem,
	wait = null,
	onClose,
	onSubmit,
}: {
	title: string;
	description?: ReactNode;
	consequences?: string[];
	confirmLabel: string;
	danger?: boolean;
	initial?: string;
	problem?: string;
	wait?: Wait;
	onClose: () => void;
	onSubmit: (reason: string) => void;
}) {
	const [reason, setReason] = useState(initial);
	const [touched, setTouched] = useState(false);
	const missing = reason.trim() === "";
	return (
		<RecordDialog
			icon={danger ? Alert02Icon : undefined}
			tone={danger ? "magenta" : "ink"}
			size="sm"
			title={title}
			description={description}
			action={confirmLabel}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (missing) return false;
				onSubmit(reason.trim());
				return true;
			}}
		>
			{consequences?.length ? (
				<ul className="flex list-disc flex-col gap-1 pl-5 text-md text-text-2">
					{consequences.map((c) => (
						<li key={c}>{c}</li>
					))}
				</ul>
			) : null}
			<Field label="Reason" hint="It stays in the history." error={touched && missing ? "Enter a reason." : null}>
				<Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={2} />
			</Field>
		</RecordDialog>
	);
}

export type PickedPerson = { id: string; name: string };

const PERSON_SEARCH_PAUSE_MS = 250;

const people = createRead((query: string) => searchPeople(query), {
	failed: (): Outcome<PersonHit[]> => ({ status: "lost" }),
});

function usePersonSearch() {
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [pause] = useState(() => createDebouncer(PERSON_SEARCH_PAUSE_MS));
	const idle = query === "";
	const hits = useRead(idle ? null : people, query);
	const onChange = (next: string) => {
		setSearch(next);
		pause.run(() => {
			if (next.trim()) people.prefetch(next.trim());
			setQuery(next.trim());
		});
	};
	return { search, onChange, idle, hits, cancelOnDetach: pause.cancelOnDetach };
}

function PersonSearchBox({
	label,
	search,
	onChange,
	cancelOnDetach,
	autoFocus,
}: {
	label: string;
	search: string;
	onChange: (value: string) => void;
	cancelOnDetach: (node: Element | null) => () => void;
	autoFocus?: boolean;
}) {
	return (
		<SearchInput
			ref={cancelOnDetach}
			aria-label={`Search people for ${label.toLowerCase()}`}
			placeholder="Search by name, email or phone"
			value={search}
			maxLength={255}
			autoFocus={autoFocus}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}

const emptyText = (idle: boolean) =>
	idle ? "Type a name, email or phone." : "No one matches. Try another spelling, or add someone new.";

function SearchResults({
	idle,
	hits,
	children,
}: {
	idle: boolean;
	hits: ReadState<Outcome<PersonHit[]>>;
	children: (found: PersonHit[]) => ReactNode;
}) {
	if (idle) return children([]);
	return (
		<Await
			state={hits}
			fallback={
				<p role="status" className="flex items-center gap-2 px-2 py-3 text-sm text-text-2">
					<Spinner size={14} /> Searching…
				</p>
			}
		>
			{(result) =>
				result.status === "ok" ? (
					children(result.value)
				) : (
					<p role="alert" className="px-2 py-3 text-sm text-magenta-600">
						People did not load. Change the search to try again.
					</p>
				)
			}
		</Await>
	);
}

export function PersonPicker({
	label,
	value,
	onChange,
	exclude = [],
	none,
	autoFocus,
}: {
	label: string;
	value: PickedPerson | null;
	onChange: (person: PickedPerson | null) => void;
	exclude?: string[];
	none?: string;
	autoFocus?: boolean;
}) {
	const { search, onChange: setSearch, idle, hits, cancelOnDetach } = usePersonSearch();
	return (
		<div className="flex flex-col gap-2">
			<PersonSearchBox
				label={label}
				search={search}
				onChange={setSearch}
				cancelOnDetach={cancelOnDetach}
				autoFocus={autoFocus}
			/>
			<div className="max-h-[232px] min-h-[120px] overflow-y-auto rounded-md px-1">
				<SearchResults idle={idle} hits={hits}>
					{(hits) => {
						const found = hits.filter((p) => !exclude.includes(p.id));
						const options =
							value && !found.some((p) => p.id === value.id) ? [{ ...value, detail: "" }, ...found] : found;
						return (
							<RadioGroup
								aria-label={label}
								value={value?.id ?? (none ? "" : undefined)}
								onValueChange={(id) => {
									if (id === "") return onChange(null);
									const p = options.find((o) => o.id === id);
									if (p) onChange({ id: p.id, name: p.name });
								}}
							>
								{none ? <Radio value="" label={none} /> : null}
								{options.map((p) => (
									<Radio key={p.id} value={p.id} label={p.name} description={p.detail || undefined} />
								))}
								{options.length === 0 ? (
									<p className="px-2 py-3 text-sm text-text-2" aria-live="polite">
										{emptyText(idle)}
									</p>
								) : null}
							</RadioGroup>
						);
					}}
				</SearchResults>
			</div>
		</div>
	);
}

export function PeoplePicker({
	label,
	value,
	onChange,
	exclude = [],
}: {
	label: string;
	value: PickedPerson[];
	onChange: (people: PickedPerson[]) => void;
	exclude?: string[];
}) {
	const { search, onChange: setSearch, idle, hits, cancelOnDetach } = usePersonSearch();
	const chosen = new Set(value.map((p) => p.id));
	const toggle = (p: PickedPerson, on: boolean) =>
		onChange(
			on ? [...value.filter((x) => x.id !== p.id), { id: p.id, name: p.name }] : value.filter((x) => x.id !== p.id),
		);
	return (
		<div className="flex flex-col gap-2">
			<PersonSearchBox label={label} search={search} onChange={setSearch} cancelOnDetach={cancelOnDetach} />
			<div className="h-[184px] overflow-y-auto rounded-md px-1">
				<SearchResults idle={idle} hits={hits}>
					{(hits) => {
						const found = hits.filter((p) => !exclude.includes(p.id));
						return (
							<div role="group" aria-label={label} className="flex flex-col">
								{found.map((p) => (
									<Checkbox
										key={p.id}
										label={p.name}
										description={p.detail || undefined}
										checked={chosen.has(p.id)}
										onCheckedChange={(on) => toggle(p, on === true)}
									/>
								))}
								{found.length === 0 ? (
									<p className="px-2 py-3 text-sm text-text-2" aria-live="polite">
										{emptyText(idle)}
									</p>
								) : null}
							</div>
						);
					}}
				</SearchResults>
			</div>
		</div>
	);
}

export type ChosenChip = { key: string; name: string; isNew: boolean };

export function ChosenList({
	chips,
	onRemove,
	error,
	empty,
}: {
	chips: ChosenChip[];
	onRemove: (key: string) => void;
	error?: string | null;
	empty: string;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<p className="text-sm font-medium text-ink-2" id={id} aria-live="polite">
				Chosen ({chips.length})
			</p>
			<div className="max-h-[236px] min-h-[108px] overflow-y-auto rounded-md">
				{chips.length ? (
					<ul aria-labelledby={id} className="flex flex-wrap content-start gap-1.5">
						{chips.map((c) => (
							<li
								key={c.key}
								className="flex min-h-8 items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-1 pl-3 text-sm text-ink"
							>
								{c.name}
								{c.isNew ? (
									<span className="rounded-pill bg-green-100 px-2 py-px text-xs font-semibold text-green-700">New</span>
								) : null}
								<IconButton
									icon={Cancel01Icon}
									label={`Remove ${c.name}`}
									variant="soft"
									size="sm"
									className="size-7 rounded-full"
									onClick={() => onRemove(c.key)}
								/>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-2">{empty}</p>
				)}
			</div>
			{error ? (
				<p className="text-xs font-medium text-magenta-600" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
