"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Checkbox,
	ConfirmDialog,
	EmptyState,
	Field,
	Input,
	PageHeader,
	SearchInput,
	SegmentedControl,
	Select,
	Textarea,
} from "@everyfield/ui/controls";
import { useEffect, useRef, useState } from "react";
import {
	archiveTemplate,
	createTemplate,
	deleteDraft,
	deleteTemplate,
	forkTemplate,
	previewMessage,
	readMeetingTemplate,
	rescheduleReviewed,
	resolveAudience,
	saveDraft,
	scheduleDraft,
	searchRecipients,
	updateTemplate,
} from "./actions.ts";
import {
	audienceGroups,
	categoryLabel,
	emptyAudience,
	groupLabel,
	meetingLabel,
	meetingTypes,
	originLabel,
	outcomeText,
	stateLabel,
	templateBinding,
	templateCategories,
	type Audience,
	type AudienceSummary,
	type Draft,
	type DraftState,
	type MeetingType,
	type Outcome,
	type PageData,
	type Preview,
	type Template,
	type TemplateCategory,
} from "./model.ts";

// Messages: compose a draft, preview the sanitized message, schedule it, and keep church templates.
// A system template stays in code. A draft stores its source key, never the code id.

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type PersonRef = { id: string; displayName: string; email: string | null };
type DraftForm = {
	communicationId: string | null;
	revision: string | null;
	state: DraftState | "new";
	subject: string;
	bodyHtml: string;
	audience: Audience;
	baseline: Audience;
	templateId: string | null;
	templateSource: string | null;
	people: PersonRef[];
};
type Issues = { subject?: string; body?: string; time?: string; form?: string };
type TemplateFields = {
	name: string;
	description: string;
	category: TemplateCategory;
	meetingType: MeetingType | "";
	subject: string;
	bodyHtml: string;
};
type TemplateIssues = { name?: string; subject?: string; body?: string; meetingType?: string; form?: string };

const copyAudience = (audience: Audience): Audience => ({
	groups: [...audience.groups],
	teamIds: [...audience.teamIds],
	personIds: [...audience.personIds],
});

function blankForm(): DraftForm {
	const audience = emptyAudience();
	return {
		communicationId: null,
		revision: null,
		state: "new",
		subject: "",
		bodyHtml: "",
		audience,
		baseline: copyAudience(audience),
		templateId: null,
		templateSource: null,
		people: [],
	};
}

function formFrom(draft: Draft, previous: PersonRef[] = []): DraftForm {
	const known = new Map(previous.map((person) => [person.id, person]));
	return {
		communicationId: draft.communicationId,
		revision: draft.revision,
		state: draft.state,
		subject: draft.subject ?? "",
		bodyHtml: draft.bodyHtml ?? "",
		audience: copyAudience(draft.audience),
		baseline: copyAudience(draft.audience),
		templateId: draft.templateId,
		templateSource: draft.templateSource,
		people: draft.audience.personIds.map(
			(id) => known.get(id) ?? { id, displayName: "Person on this draft", email: null },
		),
	};
}

function blankTemplate(): TemplateFields {
	return { name: "", description: "", category: "announcement", meetingType: "", subject: "", bodyHtml: "" };
}

function fieldsFrom(template: Template): TemplateFields {
	return {
		name: template.name,
		description: template.description ?? "",
		category: template.category,
		meetingType: template.meetingType ?? "",
		subject: template.subject,
		bodyHtml: template.bodyHtml,
	};
}

function useKeys() {
	const keys = useRef<Record<string, string>>({});
	return {
		take(name: string) {
			return (keys.current[name] ??= crypto.randomUUID());
		},
		settle(name: string, result: Outcome<unknown>) {
			if (result.status !== "lost") keys.current[name] = crypto.randomUUID();
		},
	};
}

function localStamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toInstant(local: string): Date | null {
	if (!local) return null;
	const date = new Date(local);
	return Number.isNaN(date.getTime()) ? null : date;
}

function formatWhen(iso: string): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function listed(items: string[], max = 8): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")}, and ${items.length - max} more`;
}

function toggleId(list: string[], id: string, on: boolean): string[] {
	if (on) return list.includes(id) ? list : [...list, id];
	return list.filter((item) => item !== id);
}

function draftPayload(form: DraftForm) {
	return {
		...(form.communicationId ? { communicationId: form.communicationId } : {}),
		subject: form.subject.trim() ? form.subject.trim() : null,
		bodyHtml: form.bodyHtml.trim() ? form.bodyHtml : null,
		audience: form.audience,
		meetingId: null,
		templateId: form.templateId,
		templateSource: form.templateSource,
	};
}

function templatePayload(fields: TemplateFields) {
	return {
		name: fields.name.trim(),
		description: fields.description.trim() ? fields.description.trim() : null,
		category: fields.category,
		meetingType: fields.category === "meeting_invitation" ? fields.meetingType || null : null,
		subject: fields.subject.trim(),
		bodyHtml: fields.bodyHtml,
	};
}

function templateIssues(fields: TemplateFields): TemplateIssues {
	return {
		name: fields.name.trim() ? undefined : "Enter a template name.",
		subject: fields.subject.trim() ? undefined : "Enter a subject.",
		body: fields.bodyHtml.trim() ? undefined : "Enter the message.",
		meetingType:
			fields.category === "meeting_invitation" && !fields.meetingType
				? "Choose the meeting type for an invitation."
				: undefined,
	};
}

function hasIssue(issues: TemplateIssues): boolean {
	return Boolean(issues.name || issues.subject || issues.body || issues.meetingType || issues.form);
}

export function CommunicationScreen({ data, canWrite }: { data: PageData; canWrite: boolean }) {
	const [tab, setTab] = useState<"compose" | "templates">("compose");
	const [drafts, setDrafts] = useState(data.drafts);
	const [templates, setTemplates] = useState(data.templates);
	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				size="xl"
				title="Messages"
				subtitle="Write a message, choose who receives it, and schedule the email."
			/>
			{canWrite ? null : (
				<p className="text-md text-text-2">You can read messages. An Owner or Admin writes and schedules them.</p>
			)}
			<SegmentedControl
				label="Message sections"
				value={tab}
				onValueChange={setTab}
				options={[
					{ value: "compose", label: "Compose", count: drafts.length },
					{ value: "templates", label: "Templates", count: templates.length },
				]}
			/>
			{tab === "compose" ? (
				<Compose drafts={drafts} setDrafts={setDrafts} templates={templates} teams={data.teams} canWrite={canWrite} />
			) : (
				<Templates templates={templates} setTemplates={setTemplates} canWrite={canWrite} />
			)}
		</div>
	);
}

function Compose({
	drafts,
	setDrafts,
	templates,
	teams,
	canWrite,
}: {
	drafts: Draft[];
	setDrafts: (next: Draft[] | ((rows: Draft[]) => Draft[])) => void;
	templates: Template[];
	teams: PageData["teams"];
	canWrite: boolean;
}) {
	const keys = useKeys();
	const busy = useRef(false);
	const searchSeq = useRef(0);
	const [windowBounds] = useState(() => {
		const now = new Date();
		return { min: localStamp(now), max: localStamp(new Date(now.getTime() + WINDOW_MS)) };
	});
	const [form, setForm] = useState<DraftForm>(blankForm);
	const [issues, setIssues] = useState<Issues>({});
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [sendAt, setSendAt] = useState("");
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PersonRef[]>([]);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [audienceSummary, setAudienceSummary] = useState<AudienceSummary | null>(null);
	const [invite, setInvite] = useState("none");
	const [templatePick, setTemplatePick] = useState("none");
	const [sampleName, setSampleName] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const locked = !canWrite || (form.state !== "new" && form.state !== "draft");

	useEffect(() => {
		if (!canWrite || locked) return;
		const text = query.trim();
		if (!text) return;
		const seq = ++searchSeq.current;
		const timer = setTimeout(() => {
			void searchRecipients(text).then((result) => {
				if (seq !== searchSeq.current || result.status !== "ok") return;
				setResults(result.value.people);
			});
		}, 300);
		return () => clearTimeout(timer);
	}, [query, canWrite, locked]);

	const run = async (name: string, body: () => Promise<void>) => {
		if (busy.current) return;
		busy.current = true;
		setPending(name);
		setIssues({});
		setStatus(null);
		try {
			await body();
		} finally {
			busy.current = false;
			setPending(null);
		}
	};

	const adopt = (draft: Draft, people = form.people) => {
		setDrafts((rows) => [draft, ...rows.filter((row) => row.communicationId !== draft.communicationId)]);
		setForm(formFrom(draft, people));
	};

	const openDraft = (draft: Draft | null) => {
		setForm(draft ? formFrom(draft) : blankForm());
		setIssues({});
		setStatus(null);
		setPreview(null);
		setAudienceSummary(null);
		setSendAt("");
		setQuery("");
		setResults([]);
		setInvite("none");
		setTemplatePick("none");
	};

	const applyTemplate = (template: Template) => {
		const binding = templateBinding(template);
		setForm((current) => ({
			...current,
			subject: template.subject,
			bodyHtml: template.bodyHtml,
			templateId: binding.templateId,
			templateSource: binding.templateSource,
		}));
		setPreview(null);
	};

	const onSave = () =>
		run("save", async () => {
			const result = await saveDraft(keys.take("save"), form.revision, draftPayload(form));
			keys.settle("save", result);
			if (result.status !== "ok") {
				setIssues({ form: outcomeText(result) ?? undefined });
				return;
			}
			adopt(result.value);
			setStatus("Draft saved.");
		});

	const onSchedule = () =>
		run("schedule", async () => {
			const at = toInstant(sendAt);
			if (!at || at.getTime() < Date.now() - 60_000 || at.getTime() > Date.now() + WINDOW_MS) {
				setIssues({ time: "Choose a send time from now through the next 30 days." });
				return;
			}
			const instant = at.toISOString();
			if (form.state === "scheduled" && form.communicationId && form.revision) {
				const moved = await rescheduleReviewed(keys.take("schedule"), form.revision, form.communicationId, instant);
				keys.settle("schedule", moved);
				if (moved.status !== "ok") {
					setIssues({ form: outcomeText(moved) ?? undefined });
					return;
				}
				adopt(moved.value);
				setStatus(`The email is scheduled for ${formatWhen(moved.value.scheduledAt)}. It has not been sent.`);
				return;
			}
			const next: Issues = {};
			if (!form.subject.trim()) next.subject = "Enter a subject.";
			if (!form.bodyHtml.trim()) next.body = "Enter the message.";
			if (form.audience.groups.length + form.audience.teamIds.length + form.audience.personIds.length === 0)
				next.form = "Choose at least one group, team, or person.";
			if (next.subject || next.body || next.form) {
				setIssues(next);
				return;
			}
			if (form.state !== "new" && form.state !== "draft") return;
			const scheduled = await scheduleDraft(
				keys.take("save"),
				keys.take("schedule"),
				form.revision,
				draftPayload(form),
				instant,
			);
			keys.settle("save", scheduled);
			keys.settle("schedule", scheduled);
			if (scheduled.status !== "ok") {
				setIssues({ form: outcomeText(scheduled) ?? undefined });
				return;
			}
			adopt(scheduled.value, form.people);
			setStatus(`The email is scheduled for ${formatWhen(scheduled.value.scheduledAt)}. It has not been sent.`);
		});

	const onPreview = () =>
		run("preview", async () => {
			if (!form.bodyHtml.trim()) {
				setIssues({ body: "Enter the message before you preview it." });
				return;
			}
			const sample = sampleName.trim();
			const input: Record<string, unknown> = {
				bodyHtml: form.bodyHtml,
				merge: sample ? { name: sample } : {},
				audience: form.audience,
				audienceChangedAfterReview:
					(form.state === "reviewed" || form.state === "scheduled") &&
					JSON.stringify(form.audience) !== JSON.stringify(form.baseline),
			};
			if (form.communicationId) input.communicationId = form.communicationId;
			if (form.templateId) input.templateId = form.templateId;
			const result = await previewMessage(input);
			if (result.status !== "ok") {
				setPreview(null);
				setIssues({ form: outcomeText(result) ?? undefined });
				return;
			}
			setPreview(result.value);
		});

	const onAudience = () =>
		run("audience", async () => {
			const result = await resolveAudience(form.audience);
			if (result.status !== "ok") {
				setAudienceSummary(null);
				setIssues({ form: outcomeText(result) ?? undefined });
				return;
			}
			setAudienceSummary(result.value);
		});

	const onInvite = (value: string) => {
		setInvite(value);
		if (value === "none" || locked) return;
		void run("invite", async () => {
			const result = await readMeetingTemplate(value);
			setInvite("none");
			if (result.status !== "ok") {
				setIssues({ form: outcomeText(result) ?? undefined });
				return;
			}
			applyTemplate(result.value);
			setStatus(`Started from ${result.value.name}.`);
		});
	};

	const title = form.state === "new" ? "New message" : form.subject.trim() || "Untitled draft";

	return (
		<div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
			<Card as="section" className="flex flex-col gap-3">
				<CardHeader>
					<CardHeading>
						<CardTitle>Drafts</CardTitle>
					</CardHeading>
				</CardHeader>
				{canWrite ? (
					<Button variant="secondary" onClick={() => openDraft(null)}>
						New message
					</Button>
				) : null}
				{drafts.length === 0 ? (
					<EmptyState icon={Mail01Icon} title="No drafts yet">
						A draft keeps a message until you schedule it.
					</EmptyState>
				) : (
					<ul className="flex flex-col gap-1">
						{drafts.map((draft) => {
							const selected = draft.communicationId === form.communicationId;
							return (
								<li key={draft.communicationId}>
									<button
										type="button"
										aria-current={selected ? "true" : undefined}
										onClick={() => openDraft(draft)}
										className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] aria-[current=true]:bg-surface-2"
									>
										<span className="w-full truncate font-medium text-ink">
											{draft.subject?.trim() || "Untitled draft"}
										</span>
										<span className="text-sm text-text-3">{stateLabel[draft.state]}</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</Card>
			<Card as="section" className="flex min-w-0 flex-col gap-5">
				<CardHeader>
					<CardHeading>
						<CardTitle>{title}</CardTitle>
						<CardDescription>
							{form.state === "new" ? "Not saved yet." : stateLabel[form.state]}
							{form.state === "scheduled" ? " It has not been sent." : ""}
						</CardDescription>
					</CardHeading>
				</CardHeader>
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
				<Field label="Subject" error={issues.subject}>
					<Input
						value={form.subject}
						disabled={locked}
						placeholder="Vision meeting this Thursday"
						onChange={(event) => {
							setForm((current) => ({ ...current, subject: event.target.value }));
							setIssues((current) => ({ ...current, subject: undefined, form: undefined }));
						}}
					/>
				</Field>
				<Field label="Message" hint="HTML the church allows. A merge field looks like {{name}}." error={issues.body}>
					<Textarea
						value={form.bodyHtml}
						disabled={locked}
						rows={8}
						placeholder="<p>Hello {{name}}.</p>"
						onChange={(event) => {
							setForm((current) => ({ ...current, bodyHtml: event.target.value }));
							setPreview(null);
							setIssues((current) => ({ ...current, body: undefined, form: undefined }));
						}}
					/>
				</Field>
				{locked ? null : (
					<div className="grid gap-4 md:grid-cols-2">
						<Field label="Meeting invitation" hint="Fills the subject and message from the invitation template.">
							<Select
								value={invite}
								onValueChange={onInvite}
								disabled={pending !== null}
								options={[
									{ value: "none", label: "Choose an invitation" },
									...meetingTypes.map((type) => ({ value: type, label: meetingLabel[type] })),
								]}
							/>
						</Field>
						<Field label="Start from a template">
							<Select
								value={templatePick}
								disabled={pending !== null}
								onValueChange={(value) => {
									setTemplatePick("none");
									if (value === "none") return;
									const template = templates.find((item) => item.templateId === value);
									if (template) applyTemplate(template);
								}}
								options={[
									{ value: "none", label: "Choose a template" },
									...templates.map((template) => ({ value: template.templateId, label: template.name })),
								]}
							/>
						</Field>
					</div>
				)}
				<fieldset className="flex flex-col gap-4" disabled={locked}>
					<legend className="text-sm font-medium text-ink-2">Audience</legend>
					<div className="grid gap-2 sm:grid-cols-2">
						{audienceGroups.map((group) => (
							<Checkbox
								key={group}
								label={groupLabel[group]}
								checked={form.audience.groups.includes(group)}
								onCheckedChange={(checked) =>
									setForm((current) => ({
										...current,
										audience: {
											...current.audience,
											groups: toggleId(current.audience.groups, group, checked === true),
										},
									}))
								}
							/>
						))}
					</div>
					{canWrite && teams.length > 0 ? (
						<div className="grid gap-2 sm:grid-cols-2">
							{teams.map((team) => (
								<Checkbox
									key={team.id}
									label={team.name}
									checked={form.audience.teamIds.includes(team.id)}
									onCheckedChange={(checked) =>
										setForm((current) => ({
											...current,
											audience: {
												...current.audience,
												teamIds: toggleId(current.audience.teamIds, team.id, checked === true),
											},
										}))
									}
								/>
							))}
						</div>
					) : null}
					{canWrite && !locked && teams.length === 0 ? (
						<p className="text-sm text-text-3">This church has no teams yet.</p>
					) : null}
					{form.people.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{form.people.map((person) => (
								<li key={person.id} className="flex items-center justify-between gap-3">
									<span className="min-w-0 truncate text-md text-ink">
										{person.email ? `${person.displayName} · ${person.email}` : person.displayName}
									</span>
									{locked ? null : (
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												setForm((current) => ({
													...current,
													people: current.people.filter((item) => item.id !== person.id),
													audience: {
														...current.audience,
														personIds: current.audience.personIds.filter((id) => id !== person.id),
													},
												}))
											}
										>
											Remove
										</Button>
									)}
								</li>
							))}
						</ul>
					) : null}
					{locked ? null : (
						<Field label="Find a person" hint="Search by name or email. The list shows 20 people.">
							<SearchInput
								value={query}
								placeholder="Ada or ada@church.org"
								onChange={(event) => {
									const next = event.target.value;
									setQuery(next);
									if (!next.trim()) {
										searchSeq.current += 1;
										setResults([]);
									}
								}}
							/>
						</Field>
					)}
					{!locked && results.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{results.map((person) => (
								<li key={person.id}>
									<Checkbox
										label={person.email ? `${person.displayName} · ${person.email}` : person.displayName}
										checked={form.audience.personIds.includes(person.id)}
										onCheckedChange={(checked) =>
											setForm((current) => {
												const on = checked === true;
												const people = on
													? [...current.people.filter((item) => item.id !== person.id), person]
													: current.people.filter((item) => item.id !== person.id);
												return {
													...current,
													people,
													audience: {
														...current.audience,
														personIds: toggleId(current.audience.personIds, person.id, on),
													},
												};
											})
										}
									/>
								</li>
							))}
						</ul>
					) : null}
				</fieldset>
				{canWrite ? (
					<div className="flex flex-col gap-4">
						<div className="flex flex-wrap gap-2">
							<Button
								variant="secondary"
								onClick={onAudience}
								loading={pending === "audience"}
								disabled={pending !== null && pending !== "audience"}
							>
								Check recipients
							</Button>
						</div>
						{audienceSummary ? (
							<div role="status" className="flex flex-col gap-1 text-sm text-text-2">
								<p>
									{audienceSummary.eligibleRecipients === 1
										? "1 person can receive this email."
										: `${audienceSummary.eligibleRecipients} people can receive this email.`}
								</p>
								<p>
									{audienceSummary.resolvedDistinctPeople === 1
										? "1 person matches the audience."
										: `${audienceSummary.resolvedDistinctPeople} people match the audience.`}
								</p>
								{audienceSummary.missingEmailExclusions.length > 0 ? (
									<p>Missing an email: {listed(audienceSummary.missingEmailExclusions)}.</p>
								) : null}
								{audienceSummary.duplicateAddressesRemoved > 0 ? (
									<p>
										{audienceSummary.duplicateAddressesRemoved === 1
											? "1 duplicate address was removed."
											: `${audienceSummary.duplicateAddressesRemoved} duplicate addresses were removed.`}
									</p>
								) : null}
							</div>
						) : null}
						<Field label="Sample name" optional hint="Fills {{name}} in the preview.">
							<Input value={sampleName} placeholder="Ada" onChange={(event) => setSampleName(event.target.value)} />
						</Field>
						<Button
							variant="secondary"
							onClick={onPreview}
							loading={pending === "preview"}
							disabled={pending !== null && pending !== "preview"}
						>
							Preview message
						</Button>
						{preview ? (
							<div className="flex flex-col gap-3">
								<h3 className="text-sm font-medium text-ink-2">Preview</h3>
								{preview.previewBody ? (
									<div
										className="rounded-md bg-surface-raised px-4 py-3 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-3 [&_ul]:list-disc [&_ul]:pl-5"
										// previewBody is the server sanitizer output.
										dangerouslySetInnerHTML={{ __html: preview.previewBody }}
									/>
								) : (
									<p className="text-sm text-text-2">The preview is empty. Check the message HTML.</p>
								)}
								<p className="text-sm text-text-2">{mailLine(preview.eligibleEmails)}</p>
								{preview.excludedMissingEmail.length > 0 ? (
									<p className="text-sm text-text-2">Missing an email: {listed(preview.excludedMissingEmail)}.</p>
								) : null}
							</div>
						) : null}
						<Field
							label="Send time"
							hint="From now through the next 30 days. Scheduling does not send the email."
							error={issues.time}
						>
							<Input
								type="datetime-local"
								value={sendAt}
								min={windowBounds.min}
								max={windowBounds.max}
								suppressHydrationWarning
								onChange={(event) => {
									setSendAt(event.target.value);
									setIssues((current) => ({ ...current, time: undefined, form: undefined }));
								}}
							/>
						</Field>
						<div className="flex flex-wrap gap-2">
							{locked ? null : (
								<Button
									variant="secondary"
									onClick={onSave}
									loading={pending === "save"}
									disabled={pending !== null && pending !== "save"}
								>
									Save draft
								</Button>
							)}
							<Button
								variant="primary"
								onClick={onSchedule}
								loading={pending === "schedule"}
								disabled={pending !== null && pending !== "schedule"}
							>
								{form.state === "scheduled" ? "Change send time" : "Schedule email"}
							</Button>
							{form.state === "draft" ? (
								<Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={pending !== null}>
									Delete draft
								</Button>
							) : null}
						</div>
					</div>
				) : null}
			</Card>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete this draft?"
				description="The draft is removed."
				consequences={["The draft is deleted."]}
				confirmLabel="Delete draft"
				tone="danger"
				onConfirm={async () => {
					if (!form.communicationId || !form.revision) throw new Error("Save the draft before you delete it.");
					const id = form.communicationId;
					const revision = form.revision;
					const previous = form;
					const snapshot = drafts.find((row) => row.communicationId === id) ?? null;
					setDrafts((rows) => rows.filter((row) => row.communicationId !== id));
					openDraft(null);
					setStatus("Draft deleted.");
					const result = await deleteDraft(keys.take("delete"), revision, id);
					keys.settle("delete", result);
					if (result.status !== "ok") {
						if (snapshot) setDrafts((rows) => [snapshot, ...rows.filter((row) => row.communicationId !== id)]);
						setForm(previous);
						setStatus(null);
						throw new Error(outcomeText(result) ?? "Unable to delete the draft.");
					}
				}}
			/>
		</div>
	);
}

function mailLine(emails: string[]): string {
	if (emails.length === 0) return "No one can receive this email yet.";
	const noun = emails.length === 1 ? "person" : "people";
	if (emails.length > 5) return `${emails.length} ${noun} can receive this email.`;
	return `${emails.length} ${noun} can receive this email: ${emails.join(", ")}.`;
}

function Templates({
	templates,
	setTemplates,
	canWrite,
}: {
	templates: Template[];
	setTemplates: (next: Template[] | ((rows: Template[]) => Template[])) => void;
	canWrite: boolean;
}) {
	const keys = useKeys();
	const busy = useRef(false);
	const [selected, setSelected] = useState<Template | null>(null);
	const [creating, setCreating] = useState(false);
	const [fields, setFields] = useState<TemplateFields>(blankTemplate);
	const [issues, setIssues] = useState<TemplateIssues>({});
	const [status, setStatus] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<null | "archive" | "delete">(null);
	const system = selected?.origin === "system";
	const editing = canWrite && (creating || (selected !== null && !system));

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

	const keep = (template: Template) => {
		setTemplates((rows) => {
			if (template.sourceKey) return rows.map((row) => (row.sourceKey === template.sourceKey ? template : row));
			return [template, ...rows.filter((row) => row.templateId !== template.templateId)];
		});
		setSelected(template);
		setCreating(false);
		setFields(fieldsFrom(template));
	};

	const choose = (template: Template) => {
		setCreating(false);
		setSelected(template);
		setFields(fieldsFrom(template));
		setIssues({});
		setStatus(null);
	};

	const onSave = () =>
		run("template", async () => {
			const found = templateIssues(fields);
			if (hasIssue(found)) {
				setIssues(found);
				return;
			}
			const patch = templatePayload(fields);
			if (creating) {
				const result = await createTemplate(keys.take("template"), patch);
				keys.settle("template", result);
				if (result.status !== "ok") {
					setIssues({ form: outcomeText(result) ?? undefined });
					return;
				}
				keep(result.value);
				setStatus("Template created.");
				return;
			}
			if (!selected) return;
			const result = await updateTemplate(keys.take("template"), selected.revision, selected.templateId, patch);
			keys.settle("template", result);
			if (result.status !== "ok") {
				setIssues({ form: outcomeText(result) ?? undefined });
				return;
			}
			keep(result.value);
			setStatus("Template saved.");
		});

	const onFork = () =>
		run("fork", async () => {
			if (!selected?.sourceKey) return;
			const result = await forkTemplate(keys.take("fork"), selected.sourceKey);
			keys.settle("fork", result);
			if (result.status !== "ok") {
				setIssues({ form: outcomeText(result) ?? undefined });
				return;
			}
			keep(result.value);
			setStatus("Template forked. You can edit the church copy.");
		});

	return (
		<div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
			<Card as="section" className="flex flex-col gap-3">
				<CardHeader>
					<CardHeading>
						<CardTitle>Templates</CardTitle>
					</CardHeading>
				</CardHeader>
				{canWrite ? (
					<Button
						variant="secondary"
						onClick={() => {
							setCreating(true);
							setSelected(null);
							setFields(blankTemplate());
							setIssues({});
							setStatus(null);
						}}
					>
						Create template
					</Button>
				) : null}
				{templates.length === 0 ? (
					<EmptyState icon={Mail01Icon} title="No templates yet">
						Create a template to reuse a message.
					</EmptyState>
				) : (
					<ul className="flex flex-col gap-1">
						{templates.map((template) => {
							const current = !creating && selected?.templateId === template.templateId;
							return (
								<li key={template.templateId}>
									<button
										type="button"
										aria-current={current ? "true" : undefined}
										onClick={() => choose(template)}
										className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] aria-[current=true]:bg-surface-2"
									>
										<span className="w-full truncate font-medium text-ink">{template.name}</span>
										<span className="text-sm text-text-3">
											{originLabel(template)} · {categoryLabel[template.category]}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</Card>
			<Card as="section" className="flex min-w-0 flex-col gap-5">
				{status ? (
					<p role="status" className="text-md text-ink">
						{status}
					</p>
				) : null}
				{!creating && !selected ? (
					<EmptyState icon={Mail01Icon} title="Choose a template">
						{canWrite ? "Select a template, or create one for this church." : "Select a template to read it."}
					</EmptyState>
				) : (
					<>
						<CardHeader>
							<CardHeading>
								<CardTitle>{creating ? "New template" : fields.name || "Template"}</CardTitle>
								{selected ? <CardDescription>{originLabel(selected)}</CardDescription> : null}
							</CardHeading>
						</CardHeader>
						{system ? (
							<p className="text-md text-text-2">
								System templates stay as they are. Fork the template to change a copy.
							</p>
						) : null}
						{issues.form ? (
							<p role="alert" className="text-sm font-medium text-magenta-600">
								{issues.form}
							</p>
						) : null}
						<Field label="Name" error={issues.name}>
							<Input
								value={fields.name}
								disabled={!editing}
								onChange={(event) => setFields((current) => ({ ...current, name: event.target.value }))}
							/>
						</Field>
						<Field label="Description" optional>
							<Input
								value={fields.description}
								disabled={!editing}
								onChange={(event) => setFields((current) => ({ ...current, description: event.target.value }))}
							/>
						</Field>
						<Field label="Category">
							<Select
								value={fields.category}
								disabled={!editing}
								onValueChange={(value) =>
									setFields((current) => ({
										...current,
										category: value as TemplateCategory,
										meetingType: value === "meeting_invitation" ? current.meetingType : "",
									}))
								}
								options={templateCategories.map((category) => ({ value: category, label: categoryLabel[category] }))}
							/>
						</Field>
						{fields.category === "meeting_invitation" ? (
							<Field label="Meeting type" error={issues.meetingType}>
								<Select
									value={fields.meetingType || "none"}
									disabled={!editing}
									onValueChange={(value) =>
										setFields((current) => ({
											...current,
											meetingType: value === "none" ? "" : (value as MeetingType),
										}))
									}
									options={[
										{ value: "none", label: "Choose a meeting type" },
										...meetingTypes.map((type) => ({ value: type, label: meetingLabel[type] })),
									]}
								/>
							</Field>
						) : null}
						<Field label="Subject" error={issues.subject}>
							<Input
								value={fields.subject}
								disabled={!editing}
								onChange={(event) => setFields((current) => ({ ...current, subject: event.target.value }))}
							/>
						</Field>
						<Field
							label="Message"
							hint="HTML the church allows. A merge field looks like {{name}}."
							error={issues.body}
						>
							<Textarea
								value={fields.bodyHtml}
								disabled={!editing}
								rows={8}
								onChange={(event) => setFields((current) => ({ ...current, bodyHtml: event.target.value }))}
							/>
						</Field>
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
								) : null}
								{editing ? (
									<Button
										variant="primary"
										onClick={onSave}
										loading={pending === "template"}
										disabled={pending !== null && pending !== "template"}
									>
										Save template
									</Button>
								) : null}
								{selected && !system ? (
									<Button variant="secondary" onClick={() => setConfirm("archive")} disabled={pending !== null}>
										Archive template
									</Button>
								) : null}
								{selected && !system ? (
									<Button variant="danger" onClick={() => setConfirm("delete")} disabled={pending !== null}>
										Delete template
									</Button>
								) : null}
							</div>
						) : null}
					</>
				)}
			</Card>
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
					if (!selected) throw new Error("Choose a template first.");
					const kind = confirm === "delete" ? "delete" : "archive";
					const result =
						kind === "delete"
							? await deleteTemplate(keys.take("delete"), selected.revision, selected.templateId)
							: await archiveTemplate(keys.take("archive"), selected.revision, selected.templateId);
					keys.settle(kind, result);
					if (result.status !== "ok") throw new Error(outcomeText(result) ?? "Unable to update the template.");
					const removedId = selected.templateId;
					if (result.value.templates) setTemplates(result.value.templates);
					else setTemplates((rows) => rows.filter((row) => row.templateId !== removedId));
					setSelected(null);
					setCreating(false);
					setConfirm(null);
					setStatus(kind === "delete" ? "Template deleted." : "Template archived.");
				}}
			/>
		</div>
	);
}
