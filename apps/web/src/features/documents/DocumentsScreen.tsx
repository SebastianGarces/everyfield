"use client";

import { Clock01Icon, Download01Icon, File02Icon, Folder01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	EmptyState,
	Field,
	IntentLink,
	Input,
	PageHeader,
	SearchInput,
	SegmentedControl,
	Skeleton,
	StatePanel,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { MERGE_VALUE_MAX } from "@everyfield/contracts/documents";
import { startTransition, useActionState, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { writeAddress, useAddress } from "../../components/location.ts";
import { createRead, useRead } from "../../components/read.tsx";
import { generateDocument, resolveDocument, type DocumentOutcome } from "./actions.ts";
import { createChurchDocument, type ChurchActionResult } from "./church/actions.ts";
import { PdfPreview } from "./PdfPreview.tsx";
import { Thumbnail } from "./Thumbnail.tsx";
import { RENDER_FAILED, bytesOf, downloadBytes, sharedPreview, type PreviewReply } from "./preview-client.ts";
import {
	CATEGORIES,
	FORMAT_LABEL,
	MERGE_TOO_LONG,
	mergeTooLong,
	SOURCE_LABEL,
	categoryLabel,
	choose,
	churchValues,
	combinedTooLong,
	documentProblem,
	draftsFrom,
	fieldError,
	filterTemplates,
	offeredFormat,
	overridesOf,
	parseQuery,
	phaseText,
	queryHref,
	renderKey,
	type DocumentsQuery,
	type Format,
	type Resolved,
	type Template,
} from "./model.ts";
import { NativeDocuments } from "./native.tsx";
import { SavedHistory, savedDocuments } from "./saved.tsx";

type PreviewState =
	| { kind: "idle" }
	| { kind: "pdf"; bytes: Uint8Array; key: string; brandKit: boolean }
	| { kind: "office" }
	| { kind: "message"; text: string };

type Props = {
	templates: Template[];
	version: string;
	context: Resolved | null;
	canPreview: boolean;
	canEdit: boolean;
	canStore: boolean;
	written: "church" | "account" | null;
	textTemplates: readonly string[];
};

function failureText(code: string, path?: string) {
	if (mergeTooLong(code, path)) return MERGE_TOO_LONG;
	if (code === "unavailable")
		return "Preview uses the church name, the pastor, and the launch date. This account has no current church seat.";
	return RENDER_FAILED;
}

const problemText = (reply: { status: "refused"; code: string; path?: string } | { status: "lost" }) =>
	reply.status === "refused" ? failureText(reply.code, reply.path) : failureText("lost");

type PreviewRequest = {
	templateId: string;
	format: Format;
	overrides: Record<string, string>;
	key: string;
	signature: string;
	failed?: string;
};
type Edits = { templateId: string | null; values: Record<string, string> };
type Note = { edits: Edits; format: Format | null; text: string };
type Job = {
	templateId: string;
	format: Format;
	overrides: Record<string, string>;
	key: string;
	signature: string;
	edits: Edits;
};

const resolutions = createRead(
	(...[templateId, format]: [templateId: string, format: Format, visit: string]) => resolveDocument(templateId, format),
	{ failed: (): DocumentOutcome<Resolved> => ({ status: "lost" }), fresh: Infinity },
);

const previews = createRead(
	(templateId: string, format: Format, overrides: Record<string, string>, key: string) =>
		sharedPreview(key, templateId, format, overrides),
	{ failed: (): PreviewReply => ({ status: "lost" }) },
);

const signatureOf = (templateId: string, format: Format, overrides: Record<string, string>) =>
	`${templateId}:${format}:${JSON.stringify(overrides)}`;

function requestFor(
	template: Template,
	format: Format,
	overrides: Record<string, string>,
	version: string,
	church: Record<string, string>,
): PreviewRequest {
	return {
		templateId: template.id,
		format,
		overrides,
		key: renderKey({ templateId: template.id, version, format, overrides, church }),
		signature: signatureOf(template.id, format, overrides),
	};
}

function missingFields(template: Template, drafts: Record<string, string>) {
	return template.mergeFields.filter((field) => field.required && !(drafts[field.key] ?? "").trim());
}

function openingRequest(
	template: Template,
	format: Format,
	resolved: Resolved,
	version: string,
	church: Record<string, string>,
): PreviewRequest | null {
	const drafts = draftsFrom(resolved);
	if (missingFields(template, drafts).length > 0) return null;
	const overrides = overridesOf(template, drafts, resolved);
	if (combinedTooLong(overrides)) return null;
	return requestFor(template, format, overrides, version, church);
}

const forgetPreview = (request: PreviewRequest | null) =>
	request && previews.forget(request.templateId, request.format, request.overrides, request.key);

export function DocumentsScreen({
	templates,
	version,
	context,
	canPreview,
	canEdit,
	canStore,
	written,
	textTemplates,
}: Props) {
	const address = useAddress();
	const query = parseQuery(address.params);
	const filtered = filterTemplates(templates, query);
	const selected = choose(filtered, query.template);
	const activeFormat = selected
		? offeredFormat(selected, query.template === null || query.template === selected.id ? query.format : null)
		: null;
	const [{ church, visit }] = useState(() => {
		const opened = { church: churchValues(context), visit: crypto.randomUUID() };
		const template = context && templates.find((item) => item.id === context.templateId);
		if (typeof window !== "undefined" && canPreview && context && template)
			resolutions.seed(
				{ status: "ok", value: context },
				context.templateId,
				offeredFormat(template, null),
				opened.visit,
			);
		return opened;
	});
	const [edits, setEdits] = useState<Edits>(() => ({ templateId: selected?.id ?? null, values: {} }));
	const [request, setRequest] = useState<PreviewRequest | null>(() =>
		canPreview && context && selected && activeFormat && context.templateId === selected.id
			? openingRequest(selected, activeFormat, context, version, church)
			: null,
	);
	const opening = useRef<string | null>(null);
	const saveKeys = useRef<Map<string, string>>(null);
	const createKeys = useRef<Map<string, string>>(null);
	const panel = useRef<HTMLElement>(null);
	const [downloading, startDownload] = useTransition();

	const resolution = useRead(
		canPreview && selected ? resolutions : null,
		selected?.id ?? "",
		selected ? offeredFormat(selected, null) : "pdf",
		visit,
	);
	const resolvedNow =
		resolution.value ??
		(resolution.status === "idle" && canPreview && context && context.templateId === selected?.id
			? ({ status: "ok", value: context } as const)
			: undefined);
	const current = resolvedNow?.status === "ok" ? resolvedNow.value : null;

	const drafts = { ...draftsFrom(current), ...(edits.templateId === selected?.id ? edits.values : {}) };
	const overrides = selected ? overridesOf(selected, drafts, current) : {};
	const tooLong = combinedTooLong(overrides);
	const missing = selected && (current || !canPreview) ? missingFields(selected, drafts) : [];
	const ready = Boolean(
		selected &&
		activeFormat &&
		canPreview &&
		current &&
		resolution.status !== "loading" &&
		missing.length === 0 &&
		!tooLong,
	);
	const signature = selected && activeFormat ? signatureOf(selected.id, activeFormat, overrides) : "";

	const shown =
		request && selected && request.templateId === selected.id && request.format === activeFormat ? request : null;
	const reading = shown && !shown.failed ? shown : null;
	const reply = useRead(
		reading ? previews : null,
		reading?.templateId ?? "",
		reading?.format ?? "pdf",
		reading?.overrides ?? {},
		reading?.key ?? "",
	);
	const artifact = reply.value?.status === "ok" ? reply.value.value.artifact : null;
	const bytes = useMemo(() => (artifact ? bytesOf(artifact) : null), [artifact]);
	const preview: PreviewState =
		resolvedNow && resolvedNow.status !== "ok"
			? { kind: "message", text: problemText(resolvedNow) }
			: shown?.failed
				? { kind: "message", text: shown.failed }
				: !shown || reply.value === undefined
					? { kind: "idle" }
					: reply.value.status !== "ok"
						? { kind: "message", text: problemText(reply.value) }
						: !bytes
							? { kind: "message", text: RENDER_FAILED }
							: shown.format !== "pdf"
								? { kind: "office" }
								: { kind: "pdf", bytes, key: shown.signature, brandKit: reply.value.value.brandKit };

	const [saveNote, save, saving] = useActionState(async (_: Note | null, job: Job): Promise<Note> => {
		const result = await generateDocument(job.templateId, job.format, job.overrides, job.key).catch(
			() => ({ status: "lost" }) as const,
		);
		if (result.status !== "ok") {
			if (result.status === "refused" && result.code === "conflict") saveKeys.current?.delete(job.signature);
			return {
				edits: job.edits,
				format: job.format,
				text: documentProblem(
					result.status === "refused" ? result.code : "lost",
					result.status === "refused" ? result.problem : undefined,
					"This file did not save. Nothing was stored.",
				),
			};
		}
		void savedDocuments.refresh();
		return { edits: job.edits, format: job.format, text: `Saved ${result.value.savedTemplateName} for your church.` };
	}, null);

	const [createNote, create, creating] = useActionState(
		async (previous: Note | null, job: Job): Promise<Note | null> => {
			const result: ChurchActionResult | undefined = await createChurchDocument(
				job.templateId,
				job.key,
				job.overrides,
			).catch(() => ({ status: "lost" }) as const);
			if (!result) return previous;
			return {
				edits: job.edits,
				format: null,
				text: result.status === "refused" ? result.message : "The connection dropped. Nothing was made. Try again.",
			};
		},
		null,
	);

	function open(template: Template | null) {
		setEdits({ templateId: template?.id ?? null, values: {} });
		forgetPreview(request);
		setRequest(null);
		opening.current = template?.id ?? null;
		if (!template || !canPreview) return;
		const format = offeredFormat(template, null);
		const before = resolutions.peek(template.id, format, visit)?.value;
		void resolutions.refresh(template.id, format, visit).then((result) => {
			if (opening.current !== template.id) return;
			if (result.status === "ok") {
				const next = openingRequest(template, format, result.value, version, church);
				setRequest((previous) => (previous?.templateId === template.id ? previous : next));
				return;
			}
			if (before?.status !== "ok") return;
			resolutions.patch(() => before, template.id, format, visit);
			setRequest({ ...requestFor(template, format, {}, version, church), failed: problemText(result) });
		});
	}

	function navigate(change: Partial<DocumentsQuery>) {
		const next = { ...query, ...change };
		const nextSelected = choose(filterTemplates(templates, next), next.template);
		if (nextSelected?.id !== selected?.id) {
			next.format = null;
			open(nextSelected ?? null);
		}
		writeAddress(`${queryHref(address.pathname, next)}${window.location.hash}`, { replace: true });
	}

	function select(id: string) {
		navigate({ template: id });
		const node = panel.current;
		if (node && getComputedStyle(node).position !== "sticky") node.scrollIntoView({ block: "start" });
	}

	function runPreview(download: boolean) {
		if (!selected || !activeFormat || !ready) return;
		const next = requestFor(selected, activeFormat, overrides, version, church);
		if (!download) {
			if (request?.key !== next.key) forgetPreview(request);
			setRequest(next);
			return;
		}
		const name = selected.name;
		startDownload(async () => {
			const result = await sharedPreview(next.key, next.templateId, next.format, next.overrides);
			if (result.status === "ok" && result.value.artifact) downloadBytes(name, next.format, result.value.artifact);
			else {
				forgetPreview(request);
				setRequest({ ...next, failed: result.status === "ok" ? RENDER_FAILED : problemText(result) });
			}
		});
	}

	function job(keys: { current: Map<string, string> | null }): Job | null {
		if (!selected || !activeFormat) return null;
		const known = (keys.current ??= new Map());
		const key = known.get(signature) ?? crypto.randomUUID();
		known.set(signature, key);
		return { templateId: selected.id, format: activeFormat, overrides, key, signature, edits };
	}

	function runSave() {
		if (!ready || !canStore) return;
		const next = job(saveKeys);
		if (next) startTransition(() => save(next));
	}

	function runCreate() {
		if (!ready || !canEdit) return;
		const next = job(createKeys);
		if (next) startTransition(() => create(next));
	}

	const searchEmpty = query.q.trim().length > 0 && filtered.length === 0;
	const wikiEmpty = !searchEmpty && filtered.length === 0 && (query.wiki !== null || query.phase !== null);

	return (
		<>
			<PageHeader
				size="xl"
				title="Documents"
				subtitle="Print-ready templates from the Playbook, filled in with your church's details."
				actions={
					<>
						{written === "church" ? (
							<Button variant="secondary" icon={Folder01Icon} asChild>
								<IntentLink href="/documents/church">Church documents</IntentLink>
							</Button>
						) : null}
						<Button variant="secondary" icon={Clock01Icon} asChild>
							<a href="#saved" data-scroll="instant">
								History
							</a>
						</Button>
					</>
				}
			/>
			<section
				aria-labelledby="templates-heading"
				className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(420px,500px)]"
			>
				<h2 id="templates-heading" className="sr-only">
					Templates
				</h2>
				<div className="flex min-w-0 flex-col gap-4">
					<div className="flex flex-col gap-3">
						<SegmentedControl
							wrap
							label="Category"
							value={query.category}
							onValueChange={(next) => navigate({ category: next })}
							options={CATEGORIES.map((item) => ({
								value: item.value,
								label: item.label,
								count: item.value === "all" ? templates.length : undefined,
							}))}
						/>
						<SearchInput
							aria-label="Search templates"
							placeholder="Search templates"
							value={query.q}
							maxLength={80}
							onChange={(event) => navigate({ q: event.target.value })}
						/>
					</div>
					{searchEmpty ? (
						<Card>
							<EmptyState
								icon={Search01Icon}
								title={`No templates for "${query.q.trim()}"`}
								headingLevel="h3"
								action={
									<Button variant="secondary" onClick={() => navigate({ q: "" })}>
										Clear search
									</Button>
								}
							>
								Try another name, or clear the search.
							</EmptyState>
						</Card>
					) : wikiEmpty ? (
						<Card>
							<EmptyState
								icon={File02Icon}
								title="No templates match this article"
								headingLevel="h3"
								action={
									<Button
										variant="secondary"
										onClick={() => navigate({ wiki: null, phase: null, category: "all", q: "" })}
									>
										Show all templates
									</Button>
								}
							>
								The link names an article that has no template in this library.
							</EmptyState>
						</Card>
					) : filtered.length === 0 ? (
						<Card>
							<EmptyState
								icon={File02Icon}
								title="No templates in this category"
								headingLevel="h3"
								action={
									<Button variant="secondary" onClick={() => navigate({ category: "all" })}>
										Show all templates
									</Button>
								}
							>
								Choose another category to see the rest of the library.
							</EmptyState>
						</Card>
					) : (
						<div role="group" aria-label="Templates" className="grid gap-4 sm:grid-cols-2">
							{filtered.map((template) => {
								const pressed = template.id === selected?.id;
								const phase = phaseText(template.phase);
								const thumbnailKey = renderKey({
									templateId: template.id,
									version,
									format: "pdf",
									overrides: {},
									church,
								});
								return (
									<div
										key={template.id}
										className={cn(
											"relative flex min-h-11 flex-col gap-3 rounded-card bg-surface-raised p-3 text-left",
											"transition-shadow duration-150 hover:bg-surface",
											pressed ? "shadow-[0_0_0_2px_var(--ef-ink)]" : "shadow-[0_0_0_1px_var(--ef-line)]",
											"has-[:focus-visible]:shadow-[0_0_0_2px_var(--ef-ink),0_0_0_5px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]",
										)}
									>
										<button
											type="button"
											aria-pressed={pressed}
											aria-labelledby={`template-${template.id}-name`}
											aria-describedby={`template-${template.id}-meta`}
											onClick={() => select(template.id)}
											className="flex flex-col items-stretch gap-3 text-left outline-none after:absolute after:inset-0 after:content-['']"
										>
											<Thumbnail key={thumbnailKey} template={template} renderKey={thumbnailKey} enabled={canPreview} />
											<span id={`template-${template.id}-name`} className="px-2 font-medium text-ink">
												{template.name}
											</span>
										</button>
										<span className="flex flex-col items-start gap-2 px-2 pb-2">
											<span id={`template-${template.id}-meta`} className="text-xs text-text-3">
												{categoryLabel(template.category)}
												{phase ? ` · ${phase}` : ""}
											</span>
											<span className="flex flex-wrap gap-1.5">
												{template.formats.map((item) => (
													<Tag key={item}>{FORMAT_LABEL[item]}</Tag>
												))}
												{template.fillable ? <Tag tone="green">Fillable</Tag> : null}
											</span>
											<span className="line-clamp-3 text-sm text-text-2">{template.description}</span>
										</span>
									</div>
								);
							})}
						</div>
					)}
				</div>
				<aside ref={panel} className="scroll-mt-20 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto">
					<Card className="gap-4">
						{selected && activeFormat ? (
							<TemplatePanel
								template={selected}
								format={activeFormat}
								drafts={drafts}
								resolved={current}
								canPreview={canPreview}
								tooLong={tooLong}
								missing={missing.map((field) => field.key)}
								busy={downloading || resolution.status === "loading" || reply.status === "loading"}
								ready={ready}
								preview={preview}
								stale={preview.kind === "pdf" && preview.key !== signature}
								canStore={canStore}
								saving={saving}
								saveNote={saveNote?.edits === edits && saveNote.format === activeFormat ? saveNote.text : null}
								make={textTemplates.includes(selected.id) && canPreview ? (canEdit ? "both" : "member") : "save"}
								creating={creating}
								createNote={createNote?.edits === edits && !creating ? createNote.text : null}
								onDraft={(key, value) =>
									setEdits((previous) => ({
										templateId: selected.id,
										values: { ...(previous.templateId === selected.id ? previous.values : {}), [key]: value },
									}))
								}
								onFormat={(next) => navigate({ template: selected.id, format: next })}
								onPreview={() => runPreview(false)}
								onDownload={() => runPreview(true)}
								onSave={runSave}
								onCreate={runCreate}
							/>
						) : (
							<EmptyState icon={File02Icon} title="Select a template" headingLevel="h2">
								Choose a template to fill in the church details and preview the file.
							</EmptyState>
						)}
					</Card>
				</aside>
			</section>
			<SavedHistory enabled={canPreview} />
			{written ? <NativeDocuments written={written} canEdit={canEdit} /> : null}
		</>
	);
}

function TemplatePanel({
	template,
	format,
	drafts,
	resolved,
	canPreview,
	canStore,
	tooLong,
	missing,
	busy,
	saving,
	ready,
	preview,
	stale,
	saveNote,
	make,
	creating,
	createNote,
	onDraft,
	onFormat,
	onPreview,
	onDownload,
	onSave,
	onCreate,
}: {
	template: Template;
	format: Format;
	drafts: Record<string, string>;
	resolved: Resolved | null;
	canPreview: boolean;
	canStore: boolean;
	tooLong: boolean;
	missing: string[];
	busy: boolean;
	saving: boolean;
	ready: boolean;
	preview: PreviewState;
	stale: boolean;
	saveNote: string | null;
	make: "save" | "both" | "member";
	creating: boolean;
	createNote: string | null;
	onDraft: (key: string, value: string) => void;
	onFormat: (format: Format) => void;
	onPreview: () => void;
	onDownload: () => void;
	onSave: () => void;
	onCreate: () => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<h2 className="font-title text-title-sm leading-[1.2] tracking-[-0.02em] text-ink text-balance">
				{template.name}
			</h2>
			<div className="flex flex-wrap items-center gap-2">
				{template.formats.length > 1 ? (
					<SegmentedControl
						label="Format"
						size="sm"
						value={format}
						onValueChange={onFormat}
						options={template.formats.map((item) => ({ value: item, label: FORMAT_LABEL[item] }))}
					/>
				) : (
					<Tag>{FORMAT_LABEL[format]}</Tag>
				)}
				{template.fillable ? <Tag tone="green">Fillable</Tag> : null}
			</div>
			{format === "pdf" && template.pageSize ? (
				<div className="flex flex-col gap-2">
					{preview.kind === "pdf" ? (
						<PdfPreview key={preview.key} title={template.name} pageSize={template.pageSize} bytes={preview.bytes} />
					) : preview.kind === "message" ? (
						<StatePanel tone="error" title="Preview unavailable" headingLevel="h3" className="py-8">
							{preview.text}
						</StatePanel>
					) : canPreview ? (
						<div
							role="status"
							aria-busy="true"
							style={{ aspectRatio: `${template.pageSize.width} / ${template.pageSize.height}` }}
							className="relative w-full"
						>
							<span className="sr-only">Loading preview</span>
							<Skeleton shape="block" className="absolute inset-0 rounded-none" />
						</div>
					) : null}
					{preview.kind === "pdf" && (stale || !preview.brandKit) ? (
						<p className="text-sm text-text-2">
							{stale ? "The fields changed. Update the preview to see them. " : ""}
							{preview.brandKit ? "" : "No brand kit yet. Your church name stands in for a logo."}
						</p>
					) : null}
				</div>
			) : null}
			<div className="flex flex-col gap-3">
				{template.mergeFields.map((field) => {
					const value = drafts[field.key] ?? "";
					const known = resolved?.fields.find((item) => item.key === field.key);
					const same = known ? value.trim() === (known.value ?? "").trim() : false;
					const shown =
						value.trim().length === 0
							? null
							: same && known && known.source !== "absent" && known.source !== "override"
								? SOURCE_LABEL[known.source]
								: SOURCE_LABEL.override;
					const invalid = field.required && missing.includes(field.key);
					return (
						<Field
							key={field.key}
							label={field.label}
							hint={shown ?? undefined}
							error={invalid ? fieldError(field.key, field.label) : undefined}
						>
							<Input
								value={value}
								maxLength={MERGE_VALUE_MAX}
								onChange={(event) => onDraft(field.key, event.target.value)}
							/>
						</Field>
					);
				})}
			</div>
			{tooLong ? (
				<p role="status" className="text-sm font-medium text-magenta-600">
					{MERGE_TOO_LONG}
				</p>
			) : null}
			{canPreview ? null : (
				<p className="text-sm text-text-2">
					Preview uses the church name, the pastor, and the launch date. This account has no current church seat.
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button variant="secondary" loading={busy} disabled={!ready} onClick={onPreview}>
					{preview.kind === "pdf" ? "Update preview" : "Preview"}
				</Button>
				<Button variant="secondary" icon={Download01Icon} loading={busy} disabled={!ready} onClick={onDownload}>
					Download {FORMAT_LABEL[format]}
				</Button>
				{canPreview && make === "save" ? (
					<Button variant="primary" loading={saving} disabled={!ready || !canStore} onClick={onSave}>
						Save for your church
					</Button>
				) : null}
			</div>
			{make === "both" ? (
				<section aria-labelledby="make-heading" className="flex flex-col gap-3 border-t border-line pt-4">
					<h3 id="make-heading" className="font-sans text-sm font-medium tracking-normal text-ink">
						Make a document for your church
					</h3>
					<MakeOption
						id="make-save"
						note="Saves a finished PDF in History. It can't be edited."
						button={
							<Button
								variant="primary"
								loading={saving}
								disabled={!ready || !canStore || creating}
								onClick={onSave}
								aria-describedby="make-save"
								className="w-full sm:w-56"
							>
								Save for your church
							</Button>
						}
					/>
					<MakeOption
						id="make-create"
						note="Makes a Church Document you can edit, then export as PDF or Word."
						button={
							<Button
								variant="secondary"
								loading={creating}
								disabled={!ready || saving}
								onClick={onCreate}
								aria-describedby="make-create"
								className="w-full sm:w-56"
							>
								Create Church Document
							</Button>
						}
					/>
				</section>
			) : null}
			{make === "member" ? (
				<p className="text-sm text-text-2">
					An Owner or Admin makes documents from templates. You can preview and download this one.
				</p>
			) : null}
			{createNote ? (
				<p role="status" className="text-sm font-medium text-magenta-600">
					{createNote}
				</p>
			) : null}
			{canPreview && !canStore && make !== "member" ? (
				<p className="text-sm text-text-2">
					Saving for your church is not available right now. A preview download stays on this device.
				</p>
			) : null}
			{saveNote ? (
				<p role="status" className="text-sm text-text-2">
					{saveNote}
				</p>
			) : null}
			{preview.kind === "office" ? (
				<p role="status" className="text-sm text-text-2">
					Excel opens in its own app. Download the file to check it.
				</p>
			) : null}
			{preview.kind === "message" && format !== "pdf" ? (
				<p role="status" className="text-sm text-text-2">
					{preview.text}
				</p>
			) : null}
		</div>
	);
}

function MakeOption({ id, note, button }: { id: string; note: string; button: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
			{button}
			<p id={id} className="text-sm text-text-2 text-pretty">
				{note}
			</p>
		</div>
	);
}
