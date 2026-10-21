"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Radio,
	RadioGroup,
	SearchInput,
	Spinner,
	Textarea,
} from "@everyfield/ui/controls";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { searchPeople } from "./actions.ts";
import type { Outcome } from "./model.ts";
import { Problem, useSave } from "./parts.tsx";

/**
 * A change that needs a reason in the history: delete a meeting, clear a card, void an occurrence. The reason is
 * required; the dialog stays open with the problem when the save is refused.
 */
export function ReasonDialog({
	open,
	onOpenChange,
	title,
	description,
	consequences,
	confirmLabel,
	danger,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	consequences?: string[];
	confirmLabel: string;
	danger?: boolean;
	/** Saves with the reason; `save` keeps the request key across a retry. Resolves true when done. */
	onConfirm: (reason: string, save: ReturnType<typeof useSave>["save"]) => Promise<boolean>;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<ReasonForm
					title={title}
					description={description}
					consequences={consequences}
					confirmLabel={confirmLabel}
					danger={danger}
					onConfirm={onConfirm}
					onClose={() => onOpenChange(false)}
				/>
			) : null}
		</Dialog>
	);
}

function ReasonForm({
	title,
	description,
	consequences,
	confirmLabel,
	danger,
	onConfirm,
	onClose,
}: Omit<Parameters<typeof ReasonDialog>[0], "open" | "onOpenChange"> & { onClose: () => void }) {
	const [reason, setReason] = useState("");
	const [touched, setTouched] = useState(false);
	const saving = useSave();
	const missing = reason.trim() === "";
	return (
		<DialogContent size="sm" aria-busy={saving.pending || undefined}>
			<form
				noValidate
				className="contents"
				onSubmit={async (e) => {
					e.preventDefault();
					setTouched(true);
					if (missing) return;
					if (await onConfirm(reason.trim(), saving.save)) onClose();
				}}
			>
				<DialogHeader
					title={title}
					description={description}
					icon={danger ? Alert02Icon : undefined}
					tone={danger ? "magenta" : "ink"}
				/>
				<DialogBody className="flex flex-col gap-4">
					{consequences?.length ? (
						<ul className="flex list-disc flex-col gap-1 pl-5 text-md text-text-2">
							{consequences.map((c) => (
								<li key={c}>{c}</li>
							))}
						</ul>
					) : null}
					<Field label="Reason" hint="It stays in the history." error={touched && missing ? "Enter a reason." : null}>
						<Textarea
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							maxLength={2000}
							rows={2}
							readOnly={saving.pending}
							autoFocus
						/>
					</Field>
					<Problem code={saving.problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" type="button" onClick={onClose} disabled={saving.pending}>
						Cancel
					</Button>
					<Button variant={danger ? "danger" : "primary"} type="submit" loading={saving.pending}>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

export type PickedPerson = { id: string; name: string };

/**
 * Find one person of this church by name, email or phone. The results are a radio group: arrow keys move, and the
 * chosen person stays chosen while the search changes. `none` adds a first choice for "no one".
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
	const result = got?.query === query ? got.value : null;
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
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
							<p className="px-2 py-3 text-sm text-text-3">
								{query ? "No one matches. Try another spelling, or add someone new." : "No people yet."}
							</p>
						) : null}
					</RadioGroup>
				)}
			</div>
		</div>
	);
}
