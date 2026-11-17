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
import { useId, useState, useTransition, type FormEvent } from "react";
import { createRead, useRead } from "../../../../components/read.tsx";
import { listChurchTemplates, saveChurchTemplate, updateChurchTemplate } from "../actions.ts";

export const churchTemplates = createRead(
	() => listChurchTemplates().then((result) => (result.status === "ok" ? result.templates : [])),
	{ failed: (): ChurchTemplateSummary[] => [] },
);

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
	requestKey,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	docId: string;
	title: string;
	revision: string;
	unsaved: boolean;
	saving: boolean;
	onSaveFirst: () => Promise<boolean>;
	onSaved: (saved: TemplateSaved) => void;
	requestKey: string;
}) {
	const [mode, setMode] = useState<"new" | "update">("new");
	const templates = useRead(churchTemplates).value ?? null;
	const [chosen, setChosen] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, start] = useTransition();
	const formId = useId();

	const target = templates?.find((t) => t.id === chosen) ?? null;
	const updating = mode === "update" && (templates?.length ?? 0) > 0;

	function change(next: boolean) {
		if (!pending) onOpenChange(next);
	}

	async function saveFirst() {
		setError(null);
		if (!(await onSaveFirst())) setError("Your changes did not save. Nothing was made. Try again.");
	}

	async function confirmNew(name: string, description: string) {
		const result = await saveChurchTemplate({
			documentId: docId,
			revision: Number(revision),
			name,
			description,
			requestKey,
		}).catch(() => ({ status: "lost" }) as const);
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

	async function confirmUpdate(picked: ChurchTemplateSummary) {
		const result = await updateChurchTemplate({
			templateId: picked.id,
			expectedVersion: picked.version,
			documentId: docId,
			revision: Number(revision),
			requestKey,
		}).catch(() => ({ status: "lost" }) as const);
		if (result.status === "updated") {
			onOpenChange(false);
			onSaved({ title: result.template.title, version: result.template.version, updated: true });
			return;
		}
		if (result.status === "lost") {
			setError("The connection dropped. Try again: it still makes only one new version.");
			return;
		}
		const now = (await churchTemplates.refresh()).find((t) => t.id === picked.id);
		if (result.code === "conflict" && now)
			setError(
				`“${now.title}” changed after you opened this, so nothing was saved. It is now v${now.version}. Update it again to make v${now.version + 1}.`,
			);
		else if (!now) {
			setChosen(null);
			setError(`“${picked.title}” was deleted, so nothing was saved. Pick another template.`);
		} else setError(result.message);
	}

	function confirm(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || unsaved) return;
		if (updating) {
			if (!target) return setError("Pick the template to update.");
			setError(null);
			return start(() => confirmUpdate(target));
		}
		const form = new FormData(event.currentTarget);
		const name = String(form.get("name") ?? "").trim();
		if (!name) return setError("Give the template a name.");
		setError(null);
		start(() => confirmNew(name, String(form.get("description") ?? "").trim()));
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
				<form id={formId} className="contents" onSubmit={confirm}>
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
											<span className="font-medium text-ink">“{target.title}”</span> becomes v{target.version + 1}, a
											copy of revision {revision}. Its name and description stay. Documents already made from it keep v
											{target.version}.
										</>
									) : (
										<>Pick the template this document replaces. Documents already made from it keep their version.</>
									)}
								</p>
							</>
						) : null}
						<div className={updating ? "hidden" : "flex flex-col gap-4"}>
							<Field label="Template name">
								<Input name="name" defaultValue={title} maxLength={TEMPLATE_NAME_MAX} />
							</Field>
							<Field label="Description" optional hint="Shown under the name in New from template.">
								<Textarea name="description" maxLength={TEMPLATE_DESCRIPTION_MAX} rows={3} />
							</Field>
							<p className="text-sm text-text-3">
								The template copies revision {revision}: its page setup, blocks, tables and images. A document made from
								it fills in your church&apos;s details as they are then.
							</p>
						</div>
						<div aria-live="assertive" className="empty:hidden">
							{error ? (
								<p className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
									<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
									{error}
								</p>
							) : null}
						</div>
					</DialogBody>
				</form>
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
						type="submit"
						form={formId}
					>
						{updating ? (target ? `Update to v${target.version + 1}` : "Update template") : "Save as template"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
