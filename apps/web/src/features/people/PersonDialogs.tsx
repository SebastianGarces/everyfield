"use client";

import { Delete02Icon, Edit02Icon, UserIcon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Select,
	Skeleton,
	Textarea,
} from "@everyfield/ui/controls";
import { useState } from "react";
import type { z } from "zod";
import { classifyAdult, restorePerson, retirePerson, updatePerson, type Receipt } from "./actions.ts";
import type { EntryFields } from "./ActivityCard.tsx";
import {
	changedFields,
	CLASSIFICATION_LABEL,
	CLASSIFICATIONS,
	runSave,
	SOURCE_LABEL,
	SOURCES,
	type PersonStore,
} from "./model.ts";
import { FormProblem, fresh, isConflict, problemOf, problemText, useStore, useWarnings } from "./parts.tsx";
import type { PersonDraft } from "./StageDialog.tsx";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Store = PersonStore<PlantPerson, PersonDraft>;
/** What every person dialog reports: a saved change with its Activity entry, or a refusal because the page is old. */
type Reported = { onSaved: (receipt: Receipt, entry: EntryFields) => void; onConflict: () => void };

// ---------------------------------------------------------------------------------------------------------------
// Edit profile (REQ-PPL-002). The draft keeps the person as it was when editing began; Save sends only the fields
// that differ from it, and a cleared field is sent as null so the server clears it. Stage is not here: it changes
// only through Change stage, with its warnings.

const PROFILE = [
	"displayName",
	"firstName",
	"lastName",
	"email",
	"phone",
	"street",
	"city",
	"stateProvince",
	"postalCode",
	"country",
	"source",
	"sourceDetails",
	"summaryNotes",
	"birthDate",
] as const;
type ProfileKey = (typeof PROFILE)[number];
type Profile = Record<ProfileKey, string>;
export type ProfileDraft = { base: Profile; values: Profile };

export function profileOf(p: PlantPerson): Profile {
	const out = {} as Profile;
	for (const k of PROFILE) out[k] = (p[k] as string | null) ?? "";
	return out;
}
function patchOf(draft: ProfileDraft): Record<string, string | null> {
	const changed = changedFields(draft.base, draft.values);
	const patch: Record<string, string | null> = {};
	for (const [k, v] of Object.entries(changed) as [ProfileKey, string][])
		patch[k] = k === "displayName" || k === "source" ? v.trim() : v.trim() === "" ? null : v.trim();
	return patch;
}

const LABEL: Record<Exclude<ProfileKey, "source" | "summaryNotes" | "sourceDetails" | "birthDate">, string> = {
	displayName: "Name",
	firstName: "First name",
	lastName: "Last name",
	email: "Email",
	phone: "Phone",
	street: "Street",
	city: "City",
	stateProvince: "State or province",
	postalCode: "Postal code",
	country: "Country",
};

export function EditProfileDialog({
	open,
	onOpenChange,
	store,
	onSaved,
	onConflict,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	store: Store;
} & Reported) {
	const state = useStore(store);
	const person = state.saved;
	const pending = state.pending === "profile";
	const draft = state.drafts.profile as ProfileDraft | undefined;
	const values = draft?.values ?? profileOf(person);
	const [touched, setTouched] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const dirty = draft ? Object.keys(changedFields(draft.base, draft.values)).length > 0 : false;
	const set = (k: ProfileKey, v: string) =>
		store.dispatch({
			type: "edit",
			slot: "profile",
			draft: { base: draft?.base ?? profileOf(person), values: { ...values, [k]: v } },
		});
	const nameMissing = values.displayName.trim() === "";

	const close = (next: boolean) => {
		if (pending) return;
		if (!next && dirty) return setConfirming(true);
		if (!next) store.dispatch({ type: "discard", slot: "profile" });
		setTouched(false);
		onOpenChange(next);
	};

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (nameMissing || !draft) return;
		const patch = patchOf(draft);
		if (!Object.keys(patch).length) return close(false);
		const rev = person.revision;
		const result = await runSave(store, "profile", { patch, rev }, (key) => updatePerson(key, rev, person.id, patch), {
			fresh,
			toPerson: (v) => v.person,
		});
		if (result?.status === "ok") {
			setTouched(false);
			onOpenChange(false);
			onSaved(result.value.receipt, { kind: "activity", action: "updated" });
		} else if (isConflict(result)) onConflict();
	}

	const text = (k: keyof typeof LABEL, props: Partial<React.ComponentProps<typeof Input>> = {}) => (
		<Field
			label={LABEL[k]}
			optional={k !== "displayName"}
			error={k === "displayName" && touched && nameMissing ? "Enter a name." : null}
		>
			<Input
				value={values[k]}
				readOnly={pending}
				maxLength={k === "email" ? 320 : 255}
				autoComplete="off"
				onChange={(e) => set(k, e.target.value)}
				{...props}
			/>
		</Field>
	);

	return (
		<>
			<Dialog open={open} onOpenChange={close}>
				<DialogContent size="lg" aria-busy={pending || undefined}>
					<form onSubmit={save} noValidate className="contents">
						<DialogHeader icon={Edit02Icon} title="Edit profile" description={person.displayName} />
						<DialogBody className="flex flex-col gap-5">
							<fieldset className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
								<legend className="sr-only">Name</legend>
								<div className="col-span-2 max-app-sm:col-span-1">{text("displayName")}</div>
								{text("firstName")}
								{text("lastName")}
							</fieldset>
							<fieldset className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
								<legend className="mb-2 text-sm font-semibold text-ink">Contact</legend>
								{text("email", { type: "email" })}
								{text("phone", { type: "tel" })}
								<div className="col-span-2 max-app-sm:col-span-1">{text("street")}</div>
								{text("city")}
								{text("stateProvince")}
								{text("postalCode")}
								{text("country")}
							</fieldset>
							<fieldset className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
								<legend className="mb-2 text-sm font-semibold text-ink">How you met</legend>
								<Field label="Source">
									<Select
										value={values.source}
										disabled={pending}
										onValueChange={(v) => set("source", v)}
										options={SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
									/>
								</Field>
								<Field label="Birth date" optional hint="Never required.">
									<Input
										type="date"
										value={values.birthDate}
										readOnly={pending}
										onChange={(e) => set("birthDate", e.target.value)}
									/>
								</Field>
								<Field label="Source details" optional className="col-span-2 max-app-sm:col-span-1">
									<Textarea
										rows={2}
										maxLength={5000}
										value={values.sourceDetails}
										readOnly={pending}
										onChange={(e) => set("sourceDetails", e.target.value)}
									/>
								</Field>
								<Field
									label="Summary"
									optional
									hint="A short profile summary. Notes about conversations go in Activity."
									className="col-span-2 max-app-sm:col-span-1"
								>
									<Textarea
										rows={3}
										maxLength={5000}
										value={values.summaryNotes}
										readOnly={pending}
										onChange={(e) => set("summaryNotes", e.target.value)}
									/>
								</Field>
							</fieldset>
							<FormProblem code={state.errors.profile} />
						</DialogBody>
						<DialogFooter>
							<Button variant="secondary" type="button" onClick={() => close(false)} disabled={pending}>
								Cancel
							</Button>
							<Button variant="primary" type="submit" loading={pending}>
								Save changes
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Discard your changes?"
				description="The changes you made to this profile are not saved."
				confirmLabel="Discard changes"
				cancelLabel="Keep editing"
				tone="danger"
				onConfirm={() => {
					store.dispatch({ type: "discard", slot: "profile" });
					setTouched(false);
					onOpenChange(false);
				}}
			/>
		</>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Adult classification (REQ-PPL-002, cohort input). Explicit only: never inferred from a birth date, household or
// stage. The first explicit answer is recorded; a later one is a correction with a reason, both kept in history.

export type ClassifyDraft = { classification: string; occurredOn: string; reason: string };

export function ClassificationDialog({
	open,
	onOpenChange,
	store,
	onSaved,
	onConflict,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	store: Store;
} & Reported) {
	const state = useStore(store);
	const person = state.saved;
	const correction = person.adultClassification !== "unknown";
	const pending = state.pending === "classify";
	const draft = (state.drafts.classify as ClassifyDraft | undefined) ?? {
		classification: correction ? person.adultClassification : "adult",
		// No default: only the server knows the church's date, and a date from the reader's clock can be the church's
		// tomorrow (verifier finding on f0ea75d). The person picks the date.
		occurredOn: "",
		reason: "",
	};
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<ClassifyDraft>) =>
		store.dispatch({ type: "edit", slot: "classify", draft: { ...draft, ...patch } });
	const close = (next: boolean) => {
		if (pending) return;
		if (!next) {
			store.dispatch({ type: "discard", slot: "classify" });
			setTouched(false);
		}
		onOpenChange(next);
	};
	const missing = draft.reason.trim() === "" || draft.occurredOn === "";
	// Every other field is checked here first, so the server's invalid_input for this form means a church-future date.
	const futureDate = state.errors.classify === "invalid_input";

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (missing) return;
		const input = {
			personId: person.id,
			classification: draft.classification,
			occurredOn: draft.occurredOn,
			reason: draft.reason.trim(),
		};
		const rev = person.revision;
		const result = await runSave(
			store,
			"classify",
			{ input, rev, correction },
			(key) => classifyAdult(key, rev, correction, input),
			{ fresh, toPerson: (v) => v.person },
		);
		if (result?.status === "ok") {
			close(false);
			const action = correction ? "classification_corrected" : "classification_recorded";
			onSaved(result.value.receipt, { kind: "activity", action });
		} else if (isConflict(result)) onConflict();
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent aria-busy={pending || undefined}>
				<form onSubmit={save} noValidate className="contents">
					<DialogHeader
						icon={UserIcon}
						title={correction ? "Correct adult or child" : "Record adult or child"}
						description={`${person.displayName} · now ${CLASSIFICATION_LABEL[person.adultClassification].toLowerCase()}`}
					/>
					<DialogBody className="flex flex-col gap-4">
						<p>
							This is recorded as you say it. It is never worked out from a birth date, a household or a stage.
							{correction ? " The earlier answer stays in the history." : ""}
						</p>
						<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
							<Field label="Adult or child">
								<Select
									value={draft.classification}
									disabled={pending}
									onValueChange={(classification) => set({ classification })}
									options={CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABEL[c] }))}
								/>
							</Field>
							<Field
								label="As of"
								hint="The date you learned this, by your church's calendar."
								error={
									touched && draft.occurredOn === ""
										? "Choose the date you learned this."
										: futureDate
											? "This date is after today at your church. Choose an earlier date."
											: null
								}
							>
								<Input
									type="date"
									value={draft.occurredOn}
									readOnly={pending}
									onChange={(e) => set({ occurredOn: e.target.value })}
								/>
							</Field>
						</div>
						<Field label="Reason" error={touched && draft.reason.trim() === "" ? "Say how you know." : null}>
							<Textarea
								rows={2}
								maxLength={5000}
								value={draft.reason}
								readOnly={pending}
								onChange={(e) => set({ reason: e.target.value })}
							/>
						</Field>
						<FormProblem code={futureDate ? undefined : state.errors.classify} />
					</DialogBody>
					<DialogFooter>
						<Button variant="secondary" type="button" onClick={() => close(false)} disabled={pending}>
							Cancel
						</Button>
						<Button variant="primary" type="submit" loading={pending}>
							{correction ? "Save correction" : "Record"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Retire (REQ-PPL-003): a soft retirement with a reason. It reviews open duties first; each stays open as Needs
// owner. History and relations stay; the person leaves active lists and pickers. Restore is separate.

export function RetireDialog({
	open,
	onOpenChange,
	store,
	onSaved,
	onConflict,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	store: Store;
} & Reported) {
	const state = useStore(store);
	const person = state.saved;
	const pending = state.pending === "retire";
	const reason = (state.drafts.retire as { body: string } | undefined)?.body ?? "";
	// Read when the dialog opens and again after a conflict, never because this dialog's own save moved the revision.
	const [round, setRound] = useState(0);
	const warnings = useWarnings(person.id, round);
	const [touched, setTouched] = useState(false);
	const close = (next: boolean) => {
		if (pending) return;
		if (!next) {
			store.dispatch({ type: "discard", slot: "retire" });
			setTouched(false);
		}
		onOpenChange(next);
	};
	const ready = warnings?.status === "ok" ? warnings.value : null;

	async function retire() {
		setTouched(true);
		if (!ready || reason.trim() === "") return;
		const input = {
			personId: person.id,
			reason: reason.trim(),
			reviewRevision: ready.reviewRevision,
			handoffs: ready.openDuties.map((d) => ({
				kind: "needs_owner" as const,
				dutyId: d.id,
				expectedRevision: d.revision,
			})),
		};
		const rev = person.revision;
		const result = await runSave(store, "retire", { input, rev }, (key) => retirePerson(key, rev, input), {
			fresh,
			toPerson: (v) => v.person,
		});
		if (result?.status === "ok") {
			close(false);
			onSaved(result.value.receipt, { kind: "activity", action: "retired" });
		} else if (isConflict(result)) {
			setRound((r) => r + 1);
			onConflict();
		}
	}

	const duties = ready?.openDuties.length ?? 0;
	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent size="sm" aria-busy={pending || undefined}>
				<DialogHeader icon={Delete02Icon} tone="magenta" title={`Retire ${person.displayName}?`} />
				<DialogBody className="flex flex-col gap-4">
					{!warnings ? (
						<div aria-busy="true" className="flex flex-col gap-2">
							<span className="sr-only" role="status">
								Checking open work
							</span>
							<Skeleton className="h-4 w-3/4" />
							<Skeleton className="h-4 w-2/3" />
						</div>
					) : !ready ? (
						<FormProblem code={problemOf(warnings)} />
					) : (
						<ul className="flex flex-col gap-2 rounded-md bg-surface px-5 py-4 text-text-2">
							{[
								"They leave the active list and every picker. New meetings, tasks and teams cannot use them.",
								"Their history, notes and relations stay, and anyone who can see people can still find them under Retired.",
								duties
									? `${duties === 1 ? "1 open duty stays" : `${duties} open duties stay`} open and ${duties === 1 ? "is" : "are"} marked Needs owner.`
									: "They have no open follow-up work.",
								"An Owner or Admin can restore them later.",
							].map((c) => (
								<li key={c} className="flex gap-2.5">
									<span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />
									{c}
								</li>
							))}
						</ul>
					)}
					<Field label="Reason" error={touched && reason.trim() === "" ? "Say why they are retired." : null}>
						<Textarea
							rows={2}
							maxLength={5000}
							value={reason}
							readOnly={pending}
							onChange={(e) => store.dispatch({ type: "edit", slot: "retire", draft: { body: e.target.value } })}
						/>
					</Field>
					<FormProblem code={state.errors.retire} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => close(false)} disabled={pending}>
						Cancel
					</Button>
					<Button variant="danger" onClick={retire} loading={pending} disabled={!ready}>
						Retire person
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Restore (REQ-PPL-003): only an ordinary retired person. It does not bring back a seat, consent or private care. */
export function RestoreDialog({
	open,
	onOpenChange,
	store,
	onSaved,
	onConflict,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	store: Store;
} & Reported) {
	const person = useStore(store).saved;
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Restore ${person.displayName}?`}
			description="They come back to the active list with the stage and details they had."
			consequences={[
				"Their history stays as it is; the restore is added to it.",
				"A seat, account consent or private notes are not restored.",
			]}
			confirmLabel="Restore person"
			onConfirm={async () => {
				const rev = person.revision;
				const result = await runSave(store, "restore", { rev }, (key) => restorePerson(key, rev, person.id), {
					fresh,
					toPerson: (v) => v.person,
				});
				// ConfirmDialog shows a thrown message in the dialog and keeps it open for another try.
				if (result === null) throw new Error("Another change to this person is still saving. Try again in a moment.");
				if (isConflict(result)) onConflict();
				if (result.status !== "ok") throw new Error(problemText(problemOf(result) ?? "unavailable"));
				onSaved(result.value.receipt, { kind: "activity", action: "restored" });
			}}
		/>
	);
}
