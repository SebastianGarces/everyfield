"use client";

import { Clock01Icon, Download01Icon, File02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	EmptyState,
	Field,
	Input,
	PageHeader,
	SearchInput,
	SegmentedControl,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState, useTransition } from "react";
import { previewDocument, resolveDocument } from "./actions.ts";
import {
	CATEGORIES,
	FORMAT_LABEL,
	MIME,
	SOURCE_LABEL,
	categoryLabel,
	choose,
	combinedTooLong,
	draftsFrom,
	fieldError,
	fileName,
	filterTemplates,
	offeredFormat,
	overridesOf,
	phaseText,
	type DocumentsQuery,
	type Format,
	type Resolved,
	type Template,
} from "./model.ts";

// The documents library and the side-effect-free preview. Saved history is a later package, so this page does not
// invent rows. A download of preview bytes is not a saved copy.

type PreviewState =
	{ kind: "idle" } | { kind: "pdf"; url: string } | { kind: "office" } | { kind: "message"; text: string };

type Props = {
	templates: Template[];
	query: DocumentsQuery;
	context: Resolved | null;
	canPreview: boolean;
};

function bytesOf(encoded: string) {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function downloadBytes(name: string, format: Format, encoded: string) {
	const url = URL.createObjectURL(new Blob([bytesOf(encoded)], { type: MIME[format] }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName(name, format);
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

function failureText(code: string, problem?: string) {
	if (code === "invalid_input" && problem?.toLowerCase().includes("16"))
		return "Shorten the fields. Together they must stay under 16 KB.";
	if (code === "unavailable")
		return "Preview uses the church name, the pastor, and the launch date. This account has no current church seat.";
	return "This file did not render. Nothing was saved.";
}

export function DocumentsScreen({ templates, query, context, canPreview }: Props) {
	const initial = filterTemplates(templates, query);
	const [category, setCategory] = useState(query.category);
	const [wiki, setWiki] = useState(query.wiki);
	const [phase, setPhase] = useState(query.phase);
	const [q, setQ] = useState(query.q);
	const [selectedId, setSelectedId] = useState<string | null>(choose(initial, query.template)?.id ?? null);
	const [resolved, setResolved] = useState<Resolved | null>(context);
	const [resolvedFor, setResolvedFor] = useState<string | null>(context?.templateId ?? null);
	const [drafts, setDrafts] = useState<Record<string, string>>(() => draftsFrom(context));
	const [format, setFormat] = useState<Format | null>(() => {
		const chosen = choose(initial, query.template);
		return chosen ? offeredFormat(chosen, context?.format ?? query.format) : null;
	});
	const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
	const [artifact, setArtifact] = useState<{ key: string; format: Format; bytes: string } | null>(null);
	const [resolving, startResolve] = useTransition();
	const [previewing, startPreview] = useTransition();
	const previewUrl = useRef<string | null>(null);
	const resolveToken = useRef(0);

	function revokePreview() {
		if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
		previewUrl.current = null;
	}

	const filtered = filterTemplates(templates, { category, wiki, phase, q });
	const visibleId = filtered.some((template) => template.id === selectedId) ? selectedId : (filtered[0]?.id ?? null);
	const selected = filtered.find((template) => template.id === visibleId) ?? null;
	const activeFormat = selected ? offeredFormat(selected, format) : null;
	const current = resolved?.templateId === selected?.id ? resolved : null;

	useEffect(() => {
		if (!visibleId || !canPreview || resolvedFor === visibleId) return;
		const template = templates.find((item) => item.id === visibleId);
		if (!template) return;
		const token = ++resolveToken.current;
		const nextFormat = offeredFormat(template, null);
		startResolve(async () => {
			const result = await resolveDocument(template.id, nextFormat);
			if (token !== resolveToken.current) return;
			if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
			previewUrl.current = null;
			setArtifact(null);
			setResolvedFor(template.id);
			if (result.status !== "ok") {
				setResolved(null);
				setDrafts({});
				setPreview({
					kind: "message",
					text: failureText(
						result.status === "refused" ? result.code : "lost",
						result.status === "refused" ? result.problem : undefined,
					),
				});
				return;
			}
			setResolved(result.value);
			setDrafts(draftsFrom(result.value));
			setFormat(result.value.format);
			setPreview({ kind: "idle" });
		});
	}, [visibleId, canPreview, resolvedFor, templates]);

	useEffect(
		() => () => {
			if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
		},
		[],
	);

	function showBytes(nextFormat: Format, encoded: string) {
		revokePreview();
		if (nextFormat !== "pdf") {
			setPreview({ kind: "office" });
			return;
		}
		const url = URL.createObjectURL(new Blob([bytesOf(encoded)], { type: MIME.pdf }));
		previewUrl.current = url;
		setPreview({ kind: "pdf", url });
	}

	const overrides = selected ? overridesOf(selected, drafts, current) : {};
	const tooLong = combinedTooLong(overrides);
	const missing = selected
		? selected.mergeFields.filter((field) => field.required && !(drafts[field.key] ?? "").trim())
		: [];
	const ready = Boolean(selected && activeFormat && canPreview && missing.length === 0 && !tooLong);
	const signature = `${selected?.id ?? ""}:${activeFormat ?? ""}:${JSON.stringify(overrides)}`;

	function runPreview(download: boolean) {
		if (!selected || !activeFormat || !ready) return;
		if (!download && artifact?.key === signature && artifact.format === activeFormat) {
			showBytes(activeFormat, artifact.bytes);
			return;
		}
		const template = selected;
		const nextFormat = activeFormat;
		startPreview(async () => {
			const result = await previewDocument(template.id, nextFormat, overrides);
			if (result.status !== "ok") {
				setPreview({
					kind: "message",
					text: failureText(
						result.status === "refused" ? result.code : "lost",
						result.status === "refused" ? result.problem : undefined,
					),
				});
				return;
			}
			setResolved(result.value);
			if (!result.value.artifact) {
				setPreview({ kind: "message", text: "This file did not render. Nothing was saved." });
				return;
			}
			setArtifact({ key: signature, format: nextFormat, bytes: result.value.artifact });
			if (download) downloadBytes(template.name, nextFormat, result.value.artifact);
			else showBytes(nextFormat, result.value.artifact);
		});
	}

	const searchEmpty = q.trim().length > 0 && filtered.length === 0;
	const wikiEmpty = !searchEmpty && filtered.length === 0 && (wiki !== null || phase !== null);

	return (
		<>
			<PageHeader
				size="xl"
				title="Documents"
				subtitle="Print-ready templates from the Playbook, filled in with your church's details."
				actions={
					<Button variant="secondary" icon={Clock01Icon} asChild>
						<a href="#saved">History</a>
					</Button>
				}
			/>
			<section
				aria-labelledby="templates-heading"
				className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]"
			>
				<h2 id="templates-heading" className="sr-only">
					Templates
				</h2>
				<div className="flex min-w-0 flex-col gap-4">
					<div className="flex flex-col gap-3">
						<SegmentedControl
							label="Category"
							value={category}
							onValueChange={(next) => setCategory(next)}
							options={CATEGORIES.map((item) => ({
								value: item.value,
								label: item.label,
								count: item.value === "all" ? templates.length : undefined,
							}))}
						/>
						<SearchInput
							aria-label="Search templates"
							placeholder="Search templates"
							value={q}
							onChange={(event) => setQ(event.target.value)}
						/>
					</div>
					{searchEmpty ? (
						<Card>
							<EmptyState
								icon={Search01Icon}
								title={`No templates for "${q.trim()}"`}
								headingLevel="h3"
								action={
									<Button variant="secondary" onClick={() => setQ("")}>
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
										onClick={() => {
											setWiki(null);
											setPhase(null);
											setCategory("all");
											setQ("");
										}}
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
									<Button variant="secondary" onClick={() => setCategory("all")}>
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
								return (
									<button
										key={template.id}
										type="button"
										aria-pressed={pressed}
										onClick={() => setSelectedId(template.id)}
										className={cn(
											"flex min-h-11 cursor-pointer flex-col items-start gap-2 rounded-card bg-surface-raised px-5 py-5 text-left",
											"transition-shadow duration-150 hover:bg-surface",
											pressed ? "shadow-[0_0_0_2px_var(--ef-ink)]" : "shadow-[0_0_0_1px_var(--ef-line)]",
											"focus-visible:shadow-[0_0_0_2px_var(--ef-ink),0_0_0_5px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)] focus-visible:outline-none",
										)}
									>
										<p className="text-xs text-text-3">
											{categoryLabel(template.category)}
											{phase ? ` · ${phase}` : ""}
										</p>
										<span className="flex flex-wrap gap-1.5">
											{template.formats.map((item) => (
												<Tag key={item}>{FORMAT_LABEL[item]}</Tag>
											))}
										</span>
										<span className="font-medium text-ink">{template.name}</span>
										<span className="line-clamp-3 text-sm text-text-2">{template.description}</span>
									</button>
								);
							})}
						</div>
					)}
				</div>
				<aside className="lg:sticky lg:top-24">
					<Card className="gap-4">
						{selected && activeFormat ? (
							<TemplatePanel
								template={selected}
								format={activeFormat}
								drafts={drafts}
								resolved={resolved?.templateId === selected.id ? resolved : null}
								canPreview={canPreview}
								tooLong={tooLong}
								missing={missing.map((field) => field.key)}
								busy={previewing || resolving}
								ready={ready}
								preview={preview}
								onDraft={(key, value) => {
									setDrafts((current) => ({ ...current, [key]: value }));
									setArtifact(null);
									if (preview.kind !== "idle") setPreview({ kind: "idle" });
								}}
								onFormat={(next) => {
									setFormat(next);
									setArtifact(null);
									revokePreview();
									setPreview({ kind: "idle" });
								}}
								onPreview={() => runPreview(false)}
								onDownload={() => runPreview(true)}
							/>
						) : (
							<EmptyState icon={File02Icon} title="Select a template" headingLevel="h2">
								Choose a template to fill in the church details and preview the file.
							</EmptyState>
						)}
					</Card>
				</aside>
			</section>
			<section id="saved" aria-labelledby="saved-heading" className="mt-8 scroll-mt-24">
				<Card>
					<h2 id="saved-heading" className="font-title text-title-sm tracking-[-0.02em] text-ink">
						Saved for your church
					</h2>
					<EmptyState icon={Clock01Icon} title="Nothing saved for your church yet." headingLevel="h3">
						A preview download stays on this device. It is not saved here.
					</EmptyState>
				</Card>
			</section>
		</>
	);
}

function TemplatePanel({
	template,
	format,
	drafts,
	resolved,
	canPreview,
	tooLong,
	missing,
	busy,
	ready,
	preview,
	onDraft,
	onFormat,
	onPreview,
	onDownload,
}: {
	template: Template;
	format: Format;
	drafts: Record<string, string>;
	resolved: Resolved | null;
	canPreview: boolean;
	tooLong: boolean;
	missing: string[];
	busy: boolean;
	ready: boolean;
	preview: PreviewState;
	onDraft: (key: string, value: string) => void;
	onFormat: (format: Format) => void;
	onPreview: () => void;
	onDownload: () => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<h2 className="font-title text-title-sm leading-[1.2] tracking-[-0.02em] text-ink text-balance">
				{template.name}
			</h2>
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
							<Input value={value} maxLength={2000} onChange={(event) => onDraft(field.key, event.target.value)} />
						</Field>
					);
				})}
			</div>
			{tooLong ? (
				<p role="status" className="text-sm font-medium text-magenta-600">
					Shorten the fields. Together they must stay under 16 KB.
				</p>
			) : null}
			{canPreview ? null : (
				<p className="text-sm text-text-2">
					Preview uses the church name, the pastor, and the launch date. This account has no current church seat.
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button variant="secondary" loading={busy} disabled={!ready} onClick={onPreview}>
					Preview
				</Button>
				<Button variant="primary" icon={Download01Icon} loading={busy} disabled={!ready} onClick={onDownload}>
					Download {FORMAT_LABEL[format]}
				</Button>
			</div>
			{preview.kind === "message" ? (
				<p role="status" className="text-sm text-text-2">
					{preview.text}
				</p>
			) : null}
			{preview.kind === "office" ? (
				<p role="status" className="text-sm text-text-2">
					Word and Excel open in their own apps. Download the file to check it.
				</p>
			) : null}
			{preview.kind === "pdf" ? (
				<iframe title="PDF preview" src={preview.url} className="h-56 w-full rounded-md bg-surface-2" />
			) : null}
		</div>
	);
}
