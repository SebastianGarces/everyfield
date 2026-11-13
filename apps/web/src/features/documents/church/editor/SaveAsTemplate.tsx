"use client";

import { Alert02Icon, FloppyDiskIcon } from "@hugeicons/core-free-icons";
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
	Radio,
	RadioGroup,
	SegmentedControl,
	Textarea,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useState } from "react";
import { listChurchTemplates, saveChurchTemplate, updateChurchTemplate } from "../actions.ts";

// Save as template (Approach A): the saved revision becomes the church's own template, or the next version of one it
// already has. Unsaved edits are not in a saved revision, so the dialog offers to save them first and holds Confirm
// until they are saved.

/** The church's templates now; none when they cannot be read, so the dialog offers only a new template. */
const currentTemplates = () =>
	listChurchTemplates().then(
		(result) => (result.status === "ok" ? result.templates : []),
		() => [],
	);

/** What the editor's confirmation names: the template, its version and whether this made a new version of it. */
export type TemplateSaved = { title: string; version: number; updated: boolean };

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
	onSaved: (saved: TemplateSaved) => void;
}) {
	const [mode, setMode] = useState<"new" | "update">("new");
	const [name, setName] = useState(title);
	const [description, setDescription] = useState("");
	// The church's templates as they stand when the dialog opens; null until read. None means no update choice.
	const [templates, setTemplates] = useState<ChurchTemplateSummary[] | null>(null);
	const [chosen, setChosen] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// One request key while the dialog is open: a double click or a resend after a dropped connection makes one template
	// or one version. The editor mounts the dialog afresh each time it opens, so each opening starts with the title, a
	// fresh read of the templates and a new key.
	const [requestKey] = useState(() => crypto.randomUUID());

	async function readTemplates() {
		const next = await currentTemplates();
		setTemplates(next);
		return next;
	}
	useEffect(() => {
		let live = true;
		void currentTemplates().then((next) => live && setTemplates(next));
		return () => {
			live = false;
		};
	}, []);

	const target = templates?.find((t) => t.id === chosen) ?? null;
	const updating = mode === "update" && (templates?.length ?? 0) > 0;

	function change(next: boolean) {
		if (!pending) onOpenChange(next);
	}

	async function saveFirst() {
		setError(null);
		if (!(await onSaveFirst())) setError("Your changes did not save. Nothing was made. Try again.");
	}

	async function confirmNew() {
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
			onSaved({ title: result.template.title, version: result.template.version, updated: false });
			return;
		}
		setError(
			result.status === "refused"
				? result.message
				: "The connection dropped. Try again: it still makes only one template.",
		);
	}

	async function confirmUpdate() {
		if (!target) {
			setError("Pick the template to update.");
			return;
		}
		setPending(true);
		setError(null);
		const result = await updateChurchTemplate({
			templateId: target.id,
			expectedVersion: target.version,
			documentId: docId,
			revision: Number(revision),
			requestKey,
		}).catch(() => ({ status: "lost" }) as const);
		if (result.status === "updated") {
			setPending(false);
			onOpenChange(false);
			onSaved({ title: result.template.title, version: result.template.version, updated: true });
			return;
		}
		if (result.status === "lost") {
			setPending(false);
			setError("The connection dropped. Try again: it still makes only one new version.");
			return;
		}
		// Someone else updated or deleted it first: read the templates again, so the list shows where they stand now.
		const now = (await readTemplates()).find((t) => t.id === target.id);
		setPending(false);
		if (result.code === "conflict" && now)
			setError(
				`“${now.title}” changed after you opened this, so nothing was saved. It is now v${now.version}. Update it again to make v${now.version + 1}.`,
			);
		else if (!now) {
			setChosen(null);
			setError(`“${target.title}” was deleted, so nothing was saved. Pick another template.`);
		} else setError(result.message);
	}

	function confirm() {
		if (pending || unsaved) return;
		void (updating ? confirmUpdate() : confirmNew());
	}

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogContent size="md">
				<DialogHeader
					title="Save as template"
					description={
						updating
							? "The template you pick gets this document as its next version. This document stays as it is."
							: "Your church can make new documents from it in New from template. This document stays as it is."
					}
				/>
				<DialogBody className="flex flex-col gap-4">
					{templates?.length ? (
						<SegmentedControl
							label="Save as"
							value={mode}
							onValueChange={(next) => {
								setMode(next);
								setError(null);
							}}
							options={[
								{ value: "new", label: "New template" },
								{ value: "update", label: "Update a template" },
							]}
						/>
					) : null}
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
					{updating && templates ? (
						<>
							<RadioGroup
								aria-label="Template to update"
								value={chosen ?? ""}
								onValueChange={(next) => {
									setChosen(next);
									setError(null);
								}}
								className="max-h-72 gap-0 overflow-y-auto rounded-md px-3 shadow-[0_0_0_1px_var(--ef-line)]"
							>
								{templates.map((t) => (
									<Radio
										key={t.id}
										value={t.id}
										className="shrink-0 border-b border-line last:border-b-0"
										label={
											<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
												<span className="min-w-0 break-words">{t.title}</span>
												<Tag className="h-[22px] px-2 text-xs">v{t.version}</Tag>
											</span>
										}
										description={t.description ?? undefined}
									/>
								))}
							</RadioGroup>
							<p className="text-sm text-text-3 text-pretty">
								{target ? (
									<>
										<span className="font-medium text-ink">“{target.title}”</span> becomes v{target.version + 1}, a copy
										of revision {revision}. Its name and description stay. Documents already made from it keep v
										{target.version}.
									</>
								) : (
									<>Pick the template this document replaces. Documents already made from it keep their version.</>
								)}
							</p>
						</>
					) : (
						<>
							<Field label="Template name">
								<Input
									value={name}
									maxLength={TEMPLATE_NAME_MAX}
									onChange={(event) => setName(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											confirm();
										}
									}}
								/>
							</Field>
							<Field label="Description" optional hint="Shown under the name in New from template.">
								<Textarea
									value={description}
									maxLength={TEMPLATE_DESCRIPTION_MAX}
									rows={3}
									onChange={(event) => setDescription(event.target.value)}
								/>
							</Field>
							<p className="text-sm text-text-3">
								The template copies revision {revision}: its page setup, blocks, tables and images. A document made from
								it fills in your church&apos;s details as they are then.
							</p>
						</>
					)}
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
					<Button
						variant="primary"
						loading={pending}
						disabled={unsaved || saving || (updating && !target)}
						onClick={confirm}
					>
						{updating ? (target ? `Update to v${target.version + 1}` : "Update template") : "Save as template"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
