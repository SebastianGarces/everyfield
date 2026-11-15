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
import { useActionState, useState } from "react";
import { addPerson, editPerson } from "./actions";
import { refusalText } from "./model";
import { Problem } from "./Problem";

type Staff = PipelineBoard["staff"];
type Stages = PipelineBoard["stages"];
const NOBODY = "none";

export type PersonValues = { name: string; email: string | null; responsibleSeatId: string | null; stageId: string };
export type Saved = PersonValues & { personId: string; revision: string };

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
	editing?: Saved;
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

type FormState = {
	values: { name: string; email: string; responsible: string; stageId: string };
	nameError: string | null;
	emailError: string | null;
	problem: string | null;
};

function Form({
	staff,
	stages,
	editing,
	onSaved,
}: {
	staff: Staff;
	stages: Stages;
	editing?: Saved;
	onSaved: (saved: Saved) => void;
}) {
	const [personId] = useState(() => editing?.personId ?? crypto.randomUUID());
	const [state, submit, saving] = useActionState(
		async (last: FormState, form: FormData): Promise<FormState> => {
			const values = {
				name: String(form.get("name") ?? ""),
				email: String(form.get("email") ?? ""),
				responsible: String(form.get("responsible") ?? NOBODY),
				stageId: String(form.get("stageId") ?? last.values.stageId),
			};
			const trimmed = values.name.trim();
			const address = values.email.trim();
			const emailOk = !address || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
			const checked = {
				values,
				nameError: trimmed ? null : "Enter a name.",
				emailError: emailOk ? null : "Enter an email address like name@example.com, or leave it empty.",
			};
			if (!trimmed || !emailOk) return { ...checked, problem: last.problem };
			const sent = {
				displayName: trimmed,
				email: address || null,
				responsibleSeatId: values.responsible === NOBODY ? null : values.responsible,
			};
			const answer = editing
				? await editPerson({ personId, expectedRevision: editing.revision, ...sent }).catch(() => ({
						status: "lost" as const,
					}))
				: await addPerson({ personId, stageId: values.stageId, ...sent }).catch(() => ({ status: "lost" as const }));
			if (answer.status !== "ok") return { ...checked, problem: refusalText(answer) };
			onSaved({
				personId,
				revision: answer.value.revision,
				name: trimmed,
				email: sent.email ? sent.email.toLowerCase() : null,
				responsibleSeatId: sent.responsibleSeatId,
				stageId: values.stageId,
			});
			return { ...checked, problem: null };
		},
		{
			values: {
				name: editing?.name ?? "",
				email: editing?.email ?? "",
				responsible: editing?.responsibleSeatId ?? NOBODY,
				stageId: editing?.stageId ?? stages[0]?.id ?? "",
			},
			nameError: null,
			emailError: null,
			problem: null,
		},
	);

	return (
		<form action={submit} noValidate className="contents">
			<DialogHeader
				title={editing ? "Edit details" : "Add a person"}
				description={editing ? undefined : "Someone you are deliberately developing toward planting."}
			/>
			<DialogBody className="flex flex-col gap-4">
				<Field label="Name" error={saving ? undefined : (state.nameError ?? undefined)}>
					<Input name="name" defaultValue={state.values.name} autoComplete="off" maxLength={255} />
				</Field>
				<Field label="Email" optional error={saving ? undefined : (state.emailError ?? undefined)}>
					<Input type="email" name="email" defaultValue={state.values.email} autoComplete="off" />
				</Field>
				<Field label="Responsible staff" hint="They can read this person’s record and notes, and add notes.">
					<Select
						name="responsible"
						defaultValue={state.values.responsible}
						options={[{ value: NOBODY, label: "No one" }, ...staff.map((s) => ({ value: s.seatId, label: s.name }))]}
					/>
				</Field>
				{editing ? null : (
					<Field label="Stage">
						<Select
							name="stageId"
							defaultValue={state.values.stageId}
							options={stages.map((s) => ({ value: s.id, label: s.label }))}
						/>
					</Field>
				)}
				<Problem text={saving ? null : state.problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					{editing ? "Save" : "Add person"}
				</Button>
			</DialogFooter>
		</form>
	);
}
