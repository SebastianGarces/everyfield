"use client";

import {
	Delete02Icon,
	Edit02Icon,
	File02Icon,
	SignatureIcon,
	UserRemove01Icon,
	UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Field,
	Input,
	Radio,
	RadioGroup,
	SearchInput,
	Spinner,
	Textarea,
	useFieldControl,
} from "@everyfield/ui/controls";
import { useEffect, useId, useRef, useState } from "react";
import type { Outcome, Wait } from "../../../components/save/model.ts";
import { RecordDialog } from "../../../components/save/parts.tsx";
import { LocalDay } from "../parts.tsx";
import { findWitnesses } from "./actions.ts";
import { KIND_LABEL, today, type Commitment, type Kind } from "./model.ts";
import { ChoiceField, recordProblem } from "./parts.tsx";

export const DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
const MAX_BYTES = 10 * 1024 * 1024;
const KINDS = (["core_group", "launch_team"] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }));

/** The client check before an upload (REQ-PPL-014). The server checks the bytes and type again. */
export function documentProblem(file: { size: number; type: string }): string | null {
	if (file.size === 0) return "This file is empty. Choose the signed card.";
	if (!(DOCUMENT_TYPES as readonly string[]).includes(file.type)) return "Use a PDF, JPG or PNG file.";
	if (file.size > MAX_BYTES) return "Choose a file of 10 MB or less.";
	return null;
}
export const fileSize = (bytes: number) =>
	bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export const fileKind = (mime: string) => (mime === "application/pdf" ? "PDF" : mime === "image/png" ? "PNG" : "JPG");

export type Witness =
	{ kind: "none" } | { kind: "person"; id: string; name: string } | { kind: "external"; text: string };
/** A record form's values. */
export type CommitmentDraft = {
	kind: Kind;
	occurredOn: string;
	witness: Witness;
	notes: string;
	file: File | null;
};
export const blankCommitment = (): CommitmentDraft => ({
	kind: "core_group",
	occurredOn: today(),
	witness: { kind: "none" },
	notes: "",
	file: null,
});

/** Record a signed commitment card (REQ-PPL-014): kind, signed date, witness, notes and the private document. */
export function RecordCommitmentDialog({
	wait,
	draft: initial,
	problem,
	personId,
	personName,
	moves,
	documentsEnabled,
	onClose,
	onSubmit,
}: {
	/** The card's last save is in flight or unknown (C68): saving waits, and the form keeps its answers. */
	wait: Wait;
	draft: CommitmentDraft;
	problem?: string;
	personId: string;
	personName: string;
	/** Saving moves the person's earlier stage to Core group. */
	moves: boolean;
	documentsEnabled: boolean;
	onClose: () => void;
	onSubmit: (draft: CommitmentDraft) => void;
}) {
	const [draft, setDraft] = useState(initial);
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<CommitmentDraft>) => setDraft((d) => ({ ...d, ...patch }));
	const fileError = draft.file ? documentProblem(draft.file) : null;
	const witnessMissing =
		(draft.witness.kind === "person" && !draft.witness.id) ||
		(draft.witness.kind === "external" && !draft.witness.text.trim());
	const complete = draft.occurredOn !== "" && !witnessMissing && !fileError;
	const futureDate = problem === "future_date";
	return (
		<RecordDialog
			wait={wait}
			icon={SignatureIcon}
			tone="green"
			title={`Record ${personName}'s commitment`}
			description={
				moves
					? `The card they signed. Saving moves ${personName} to Core group.`
					: "The card they signed. The stage stays as it is."
			}
			action="Save commitment"
			problem={problem && recordProblem(problem)}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (complete) onSubmit(draft);
				return complete;
			}}
		>
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<ChoiceField label="Card" value={draft.kind} options={KINDS} onChange={(kind) => set({ kind })} />
				<Field
					label="Signed on"
					hint="The date on the card, not today's date."
					error={
						touched && draft.occurredOn === ""
							? "Choose the date the card was signed."
							: futureDate
								? "Choose today or an earlier date."
								: null
					}
				>
					<Input
						type="date"
						value={draft.occurredOn}
						max={today()}
						onChange={(e) => set({ occurredOn: e.target.value })}
					/>
				</Field>
			</div>
			<WitnessField
				personId={personId}
				value={draft.witness}
				touched={touched}
				onChange={(witness) => set({ witness })}
			/>
			<Field label="Notes" optional>
				<Textarea rows={2} maxLength={5000} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
			</Field>
			{documentsEnabled ? (
				<Field
					label="Signed card"
					optional
					hint="A PDF, JPG or PNG of 10 MB or less. Only Owners and Admins can open it."
					error={fileError}
				>
					<DocumentPicker file={draft.file} onChange={(file) => set({ file })} />
				</Field>
			) : null}
		</RecordDialog>
	);
}

/**
 * The signed card's file inside its Field. The Field's label opens the picker; the button carries the field's hint,
 * error and the chosen file as its description, so a screen reader hears what is attached and why it is refused.
 */
function DocumentPicker({ file, onChange }: { file: File | null; onChange: (file: File | null) => void }) {
	const control = useFieldControl({});
	const chosenId = useId();
	const input = useRef<HTMLInputElement>(null);
	const choose = useRef<HTMLButtonElement>(null);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
			<Button
				ref={choose}
				type="button"
				size="sm"
				variant="secondary"
				icon={File02Icon}
				aria-describedby={[file ? chosenId : null, control["aria-describedby"]].filter(Boolean).join(" ") || undefined}
				aria-invalid={control["aria-invalid"]}
				onClick={() => input.current?.click()}
			>
				{file ? "Choose another file" : "Choose a file"}
				<span className="sr-only"> for the signed card</span>
			</Button>
			{file ? (
				<span className="flex min-w-0 items-center gap-2 text-sm text-ink-2">
					<span id={chosenId} className="min-w-0 [overflow-wrap:anywhere]">
						{file.name}
						<span className="text-text-3"> · {fileSize(file.size)}</span>
					</span>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						aria-label={`Remove ${file.name}`}
						onClick={() => {
							onChange(null);
							choose.current?.focus();
						}}
					>
						Remove
					</Button>
				</span>
			) : null}
			<input
				ref={input}
				id={control.id}
				type="file"
				accept={DOCUMENT_TYPES.join(",")}
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					const picked = e.target.files?.[0];
					if (picked) onChange(picked);
					e.target.value = "";
				}}
			/>
		</div>
	);
}

function WitnessField({
	personId,
	value,
	touched,
	onChange,
}: {
	personId: string;
	value: Witness;
	touched: boolean;
	onChange: (w: Witness) => void;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-2">
			<span id={id} className="text-sm font-medium text-ink-2">
				Witness <span className="font-normal text-text-3"> · Optional</span>
			</span>
			<RadioGroup
				aria-labelledby={id}
				orientation="horizontal"
				value={value.kind}
				onValueChange={(kind) =>
					onChange(
						kind === "person"
							? { kind: "person", id: "", name: "" }
							: kind === "external"
								? { kind: "external", text: "" }
								: { kind: "none" },
					)
				}
				className="flex-wrap gap-x-6"
			>
				<Radio value="none" label="No witness" className="py-1.5" />
				<Radio value="person" label="Someone in your church" className="py-1.5" />
				<Radio value="external" label="Someone else" className="py-1.5" />
			</RadioGroup>
			{value.kind === "person" ? (
				<WitnessPicker
					exclude={personId}
					value={value.id ? value : null}
					invalid={touched && !value.id}
					onChange={(p) => onChange({ kind: "person", id: p.id, name: p.name })}
				/>
			) : value.kind === "external" ? (
				<Field label="Witness name" error={touched && !value.text.trim() ? "Write who witnessed the card." : null}>
					<Input
						value={value.text}
						maxLength={200}
						autoFocus
						onChange={(e) => onChange({ kind: "external", text: e.target.value })}
					/>
				</Field>
			) : null}
		</div>
	);
}

/** Search this church's people for the witness. An answer for an older search is never shown. */
function WitnessPicker({
	exclude,
	value,
	invalid,
	onChange,
}: {
	exclude: string;
	value: { id: string; name: string } | null;
	invalid: boolean;
	onChange: (p: { id: string; name: string }) => void;
}) {
	const errorId = useId();
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [got, setGot] = useState<{
		query: string;
		value: Outcome<{ id: string; name: string; detail: string }[]>;
	} | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		if (query === "") return;
		let live = true;
		findWitnesses(query).then(
			(value) => live && setGot({ query, value }),
			() => live && setGot({ query, value: { status: "lost" } }),
		);
		return () => {
			live = false;
		};
	}, [query]);
	useEffect(() => () => clearTimeout(timer.current), []);
	const result = query === "" ? null : got?.query === query ? got.value : undefined;
	const found = result?.status === "ok" ? result.value.filter((p) => p.id !== exclude) : [];
	const options = value && !found.some((p) => p.id === value.id) ? [{ ...value, detail: "" }, ...found] : found;
	return (
		<div className="flex flex-col gap-2">
			<SearchInput
				aria-label="Search people for the witness"
				placeholder="Search name, email or phone"
				value={search}
				maxLength={255}
				autoFocus
				aria-invalid={invalid || undefined}
				aria-describedby={invalid ? errorId : undefined}
				onChange={(e) => {
					const next = e.target.value;
					setSearch(next);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => setQuery(next.trim()), 250);
				}}
			/>
			<div className="max-h-[200px] min-h-[52px] overflow-y-auto rounded-md px-1">
				{result === undefined ? (
					<p role="status" className="flex items-center gap-2 px-2 py-3 text-sm text-text-3">
						<Spinner size={14} /> Searching…
					</p>
				) : result !== null && result.status !== "ok" ? (
					<p role="alert" className="px-2 py-3 text-sm text-magenta-600">
						People did not load. Change the search to try again.
					</p>
				) : options.length === 0 ? (
					<p className="px-2 py-3 text-sm text-text-3" aria-live="polite">
						{result === null ? "Type a name, email or phone." : "No one matches. Try another spelling."}
					</p>
				) : (
					<RadioGroup
						aria-label="Witness"
						value={value?.id ?? ""}
						onValueChange={(id) => {
							const p = options.find((o) => o.id === id);
							if (p) onChange({ id: p.id, name: p.name });
						}}
						className="gap-0"
					>
						{options.map((p) => (
							<Radio key={p.id} value={p.id} label={p.name} description={p.detail || undefined} className="py-2" />
						))}
					</RadioGroup>
				)}
			</div>
			{invalid ? (
				<p id={errorId} className="text-xs font-medium text-magenta-600" aria-live="polite">
					Choose the person who witnessed the card.
				</p>
			) : null}
		</div>
	);
}

export type LifecycleDraft = { effectiveOn: string; reason: string };

/** Withdraw or reactivate the current commitment on a date (REQ-PPL-014, 026). The stage never changes. */
export function LifecycleDialog({
	wait,
	change,
	draft: initial,
	problem,
	personName,
	since,
	onClose,
	onSubmit,
}: {
	/** The card's last save is in flight or unknown (C68): saving waits, and the form keeps its answers. */
	wait: Wait;
	change: "withdraw" | "reactivate";
	draft: LifecycleDraft;
	problem?: string;
	personName: string;
	/** The date the current state took effect. A change cannot be dated before it. */
	since: string | null;
	onClose: () => void;
	onSubmit: (draft: LifecycleDraft) => void;
}) {
	const [draft, setDraft] = useState(initial);
	const [touched, setTouched] = useState(false);
	const early = since !== null && draft.effectiveOn !== "" && draft.effectiveOn < since;
	const complete = draft.effectiveOn !== "" && !early;
	const withdraw = change === "withdraw";
	return (
		<RecordDialog
			wait={wait}
			icon={withdraw ? UserRemove01Icon : UserCheck01Icon}
			tone={withdraw ? "magenta" : "green"}
			title={withdraw ? `Withdraw ${personName}'s commitment` : `Reactivate ${personName}'s commitment`}
			description={
				withdraw
					? `${personName} no longer counts as committed from this date. The stage, the signed cards and the first commitment date stay.`
					: `${personName} counts as committed again from this date. The first commitment date stays.`
			}
			action={withdraw ? "Withdraw commitment" : "Reactivate commitment"}
			problem={problem && recordProblem(problem)}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (complete) onSubmit({ ...draft, reason: draft.reason.trim() });
				return complete;
			}}
		>
			<Field
				label={withdraw ? "Withdrawn on" : "Reactivated on"}
				className="max-w-[240px] max-app-sm:max-w-none"
				error={
					touched && draft.effectiveOn === ""
						? "Choose the date."
						: early && since
							? `Choose ${new Date(`${since}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} or later.`
							: problem === "future_date"
								? "Choose today or an earlier date."
								: null
				}
			>
				<Input
					type="date"
					value={draft.effectiveOn}
					min={since ?? undefined}
					max={today()}
					onChange={(e) => setDraft((d) => ({ ...d, effectiveOn: e.target.value }))}
				/>
			</Field>
			<Field label="Reason" optional hint="Your reason is saved in this person's history.">
				<Textarea
					rows={2}
					maxLength={5000}
					value={draft.reason}
					onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
				/>
			</Field>
		</RecordDialog>
	);
}

export type CorrectionDraft = { action: "correct" | "void"; occurredOn: string; kind: Kind; reason: string };

/** Correct one card's signed date or kind, or void a card that was never genuine (REQ-PPL-026). */
export function CorrectionDialog({
	wait,
	card,
	draft: initial,
	problem,
	onClose,
	onSubmit,
}: {
	/** The card's last save is in flight or unknown (C68): saving waits, and the form keeps its answers. */
	wait: Wait;
	card: Commitment;
	draft: CorrectionDraft;
	problem?: string;
	onClose: () => void;
	onSubmit: (draft: CorrectionDraft) => void;
}) {
	const [draft, setDraft] = useState(initial);
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<CorrectionDraft>) => setDraft((d) => ({ ...d, ...patch }));
	const voiding = draft.action === "void";
	const unchanged = !voiding && draft.occurredOn === card.occurredOn && draft.kind === card.kind;
	const complete = draft.reason.trim() !== "" && (voiding || (draft.occurredOn !== "" && !unchanged));
	return (
		<RecordDialog
			wait={wait}
			icon={voiding ? Delete02Icon : Edit02Icon}
			tone={voiding ? "magenta" : "blue"}
			title={voiding ? "Void this card" : "Correct this card"}
			description={
				<>
					{KIND_LABEL[card.kind]} card signed <LocalDay day={card.occurredOn} />. The earlier values and your reason
					stay in the history.
				</>
			}
			action={voiding ? "Void card" : "Save correction"}
			problem={problem && recordProblem(problem)}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (complete) onSubmit({ ...draft, reason: draft.reason.trim() });
				return complete;
			}}
		>
			<ChoiceField
				label="Change"
				value={draft.action}
				options={[
					{ value: "correct", label: "Correct date or card" },
					{ value: "void", label: "Void" },
				]}
				onChange={(action) => set({ action })}
			/>
			{voiding ? (
				<p className="text-sm text-text-2">
					Void a card only when it was never a real commitment, such as one recorded by mistake. A voided card stays in
					the history and no longer counts.
				</p>
			) : (
				<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
					<ChoiceField label="Card" value={draft.kind} options={KINDS} onChange={(kind) => set({ kind })} />
					<Field
						label="Signed on"
						error={
							touched && draft.occurredOn === ""
								? "Choose the date the card was signed."
								: touched && unchanged
									? "Change the date or the card, or cancel."
									: problem === "future_date"
										? "Choose today or an earlier date."
										: null
						}
					>
						<Input
							type="date"
							value={draft.occurredOn}
							max={today()}
							onChange={(e) => set({ occurredOn: e.target.value })}
						/>
					</Field>
				</div>
			)}
			<Field
				label="Reason"
				hint="Your reason is saved in this person's history."
				error={touched && draft.reason.trim() === "" ? "Say why this card is wrong." : null}
			>
				<Textarea rows={2} maxLength={5000} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} />
			</Field>
		</RecordDialog>
	);
}
