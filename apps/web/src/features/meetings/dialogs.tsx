"use client";

import { Alert02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Checkbox, Field, Radio, RadioGroup, SearchInput, Spinner, Textarea } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PersonHit } from "@everyfield/domain/people";
import { searchPeople } from "./actions.ts";
import type { Wait } from "../../components/save/model.ts";
import { RecordDialog } from "../../components/save/parts.tsx";
import type { Outcome } from "./model.ts";

/**
 * A change that needs a reason in the history: delete a meeting, clear a card, void an occurrence. The reason is
 * required. The caller's save lane owns the dialog: a save closes it, and a refusal opens it again with the reason
 * kept (`initial`) and the problem in words.
 */
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

/**
 * The search box and its answer, shared by both pickers. It searches only after the person types, so opening a form
 * sends no read. An answer for an older search is never shown.
 */
function usePersonSearch() {
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [got, setGot] = useState<{ query: string; value: Outcome<PersonHit[]> } | null>(null);
	const idle = query === "";
	const result: Outcome<PersonHit[]> | null = idle ? { status: "ok", value: [] } : got?.query === query ? got.value : null;
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		if (query === "") return;
		let live = true;
		searchPeople(query).then(
			(value) => live && setGot({ query, value }),
			() => live && setGot({ query, value: { status: "lost" } }),
		);
		return () => {
			live = false;
		};
	}, [query]);
	useEffect(() => () => clearTimeout(timer.current), []);
	const onChange = (next: string) => {
		setSearch(next);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setQuery(next.trim()), 250);
	};
	return { search, onChange, idle, result };
}

function PersonSearchBox({
	label,
	search,
	onChange,
	autoFocus,
}: {
	label: string;
	search: string;
	onChange: (value: string) => void;
	autoFocus?: boolean;
}) {
	return (
		<SearchInput
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

/** The state of a search that has no list to show yet: still searching, or did not load. Null when results are ready. */
function SearchState({ result }: { result: Outcome<PersonHit[]> | null }) {
	if (result === null)
		return (
			<p role="status" className="flex items-center gap-2 px-2 py-3 text-sm text-text-2">
				<Spinner size={14} /> Searching…
			</p>
		);
	if (result.status !== "ok")
		return (
			<p role="alert" className="px-2 py-3 text-sm text-magenta-600">
				People did not load. Change the search to try again.
			</p>
		);
	return null;
}

/**
 * Find one person of this church by name, email or phone (the shared people search rule). The results are a radio
 * group: arrow keys move, and the chosen person stays chosen while the search changes. `none` adds a first choice for
 * "no one".
 */
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
	const { search, onChange: setSearch, idle, result } = usePersonSearch();
	const found = result?.status === "ok" ? result.value.filter((p) => !exclude.includes(p.id)) : [];
	const options = value && !found.some((p) => p.id === value.id) ? [{ ...value, detail: "" }, ...found] : found;
	return (
		<div className="flex flex-col gap-2">
			<PersonSearchBox label={label} search={search} onChange={setSearch} autoFocus={autoFocus} />
			<div className="max-h-[232px] min-h-[120px] overflow-y-auto rounded-md px-1">
				<SearchState result={result} />
				{result?.status === "ok" ? (
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
				) : null}
			</div>
		</div>
	);
}

/**
 * Find several people across searches. Results are checkboxes. A chosen person stays chosen when the search changes or
 * clears, and is listed below with a control to remove them, also when no current result shows them.
 */
export function PeoplePicker({
	label,
	value,
	onChange,
	exclude = [],
	autoFocus,
}: {
	label: string;
	value: PickedPerson[];
	onChange: (people: PickedPerson[]) => void;
	exclude?: string[];
	autoFocus?: boolean;
}) {
	const { search, onChange: setSearch, idle, result } = usePersonSearch();
	const chosenId = useId();
	const chosen = new Set(value.map((p) => p.id));
	const found = result?.status === "ok" ? result.value.filter((p) => !exclude.includes(p.id)) : [];
	const toggle = (p: PickedPerson, on: boolean) =>
		onChange(
			on ? [...value.filter((x) => x.id !== p.id), { id: p.id, name: p.name }] : value.filter((x) => x.id !== p.id),
		);
	return (
		<div className="flex flex-col gap-2">
			<PersonSearchBox label={label} search={search} onChange={setSearch} autoFocus={autoFocus} />
			<div className="h-[184px] overflow-y-auto rounded-md px-1">
				<SearchState result={result} />
				{result?.status === "ok" ? (
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
				) : null}
			</div>
			<div className="flex h-[88px] flex-col gap-1.5">
				<p className="text-sm font-medium text-ink-2" id={chosenId}>
					Chosen ({value.length})
				</p>
				{value.length ? (
					<ul aria-labelledby={chosenId} className="flex flex-wrap content-start gap-1.5 overflow-y-auto">
						{value.map((p) => (
							<li
								key={p.id}
								className="flex min-h-8 items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-1 pl-3 text-sm text-ink"
							>
								{p.name}
								<button
									type="button"
									aria-label={`Remove ${p.name}`}
									className="grid size-7 place-items-center rounded-full text-text-2 hover:bg-surface-3 hover:text-ink focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] focus-visible:outline-none"
									onClick={() => toggle(p, false)}
								>
									<Icon icon={Cancel01Icon} size={16} />
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-2">Search, then choose each person to add.</p>
				)}
			</div>
		</div>
	);
}
