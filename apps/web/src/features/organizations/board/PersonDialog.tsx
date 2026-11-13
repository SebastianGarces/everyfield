"use client";

import type { PipelineBoard } from "@everyfield/contracts/organizations";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Select,
} from "@everyfield/ui/controls";
import { useState, type FormEvent } from "react";
import { addPerson, editPerson } from "./actions";
import { refusalText } from "./model";

type Staff = PipelineBoard["staff"];
type Stages = PipelineBoard["stages"];
const NOBODY = "none";

export type PersonValues = { name: string; email: string | null; responsibleSeatId: string | null; stageId: string };
export type Saved = PersonValues & { personId: string; revision: string };

/**
 * Add a person to the pipeline, or edit one's name, email and responsible staff. The responsible-staff choices are the
 * organization's current seats, from the server. Adding names the new person's ID once per dialog, so a resend after
 * a lost answer adds nobody twice.
 */
export function PersonDialog({
	open,
	onOpenChange,
	staff,
	stages,
	editing,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	staff: Staff;
	stages: Stages;
	/** The person being edited; absent when adding. */
	editing?: PersonValues & { personId: string; revision: string };
	onSaved: (saved: Saved) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">
				{open ? <Form staff={staff} stages={stages} editing={editing} onSaved={onSaved} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function Form({
	staff,
	stages,
	editing,
	onSaved,
}: {
	staff: Staff;
	stages: Stages;
	editing?: PersonValues & { personId: string; revision: string };
	onSaved: (saved: Saved) => void;
}) {
	const [personId] = useState(() => editing?.personId ?? crypto.randomUUID());
	const [name, setName] = useState(editing?.name ?? "");
	const [email, setEmail] = useState(editing?.email ?? "");
	const [responsible, setResponsible] = useState(editing?.responsibleSeatId ?? NOBODY);
	const [stageId, setStageId] = useState(editing?.stageId ?? stages[0]?.id ?? "");
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [nameError, setNameError] = useState<string | null>(null);
	const [emailError, setEmailError] = useState<string | null>(null);

	async function submit(event: FormEvent) {
		event.preventDefault();
		const trimmed = name.trim();
		const address = email.trim();
		setNameError(trimmed ? null : "Enter a name.");
		const emailOk = !address || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
		setEmailError(emailOk ? null : "Enter an email address like name@example.com, or leave it empty.");
		if (!trimmed || !emailOk) return;
		setSaving(true);
		setProblem(null);
		const values = {
			displayName: trimmed,
			email: address || null,
			responsibleSeatId: responsible === NOBODY ? null : responsible,
		};
		const answer = editing
			? await editPerson({ personId, expectedRevision: editing.revision, ...values }).catch(() => ({
					status: "lost" as const,
				}))
			: await addPerson({ personId, stageId, ...values }).catch(() => ({ status: "lost" as const }));
		setSaving(false);
		if (answer.status !== "ok") {
			setProblem(refusalText(answer));
			return;
		}
		onSaved({
			personId,
			revision: answer.value.revision,
			name: trimmed,
			email: values.email ? values.email.toLowerCase() : null,
			responsibleSeatId: values.responsibleSeatId,
			stageId,
		});
	}

	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={editing ? "Edit details" : "Add a person"}
				description={editing ? undefined : "Someone you are deliberately developing toward planting."}
			/>
			<DialogBody className="flex flex-col gap-4">
				<Field label="Name" error={nameError ?? undefined}>
					<Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={255} />
				</Field>
				<Field label="Email" optional error={emailError ?? undefined}>
					<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
				</Field>
				<Field label="Responsible staff" hint="They can read this person’s record and notes, and add notes.">
					<Select
						value={responsible}
						onValueChange={setResponsible}
						options={[{ value: NOBODY, label: "No one" }, ...staff.map((s) => ({ value: s.seatId, label: s.name }))]}
					/>
				</Field>
				{editing ? null : (
					<Field label="Stage">
						<Select
							value={stageId}
							onValueChange={setStageId}
							options={stages.map((s) => ({ value: s.id, label: s.label }))}
						/>
					</Field>
				)}
				<div aria-live="polite" className="empty:hidden">
					{problem ? <p className="rounded-md bg-magenta-50 px-3 py-2.5 text-sm text-magenta-600">{problem}</p> : null}
				</div>
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					{editing ? "Save" : "Add person"}
				</Button>
			</DialogFooter>
		</form>
	);
}
