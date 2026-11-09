"use client";

import { Alert02Icon, FloppyDiskIcon } from "@hugeicons/core-free-icons";
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
import { useState } from "react";
import { saveChurchTemplate } from "../actions.ts";

// Save as template (Approach A): the saved revision becomes the church's own template. Unsaved edits are not in a saved
// revision, so the dialog offers to save them first and holds Confirm until they are saved.

const NAME_MAX = 200;
const DESCRIPTION_MAX = 500;

export function SaveAsTemplateDialog({
	open,
	onOpenChange,
	docId,
	title,
	revision,
	unsaved,
	saving,
	onSaveFirst,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	docId: string;
	/** The document's title, filled in as the template's name. */
	title: string;
	/** The last saved revision: the one the template copies. */
	revision: string;
	unsaved: boolean;
	saving: boolean;
	onSaveFirst: () => Promise<boolean>;
	onSaved: (template: ChurchTemplateSummary) => void;
}) {
	const [name, setName] = useState(title);
	const [description, setDescription] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// One request key while the dialog is open: a double click or a resend after a dropped connection makes one template.
	// The editor mounts the dialog afresh each time it opens, so each opening starts with the title and a new key.
	const [requestKey] = useState(() => crypto.randomUUID());

	function change(next: boolean) {
		if (!pending) onOpenChange(next);
	}

	async function saveFirst() {
		setError(null);
		if (!(await onSaveFirst())) setError("Your changes did not save. Nothing was made. Try again.");
	}

	async function confirm() {
		if (pending || unsaved) return;
		const trimmed = name.trim();
		if (!trimmed) {
			setError("Give the template a name.");
			return;
		}
		setPending(true);
		setError(null);
		const result = await saveChurchTemplate({
			documentId: docId,
			revision: Number(revision),
			name: trimmed,
			description: description.trim(),
			requestKey,
		}).catch(() => ({ status: "lost" }) as const);
		setPending(false);
		if (result.status === "saved") {
			onOpenChange(false);
			onSaved(result.template);
			return;
		}
		setError(
			result.status === "refused"
				? result.message
				: "The connection dropped. Try again: it still makes only one template.",
		);
	}

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogContent size="md">
				<DialogHeader
					title="Save as template"
					description="Your church can make new documents from it in New from template. This document stays as it is."
				/>
				<DialogBody className="flex flex-col gap-4">
					{unsaved ? (
						<div className="flex flex-col gap-3 rounded-md bg-amber-100 px-4 py-3 text-md text-ink">
							<p className="flex items-start gap-2.5">
								<Icon icon={Alert02Icon} size={18} className="mt-0.5 flex-none text-amber-600" />
								<span>
									Your latest changes are not saved yet. The template copies the saved document, so save them first to
									include them.
								</span>
							</p>
							<div>
								<Button
									variant="secondary"
									size="sm"
									icon={FloppyDiskIcon}
									loading={saving}
									onClick={() => void saveFirst()}
								>
									Save changes
								</Button>
							</div>
						</div>
					) : null}
					<Field label="Template name">
						<Input
							value={name}
							maxLength={NAME_MAX}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void confirm();
								}
							}}
						/>
					</Field>
					<Field label="Description" optional hint="Shown under the name in New from template.">
						<Textarea
							value={description}
							maxLength={DESCRIPTION_MAX}
							rows={3}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</Field>
					<p className="text-sm text-text-3">
						The template copies revision {revision}: its page setup, blocks, tables and images. A document made from it
						fills in your church&apos;s details as they are then.
					</p>
					<div aria-live="assertive" className="empty:hidden">
						{error ? (
							<p className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
								<Icon icon={Alert02Icon} size={16} className="mt-px" />
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
					<Button variant="primary" loading={pending} disabled={unsaved || saving} onClick={() => void confirm()}>
						Save as template
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
