"use client";
import type { Outcome } from "@everyfield/contracts/common";

import { Certificate01Icon, FileEditIcon, Undo02Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { Button, Checkbox, Field, Input, Spinner, Textarea } from "@everyfield/ui/controls";
import type { Wait } from "../../../components/save/model.ts";
import { RecordDialog } from "../../../components/save/parts.tsx";
import { PersonPicker } from "../../meetings/dialogs.tsx";
import {
	NAME_MAX,
	REASON_MAX,
	dateError,
	daysError,
	nameError,
	problemText,
	reasonError,
	type AssignForm,
	type CorrectForm,
	type CreateForm,
	type PersonForm,
	type ServiceForm,
} from "./model.ts";
import { createDebouncer } from "@everyfield/ui/foundations";
import { useState } from "react";
import { createRead, useRead } from "../../../components/read.tsx";
import { previewRoster } from "./actions.ts";

const fieldText = "text-[16px]";

function personValue(id: string | null, name: string) {
	return id ? { id, name } : null;
}

export function CreateDialog({
	form,
	admin,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: CreateForm;
	admin: boolean;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: CreateForm) => void;
}) {
	const [f, setF] = useState(form);
	const [touched, setTouched] = useState(false);
	const name = nameError(f.name);
	return (
		<RecordDialog
			icon={UserGroupIcon}
			title="Add a program"
			description="A program is something people finish. A meeting does not finish it for them."
			action="Add program"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (name) return false;
				onSubmit({ ...f, name: f.name.trim() });
				return true;
			}}
		>
			<Field label="Name" error={touched ? name : null}>
				<Input
					className={fieldText}
					value={f.name}
					maxLength={NAME_MAX}
					onChange={(e) => setF((current) => ({ ...current, name: e.target.value }))}
				/>
			</Field>
			<Checkbox
				label="People must finish this"
				description="Required programs count only the people you put on the list."
				checked={f.required}
				onCheckedChange={(checked) => setF((current) => ({ ...current, required: checked === true }))}
			/>
			{admin ? (
				<Checkbox
					label="Every ministry"
					description="An Owner or Admin records a program that is not limited to this ministry."
					checked={f.churchwide}
					onCheckedChange={(checked) => setF((current) => ({ ...current, churchwide: checked === true }))}
				/>
			) : null}
		</RecordDialog>
	);
}

export function CorrectDialog({
	form,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: CorrectForm;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: CorrectForm) => void;
}) {
	const [f, setF] = useState(form);
	const [touched, setTouched] = useState(false);
	const name = nameError(f.name);
	const reason = reasonError(f.reason);
	return (
		<RecordDialog
			icon={FileEditIcon}
			title="Correct program"
			description="A change starts a new version. Earlier completions stay on the version they were recorded against."
			action="Correct program"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (name || reason) return false;
				onSubmit({ ...f, name: f.name.trim(), reason: f.reason.trim() });
				return true;
			}}
		>
			<Field label="Name" error={touched ? name : null}>
				<Input
					className={fieldText}
					value={f.name}
					maxLength={NAME_MAX}
					onChange={(e) => setF((current) => ({ ...current, name: e.target.value }))}
				/>
			</Field>
			<Checkbox
				label="People must finish this"
				description="Turn this on only when a saved list of people should count."
				checked={f.required}
				onCheckedChange={(checked) => setF((current) => ({ ...current, required: checked === true }))}
			/>
			<Field label="Reason" hint="The reason stays in the history." error={touched ? reason : null}>
				<Textarea
					value={f.reason}
					rows={3}
					maxLength={REASON_MAX}
					onChange={(e) => setF((current) => ({ ...current, reason: e.target.value }))}
				/>
			</Field>
		</RecordDialog>
	);
}

export function CompletionDialog({
	form,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: PersonForm;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: PersonForm) => void;
}) {
	const [f, setF] = useState(form);
	const [touched, setTouched] = useState(false);
	const redo = f.kind === "redo";
	const revoke = f.kind === "revoke";
	const missingPerson = f.personId === null;
	const date = revoke ? null : dateError(f.earnedOn);
	const copy = revoke
		? {
				title: `Revoke completion of ${f.programName}`,
				description: "Their current completion becomes invalid. The original record stays in the history.",
				action: "Revoke completion",
			}
		: redo
			? {
					title: `Record ${f.programName} again`,
					description: "This adds a new completion. It does not replace the earlier record.",
					action: "Record again",
				}
			: {
					title: `Record completion of ${f.programName}`,
					description: "Record the day you confirmed they finished. A scheduled session does not do this.",
					action: "Record completion",
				};
	return (
		<RecordDialog
			icon={revoke ? Undo02Icon : Certificate01Icon}
			tone={revoke ? "magenta" : "ink"}
			title={copy.title}
			description={copy.description}
			action={copy.action}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (missingPerson || date) return false;
				onSubmit(f);
				return true;
			}}
		>
			<PersonPicker
				label="Person"
				value={personValue(f.personId, f.personName)}
				onChange={(person) =>
					setF((current) => ({
						...current,
						personId: person?.id ?? null,
						personName: person?.name ?? "",
					}))
				}
			/>
			{touched && missingPerson ? <p className="text-xs font-medium text-magenta-600">Choose a person.</p> : null}
			{revoke ? null : (
				<Field label="Day they finished" error={touched ? date : null}>
					<Input
						className={fieldText}
						type="date"
						value={f.earnedOn}
						onChange={(e) => setF((current) => ({ ...current, earnedOn: e.target.value }))}
					/>
				</Field>
			)}
		</RecordDialog>
	);
}

type RosterPreview = Outcome<{ revision: string; rosterDigest: string }>;
type Check = { state: "checking" } | { state: "ready" } | { state: "failed"; message: string; retry: boolean };
type RosterKey = { programId: string; ids: string[] };

const rosterChecks = createRead(({ programId, ids }: RosterKey) => previewRoster(programId, ids), {
	failed: (): RosterPreview => ({ status: "lost" }),
});

const selectionOf = (personIds: readonly string[]) => [...personIds].sort();
const sameSelection = (a: readonly string[], b: readonly string[]) => a.join(",") === b.join(",");
const isStale = (result: RosterPreview, revision: string) =>
	result.status === "refused"
		? result.code === "conflict"
		: result.status === "ok" && result.value.revision !== revision;

function checkOf(result: RosterPreview, revision: string): Check {
	if (isStale(result, revision)) return { state: "failed", message: problemText("conflict"), retry: false };
	if (result.status === "refused") return { state: "failed", message: problemText(result.code), retry: false };
	if (result.status !== "ok")
		return { state: "failed", message: "The required list could not be checked. Try again.", retry: true };
	return { state: "ready" };
}

export function checkRoster(form: Pick<AssignForm, "programId" | "revision" | "personIds">, onStale: () => void) {
	void rosterChecks.get({ programId: form.programId, ids: selectionOf(form.personIds) }).then((result) => {
		if (isStale(result, form.revision)) onStale();
	});
}

function useRosterCheck(f: AssignForm, onStale: () => void) {
	const selection = selectionOf(f.personIds);
	const [asked, setAsked] = useState(selection);
	const [{ run: afterPause, cancelOnDetach }] = useState(() => createDebouncer(200));
	const preview = useRead(rosterChecks, { programId: f.programId, ids: asked });
	const settled = sameSelection(asked, selection) && preview.value !== undefined;
	const check: Check = settled && preview.value ? checkOf(preview.value, f.revision) : { state: "checking" };
	const digest = check.state === "ready" && preview.value?.status === "ok" ? preview.value.value.rosterDigest : null;
	const select = (personIds: readonly string[]) =>
		afterPause(() => {
			const next = selectionOf(personIds);
			checkRoster({ ...f, personIds: next }, onStale);
			setAsked(next);
		});
	const retry = () =>
		void rosterChecks.retry({ programId: f.programId, ids: asked }).then((result) => {
			if (isStale(result, f.revision)) onStale();
		});
	return { check, digest, select, cancelOnDetach, retry };
}

export function AssignDialog({
	form,
	directory,
	rosterKnown,
	problem,
	wait,
	onStale,
	onClose,
	onSubmit,
}: {
	form: AssignForm;
	directory: { id: string; name: string }[];
	rosterKnown: boolean;
	problem?: string;
	wait: Wait;
	onStale: () => void;
	onClose: () => void;
	onSubmit: (form: AssignForm) => void;
}) {
	const [f, setF] = useState(form);
	const [extra, setExtra] = useState<{ id: string; name: string }[]>([]);
	const [tooMany, setTooMany] = useState(false);
	const { check, digest, select, cancelOnDetach, retry } = useRosterCheck(f, onStale);
	const selected = new Set(f.personIds);
	const known = new Map([...directory, ...extra].map((person) => [person.id, person.name]));
	const choose = (personIds: string[]) => {
		setF({ ...f, personIds });
		select(personIds);
	};
	const toggle = (id: string, on: boolean) =>
		choose(on ? [...new Set([...f.personIds, id])] : f.personIds.filter((personId) => personId !== id));
	return (
		<RecordDialog
			icon={UserGroupIcon}
			title={`Who must finish ${f.programName}`}
			description="Review the whole list. Saving replaces who must finish this program. It does not record that they finished."
			action="Save required list"
			problem={problem}
			wait={wait}
			size="md"
			disabled={check.state !== "ready" || digest === null}
			onClose={onClose}
			onSubmit={() => {
				if (f.personIds.length > 500) {
					setTooMany(true);
					return false;
				}
				onSubmit({ ...f, rosterDigest: digest });
				return true;
			}}
		>
			{check.state === "failed" ? (
				<div role="alert" className="flex flex-col items-start gap-2">
					<p className="text-sm font-medium text-magenta-600">{check.message}</p>
					{check.retry ? (
						<Button variant="outline" onClick={retry}>
							Check again
						</Button>
					) : null}
				</div>
			) : check.state === "checking" ? (
				<p role="status" className="flex items-center gap-2 text-sm text-text-3">
					<Spinner size={16} /> Checking the current list…
				</p>
			) : null}
			{rosterKnown ? null : (
				<p className="text-sm text-text-2">
					The current list did not load. Saving now replaces it with only the people you select here.
				</p>
			)}
			<fieldset
				ref={cancelOnDetach}
				className="flex flex-col"
				data-invalid={(tooMany && f.personIds.length > 500) || undefined}
			>
				<legend className="text-sm font-medium text-ink-2">People on this ministry</legend>
				{directory.length === 0 ? (
					<p className="mt-2 text-sm text-text-2">This ministry has no people yet.</p>
				) : (
					directory.map((person) => (
						<Checkbox
							key={person.id}
							label={person.name}
							checked={selected.has(person.id)}
							onCheckedChange={(checked) => toggle(person.id, checked === true)}
						/>
					))
				)}
			</fieldset>
			{f.personIds
				.filter((id) => !directory.some((person) => person.id === id))
				.map((id) => (
					<Checkbox
						key={id}
						label={known.get(id) ?? "Selected person"}
						checked
						onCheckedChange={(checked) => toggle(id, checked === true)}
					/>
				))}
			<PersonPicker
				label="Add someone else"
				value={null}
				onChange={(person) => {
					if (!person || selected.has(person.id)) return;
					setExtra((rows) => [...rows, person]);
					choose([...f.personIds, person.id]);
				}}
			/>
			<p
				className={tooMany && f.personIds.length > 500 ? "text-sm font-medium text-magenta-600" : "text-sm text-text-3"}
				role={tooMany && f.personIds.length > 500 ? "alert" : undefined}
			>
				{f.personIds.length} selected. More than 500 cannot be saved.
			</p>
		</RecordDialog>
	);
}

export function ServiceDialog({
	form,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: ServiceForm;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: ServiceForm) => void;
}) {
	const [f, setF] = useState(form);
	const [touched, setTouched] = useState(false);
	const missingPerson = f.personId === null;
	const attendance = daysError(f.attendanceDays, "attendance days");
	const serving = daysError(f.volunteerDays, "serving days");
	return (
		<RecordDialog
			icon={Certificate01Icon}
			title="Record attendance and serving"
			description="Record both. 60 days of each can invite a leadership conversation. It does not change their stage or finish a program."
			action="Record attendance and serving"
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (missingPerson || attendance || serving) return false;
				onSubmit(f);
				return true;
			}}
		>
			<PersonPicker
				label="Person"
				value={personValue(f.personId, f.personName)}
				onChange={(person) =>
					setF((current) => ({
						...current,
						personId: person?.id ?? null,
						personName: person?.name ?? "",
					}))
				}
			/>
			{touched && missingPerson ? <p className="text-xs font-medium text-magenta-600">Choose a person.</p> : null}
			<Field
				label="Attendance days"
				hint="Days you can account for, from 0 to 20000."
				error={touched ? attendance : null}
			>
				<Input
					className={fieldText}
					inputMode="numeric"
					value={f.attendanceDays}
					onChange={(e) => setF((current) => ({ ...current, attendanceDays: e.target.value }))}
				/>
			</Field>
			<Field label="Serving days" hint="Days you can account for, from 0 to 20000." error={touched ? serving : null}>
				<Input
					className={fieldText}
					inputMode="numeric"
					value={f.volunteerDays}
					onChange={(e) => setF((current) => ({ ...current, volunteerDays: e.target.value }))}
				/>
			</Field>
		</RecordDialog>
	);
}
