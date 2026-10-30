"use client";

import { ArrowLeft01Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import { Button, ConfirmDialog, EmptyState, Field, Input, Select } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import { archiveTemplate, createTemplate, deleteTemplate, forkTemplate, updateTemplate } from "./actions.ts";
import { bodyToTextResult, textToBody } from "./body.ts";
import { PreviewStage } from "./EmailFrame.tsx";
import { fieldProblem, fieldProblemText, pickSampleName, usableKeys } from "./fields.ts";
import { MessageEditor } from "./MessageEditor.tsx";
import {
	categoryLabel,
	meetingLabel,
	meetingTypes,
	originLabel,
	outcomeText,
	templateCategories,
	type MeetingType,
	type Template,
	type TemplateCategory,
} from "./model.ts";
import { useKeys } from "./useKeys.ts";

// Templates: a list in two groups, and the editor on the Write layout with the same live preview.

type Fields = {
	name: string;
	description: string;
	category: TemplateCategory;
	meetingType: MeetingType | "";
	subject: string;
	text: string;
	lossy: boolean;
};
type Issues = { name?: string; subject?: string; body?: string; meetingType?: string; form?: string };

const blank = (): Fields => ({
	name: "",
	description: "",
	category: "announcement",
	meetingType: "",
	subject: "",
	text: "",
	lossy: false,
});

function fieldsFrom(template: Template): Fields {
	const body = bodyToTextResult(template.bodyHtml);
	return {
		name: template.name,
		description: template.description ?? "",
		category: template.category,
		meetingType: template.meetingType ?? "",
		subject: template.subject,
		text: body.text,
		lossy: body.lossy,
	};
}

export function Templates({
	templates,
	setTemplates,
	canWrite,
	selected,
	onSelect,
	churchName,
	origin,
}: {
	templates: Template[];
	setTemplates: (next: Template[] | ((rows: Template[]) => Template[])) => void;
	canWrite: boolean;
	/** A template id, "new" or null for the list. It comes from the address. */
	selected: string | null;
	onSelect: (id: string | null) => void;
	churchName: string;
	origin: string;
}) {
	const creating = selected === "new";
	const template = templates.find((t) => t.templateId === selected) ?? null;
	if (!selected) return <TemplateList templates={templates} canWrite={canWrite} onSelect={onSelect} />;
	return (
		<Editor
			key="editor"
			template={template}
			missing={!creating && !template}
			canWrite={canWrite}
			setTemplates={setTemplates}
			onSelect={onSelect}
			churchName={churchName}
			origin={origin}
		/>
	);
}

function TemplateList({
	templates,
	canWrite,
	onSelect,
}: {
	templates: Template[];
	canWrite: boolean;
	onSelect: (id: string | null) => void;
}) {
	const groups: { title: string; rows: Template[] }[] = [
		{ title: "System", rows: templates.filter((t) => t.origin === "system") },
		{ title: "Your church", rows: templates.filter((t) => t.origin !== "system") },
	];
	return (
		<div className="flex flex-col gap-6">
			{canWrite ? (
				<div>
					<Button variant="primary" onClick={() => onSelect("new")}>
						New template
					</Button>
				</div>
			) : null}
			{templates.length === 0 ? (
				<EmptyState icon={Mail01Icon} title="No templates yet">
					Create a template to reuse a message.
				</EmptyState>
			) : null}
			{groups.map((group) => (
				<section key={group.title} aria-label={group.title} className="flex flex-col gap-2">
					<h2 className="font-title text-title-sm tracking-[-0.01em] text-ink">{group.title}</h2>
					{group.rows.length === 0 ? (
						<p className="text-sm text-text-3">No {group.title.toLowerCase()} templates.</p>
					) : (
						<ul className="flex flex-col divide-y divide-line rounded-lg bg-surface">
							{group.rows.map((row) => (
								<li key={row.templateId}>
									<button
										type="button"
										onClick={() => onSelect(row.templateId)}
										className="grid w-full cursor-pointer grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-4 px-5 py-3 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ef-focus)]"
									>
										<span className="truncate font-medium text-ink">{row.name}</span>
										<span className="truncate text-sm text-text-2">{categoryLabel[row.category]}</span>
										<span className="truncate text-sm text-text-2">
											{row.meetingType ? meetingLabel[row.meetingType] : "Any"}
										</span>
										<span className="truncate text-sm text-text-3">{originLabel(row)}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</section>
			))}
		</div>
	);
}

function Editor({
	template,
	missing,
	canWrite,
	setTemplates,
	onSelect,
	churchName,
	origin,
}: {
	template: Template | null;
	/** The address names a template that is not in the list. A save that just replaced the row is not missing. */
	missing: boolean;
	canWrite: boolean;
	setTemplates: (next: Template[] | ((rows: Template[]) => Template[])) => void;
	onSelect: (id: string | null) => void;
	churchName: string;
	origin: string;
}) {
	const keys = useKeys();
	const busy = useRef(false);
	const [fields, setFields] = useState<Fields>(() => (template ? fieldsFrom(template) : blank()));
	const [current, setCurrent] = useState<Template | null>(template);
	const [issues, setIssues] = useState<Issues>({});
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<null | "archive" | "delete">(null);
	const [sample] = useState(pickSampleName);
	if (missing && !current) {
		return (
			<div className="flex flex-col items-start gap-3">
				<p role="alert" className="text-md font-medium text-magenta-600">
					That template is not here. It may have been archived or deleted.
				</p>
				<Button variant="secondary" onClick={() => onSelect(null)}>
					Back to templates
				</Button>
			</div>
		);
	}
	const system = current?.origin === "system";
	const editing = canWrite && !system;
	const invitation = fields.category === "meeting_invitation";

	const run = async (name: string, body: () => Promise<void>) => {
		if (busy.current) return;
		busy.current = true;
		setPending(name);
		setStatus(null);
		try {
			await body();
		} finally {
			busy.current = false;
			setPending(null);
		}
	};

	const keep = (next: Template) => {
		setTemplates((rows) => {
			if (next.sourceKey) return rows.map((row) => (row.sourceKey === next.sourceKey ? next : row));
			return [next, ...rows.filter((row) => row.templateId !== next.templateId)];
		});
		setCurrent(next);
		setFields(fieldsFrom(next));
		onSelect(next.templateId);
	};

	const check = (): Issues => {
		const problem = fieldProblem(fields.text, usableKeys(invitation));
		return {
			name: fields.name.trim() ? undefined : "Enter a template name.",
			subject: fields.subject.includes("{{")
				? "Fields work in the message, not the subject."
				: fields.subject.trim()
					? undefined
					: "Enter a subject.",
			body: problem ? fieldProblemText(problem) : fields.text.trim() ? undefined : "Enter the message.",
			meetingType: invitation && !fields.meetingType ? "Choose the meeting type for an invitation." : undefined,
		};
	};

	const payload = () => ({
		name: fields.name.trim(),
		description: fields.description.trim() ? fields.description.trim() : null,
		category: fields.category,
		meetingType: invitation ? fields.meetingType || null : null,
		subject: fields.subject.trim(),
		bodyHtml: textToBody(fields.text),
	});

	const onSave = () =>
		run("template", async () => {
			const found = check();
			setIssues(found);
			if (found.name || found.subject || found.body || found.meetingType) return;
			if (!current) {
				const result = await createTemplate(keys.take("template"), payload());
				keys.settle("template", result);
				if (result.status !== "ok") return setIssues({ form: outcomeText(result) ?? undefined });
				keep(result.value);
				setStatus("Template created.");
				return;
			}
			const result = await updateTemplate(keys.take("template"), current.revision, current.templateId, payload());
			keys.settle("template", result);
			if (result.status !== "ok") return setIssues({ form: outcomeText(result) ?? undefined });
			keep(result.value);
			setStatus("Template saved.");
		});

	const onFork = () =>
		run("fork", async () => {
			if (!current?.sourceKey) return;
			const result = await forkTemplate(keys.take("fork"), current.sourceKey);
			keys.settle("fork", result);
			if (result.status !== "ok") return setIssues({ form: outcomeText(result) ?? undefined });
			keep(result.value);
			setStatus("Template forked. You can edit the church copy.");
		});

	return (
		<div className="flex flex-col gap-6">
			<div>
				<button
					type="button"
					onClick={() => onSelect(null)}
					className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-md font-medium text-ink-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)]"
				>
					<Icon icon={ArrowLeft01Icon} size={16} />
					Back to templates
				</button>
			</div>
			<h2 className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink">
				{current ? current.name : "New template"}
			</h2>
			{current ? <p className="-mt-4 text-sm text-text-3">{originLabel(current)}</p> : null}
			{system ? (
				<p className="text-md text-text-2">System templates stay as they are. Fork the template to change a copy.</p>
			) : null}
			{status ? (
				<p role="status" className="text-md text-ink">
					{status}
				</p>
			) : null}
			{issues.form ? (
				<p role="alert" className="text-sm font-medium text-magenta-600">
					{issues.form}
				</p>
			) : null}
			<div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-5">
					<Field label="Name" error={issues.name}>
						<Input
							value={fields.name}
							disabled={!editing}
							onChange={(event) => setFields((c) => ({ ...c, name: event.target.value }))}
						/>
					</Field>
					<Field label="Description" optional>
						<Input
							value={fields.description}
							disabled={!editing}
							onChange={(event) => setFields((c) => ({ ...c, description: event.target.value }))}
						/>
					</Field>
					<Field label="Category">
						<Select
							value={fields.category}
							disabled={!editing}
							onValueChange={(value) =>
								setFields((c) => ({
									...c,
									category: value as TemplateCategory,
									meetingType: value === "meeting_invitation" ? c.meetingType : "",
								}))
							}
							options={templateCategories.map((category) => ({ value: category, label: categoryLabel[category] }))}
						/>
					</Field>
					{invitation ? (
						<Field label="Meeting type" error={issues.meetingType}>
							<Select
								value={fields.meetingType || "none"}
								disabled={!editing}
								onValueChange={(value) =>
									setFields((c) => ({ ...c, meetingType: value === "none" ? "" : (value as MeetingType) }))
								}
								options={[
									{ value: "none", label: "Choose a meeting type" },
									...meetingTypes.map((type) => ({ value: type, label: meetingLabel[type] })),
								]}
							/>
						</Field>
					) : null}
					<MessageEditor
						subject={fields.subject}
						onSubject={(subject) => setFields((c) => ({ ...c, subject }))}
						text={fields.text}
						onText={(text) => setFields((c) => ({ ...c, text }))}
						subjectError={issues.subject}
						bodyError={issues.body}
						hasMeeting={invitation}
						disabled={!editing}
						lossy={fields.lossy}
					/>
					{canWrite ? (
						<div className="flex flex-wrap gap-2">
							{system ? (
								<Button
									variant="primary"
									onClick={onFork}
									loading={pending === "fork"}
									disabled={pending !== null && pending !== "fork"}
								>
									Fork template
								</Button>
							) : (
								<Button
									variant="primary"
									onClick={onSave}
									loading={pending === "template"}
									disabled={pending !== null && pending !== "template"}
								>
									Save template
								</Button>
							)}
							{current && !system ? (
								<Button variant="secondary" onClick={() => setConfirm("archive")} disabled={pending !== null}>
									Archive template
								</Button>
							) : null}
							{current && !system ? (
								<Button variant="danger" onClick={() => setConfirm("delete")} disabled={pending !== null}>
									Delete template
								</Button>
							) : null}
						</div>
					) : null}
				</div>
				<PreviewStage
					input={{ bodyHtml: textToBody(fields.text), name: sample, hasMeeting: invitation, origin, churchName }}
					chrome={{ from: churchName, to: sample, subject: fields.subject }}
				/>
			</div>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(open) => {
					if (!open) setConfirm(null);
				}}
				title={confirm === "delete" ? "Delete this template?" : "Archive this template?"}
				description={
					confirm === "delete"
						? "Delete removes a template that no message uses."
						: "An archived template leaves the list. Messages that use it stay as they are."
				}
				consequences={confirm === "delete" ? ["The template is deleted."] : ["The template is archived."]}
				confirmLabel={confirm === "delete" ? "Delete template" : "Archive template"}
				tone={confirm === "delete" ? "danger" : "default"}
				onConfirm={async () => {
					if (!current) throw new Error("Choose a template first.");
					const kind = confirm === "delete" ? "delete" : "archive";
					const result =
						kind === "delete"
							? await deleteTemplate(keys.take("delete"), current.revision, current.templateId)
							: await archiveTemplate(keys.take("archive"), current.revision, current.templateId);
					keys.settle(kind, result);
					if (result.status !== "ok") throw new Error(outcomeText(result) ?? "Unable to update the template.");
					const removed = current.templateId;
					if (result.value.templates) setTemplates(result.value.templates);
					else setTemplates((rows) => rows.filter((row) => row.templateId !== removed));
					setConfirm(null);
					onSelect(null);
				}}
			/>
		</div>
	);
}
