"use client";

import {
	TEMPLATE_DESCRIPTION_MAX,
	TEMPLATE_NAME_MAX,
	type ChurchTemplateSummary,
} from "@everyfield/contracts/documents";
import {
	Button,
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Textarea,
	InlineAlert,
} from "@everyfield/ui/controls";
import { useRef, useState } from "react";
import { editChurchTemplate } from "./actions.ts";

export type TemplateDetails = Pick<ChurchTemplateSummary, "title" | "description">;

export function EditTemplateDialog({
	onOpenChange,
	templateId,
	details,
	onSaved,
}: {
	onOpenChange: (open: boolean) => void;
	templateId: string;
	details: TemplateDetails;
	onSaved: (saved: TemplateDetails) => void;
}) {
	const [name, setName] = useState(details.title);
	const [description, setDescription] = useState(details.description ?? "");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const keys = useRef<Map<string, string> | null>(null);
	const trimmed = name.trim();

	function change(next: boolean) {
		if (!pending) onOpenChange(next);
	}

	async function save() {
		if (pending || !trimmed) return;
		const values = { name: trimmed, description: description.trim() };
		const id = JSON.stringify(values);
		keys.current ??= new Map();
		const requestKey = keys.current.get(id) ?? crypto.randomUUID();
		keys.current.set(id, requestKey);
		setPending(true);
		setError(null);
		const result = await editChurchTemplate({ templateId, ...values, requestKey }).catch(
			() => ({ status: "lost" }) as const,
		);
		setPending(false);
		if (result.status === "saved") {
			onOpenChange(false);
			onSaved({ title: result.template.title, description: result.template.description });
			return;
		}
		if (result.status === "lost") setError("The connection dropped. Try again: it still saves only once.");
		else if (result.code === "unavailable") setError(`“${details.title}” was deleted, so nothing was saved.`);
		else setError(result.message);
	}

	return (
		<Dialog open onOpenChange={change}>
			<DialogContent size="md">
				<DialogHeader
					title="Edit template"
					description="Change how this template is named and described in New from template. It keeps its version."
				/>
				<DialogBody className="flex flex-col gap-4">
					<Field label="Template name" error={trimmed ? undefined : "Give the template a name."}>
						<Input
							value={name}
							maxLength={TEMPLATE_NAME_MAX}
							onChange={(event) => {
								setName(event.target.value);
								setError(null);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void save();
								}
							}}
						/>
					</Field>
					<Field label="Description" optional hint="Shown under the name in New from template.">
						<Textarea
							value={description}
							maxLength={TEMPLATE_DESCRIPTION_MAX}
							rows={3}
							onChange={(event) => {
								setDescription(event.target.value);
								setError(null);
							}}
						/>
					</Field>
					<p className="text-sm text-text-3 text-pretty">
						New documents take the new name. Documents already made from this template keep their own title.
					</p>
					<InlineAlert>{error}</InlineAlert>
				</DialogBody>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="secondary" disabled={pending}>
							Cancel
						</Button>
					</DialogClose>
					<Button variant="primary" loading={pending} disabled={!trimmed} onClick={() => void save()}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
