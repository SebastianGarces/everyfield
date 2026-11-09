"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import type { ChurchTemplateSummary } from "@everyfield/contracts/documents";
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
} from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import { editChurchTemplate } from "./actions.ts";

// Rename a church template or change its description. It makes no new version: documents already made from it keep
// their own title, and new ones take the new name. The limits are Save as template's.

const NAME_MAX = 200;
const DESCRIPTION_MAX = 500;

/** What the card shows after a save: the template's name and description. */
export type TemplateDetails = Pick<ChurchTemplateSummary, "title" | "description">;

export function EditTemplateDialog({
	onOpenChange,
	templateId,
	details,
	onSaved,
}: {
	onOpenChange: (open: boolean) => void;
	/** The church template's record id. */
	templateId: string;
	/** The name and description the card shows now, filled in. */
	details: TemplateDetails;
	onSaved: (saved: TemplateDetails) => void;
}) {
	const [name, setName] = useState(details.title);
	const [description, setDescription] = useState(details.description ?? "");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// One request key for each set of values while the dialog is open: a double click or a resend after a dropped
	// connection writes the change once, and a new value after a failure is a new request.
	const keys = useRef(new Map<string, string>());
	const trimmed = name.trim();

	function change(next: boolean) {
		if (!pending) onOpenChange(next);
	}

	async function save() {
		if (pending || !trimmed) return;
		const values = { name: trimmed, description: description.trim() };
		const id = JSON.stringify(values);
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
							maxLength={NAME_MAX}
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
							maxLength={DESCRIPTION_MAX}
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
					<div aria-live="assertive" className="empty:hidden">
						{error ? (
							<p className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
								<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
								{error}
							</p>
						) : null}
					</div>
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
