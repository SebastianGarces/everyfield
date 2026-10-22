"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Field, Radio, RadioGroup, SearchInput, Spinner, Textarea } from "@everyfield/ui/controls";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
 * Find one person of this church by name, email or phone. It searches only after the person types, so opening a form
 * sends no read. The results are a radio group: arrow keys move, and the chosen person stays chosen while the search
 * changes. `none` adds a first choice for "no one".
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
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	// The answer for the current search; an answer for an older search is never shown.
	const [got, setGot] = useState<{
		query: string;
		value: Outcome<{ id: string; name: string; detail: string }[]>;
	} | null>(null);
	const idle = query === "";
	const result = idle ? ({ status: "ok", value: [] } as const) : got?.query === query ? got.value : null;
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

	const found = result?.status === "ok" ? result.value.filter((p) => !exclude.includes(p.id)) : [];
	const options = value && !found.some((p) => p.id === value.id) ? [{ ...value, detail: "" }, ...found] : found;
	return (
		<div className="flex flex-col gap-2">
			<SearchInput
				aria-label={`Search people for ${label.toLowerCase()}`}
				placeholder="Search name, email or phone"
				value={search}
				maxLength={255}
				autoFocus={autoFocus}
				onChange={(e) => {
					const next = e.target.value;
					setSearch(next);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => setQuery(next.trim()), 250);
				}}
			/>
			<div className="max-h-[232px] min-h-[120px] overflow-y-auto rounded-md px-1">
				{result === null ? (
					<p role="status" className="flex items-center gap-2 px-2 py-3 text-sm text-text-3">
						<Spinner size={14} /> Searching…
					</p>
				) : result.status !== "ok" ? (
					<p role="alert" className="px-2 py-3 text-sm text-magenta-600">
						People did not load. Change the search to try again.
					</p>
				) : (
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
							<p className="px-2 py-3 text-sm text-text-3" aria-live="polite">
								{idle ? "Type a name, email or phone." : "No one matches. Try another spelling, or add someone new."}
							</p>
						) : null}
					</RadioGroup>
				)}
			</div>
		</div>
	);
}
