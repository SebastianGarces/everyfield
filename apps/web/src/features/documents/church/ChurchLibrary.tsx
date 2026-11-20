"use client";

import {
	Add01Icon,
	Archive02Icon,
	ArrowRight01Icon,
	Delete02Icon,
	File02Icon,
	PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	DialogTrigger,
	EmptyState,
	IconButton,
	IntentLink,
	PageHeader,
	SearchInput,
	Spinner,
} from "@everyfield/ui/controls";
import { Pagination, Tag } from "@everyfield/ui/display";
import { Icon, cn } from "@everyfield/ui/foundations";
import type { ChurchSummary, ChurchTemplateSummary } from "@everyfield/contracts/documents";
import type { DocTemplateSummary } from "@everyfield/domain/documents";
import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { createChurchDocument, deleteChurchTemplate, type ChurchActionResult } from "./actions.ts";
import { EditTemplateDialog, type TemplateDetails } from "./EditTemplate.tsx";
import { CLASS_LABEL, formatList, paperText, updatedText } from "./labels.ts";

type Props = {
	documents: ChurchSummary[];
	templates: DocTemplateSummary[];
	churchTemplates: ChurchTemplateSummary[];
	canManage: boolean;
	notice: "deleted" | "archived" | "restored" | null;
};

const NOTICE = {
	deleted: "The document was deleted.",
	archived: "The document was archived. Its revisions and saved exports stay available.",
	restored: "The document was restored. It is back in the library and can be edited again.",
};

export function ChurchLibrary({ documents, templates, churchTemplates, canManage, notice }: Props) {
	return (
		<>
			<PageHeader
				size="xl"
				breadcrumb={[{ label: "Documents", href: "/documents" }, { label: "Church documents" }]}
				title="Church documents"
				subtitle="Your church plant's own copies of Everyfield templates and of your church's templates. Each one previews as the real PDF and downloads as PDF and Word, and a budget as Excel too."
				actions={
					canManage ? (
						<>
							<Button asChild variant="secondary">
								<Link href="/documents/church/archived">
									<Icon icon={Archive02Icon} size={18} />
									Archived documents
								</Link>
							</Button>
							<TemplatePicker templates={templates} churchTemplates={churchTemplates} />
						</>
					) : null
				}
			/>
			{notice ? (
				<p
					role="status"
					className="mb-4 rounded-md bg-surface-raised px-4 py-3 text-md text-text-2 shadow-[0_0_0_1px_var(--ef-line)]"
				>
					{NOTICE[notice]}
				</p>
			) : null}
			{documents.length === 0 ? (
				<Card>
					<EmptyState icon={File02Icon} title="No church documents yet" headingLevel="h2">
						{canManage
							? "Choose New from template to make your church plant's first document."
							: "An Owner or Admin of your church plant makes documents from a template."}
					</EmptyState>
				</Card>
			) : (
				<section aria-labelledby="library-heading">
					<h2 id="library-heading" className="sr-only">
						Your documents
					</h2>
					<ul className="flex flex-col gap-3">
						{documents.map((doc) => (
							<li key={doc.id}>
								<IntentLink
									href={`/documents/church/${doc.id}`}
									className={cn(
										"group flex min-h-11 items-center gap-4 rounded-card bg-surface-raised px-5 py-4",
										"shadow-[0_0_0_1px_var(--ef-line)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--ef-ink)]",
										"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
										"max-app-sm:flex-col max-app-sm:items-start max-app-sm:gap-2",
									)}
								>
									<span className="flex min-w-0 flex-1 flex-col gap-1">
										<span className="text-lg font-medium text-ink text-pretty">{doc.title}</span>
										<span className="text-sm text-text-3">
											from {doc.templateName ?? doc.templateId} v{doc.templateVersion} · {updatedText(doc.updatedAt)}
										</span>
									</span>
									<Tag>{CLASS_LABEL[doc.documentClass]}</Tag>
									<Icon
										icon={ArrowRight01Icon}
										size={18}
										className="text-text-3 transition-transform duration-150 group-hover:translate-x-0.5 max-app-sm:hidden"
									/>
								</IntentLink>
							</li>
						))}
					</ul>
				</section>
			)}
		</>
	);
}

const PAGE_SIZE = 10;

type Choice = {
	group: "church" | "everyfield";
	templateId: string;
	recordId: string | null;
	version: number | null;
	title: string;
	description: string | null;
	documentClass: DocTemplateSummary["documentClass"];
	formats: DocTemplateSummary["formats"];
	page: DocTemplateSummary["page"];
};

const GROUPS = [
	{ group: "church", label: "Your church's templates" },
	{ group: "everyfield", label: "Everyfield templates" },
] as const;

function matching(templates: Choice[], search: string) {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return templates;
	return templates.filter((t) => {
		const text = [t.title, t.description ?? "", CLASS_LABEL[t.documentClass]].join(" ").toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

function TemplatePicker({
	templates,
	churchTemplates,
}: {
	templates: DocTemplateSummary[];
	churchTemplates: ChurchTemplateSummary[];
}) {
	const [open, setOpen] = useState(false);
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [edited, setEdited] = useState<ReadonlyMap<string, TemplateDetails>>(new Map());
	const [message, setMessage] = useState<string | null>(null);
	const [pending, start] = useTransition();
	const [chosen, choosing] = useOptimistic<string | null>(null);
	const keys = useRef<Map<string, string> | null>(null);
	const all: Choice[] = [
		...churchTemplates
			.filter((t) => !removed.has(t.id))
			.map((t) => ({ ...t, ...edited.get(t.id), group: "church" as const, recordId: t.id })),
		...templates.map((t) => ({ ...t, group: "everyfield" as const, templateId: t.id, recordId: null, version: null })),
	];

	function choose(id: string) {
		if (pending) return;
		keys.current ??= new Map();
		const key = keys.current.get(id) ?? crypto.randomUUID();
		keys.current.set(id, key);
		setMessage(null);
		start(async () => {
			choosing(id);
			const result: ChurchActionResult | undefined = await createChurchDocument(id, key).catch(
				(): ChurchActionResult => ({ status: "lost" }),
			);
			if (!result) return;
			setMessage(result.status === "refused" ? result.message : "The connection dropped. Nothing was made. Try again.");
		});
	}

	async function remove(recordId: string) {
		const result = await deleteChurchTemplate(recordId);
		if (result.status === "refused") throw new Error(result.message);
		if (result.status === "lost") throw new Error("The connection dropped. Nothing was deleted. Try again.");
		setRemoved((prior) => new Set(prior).add(recordId));
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (pending) return;
				setOpen(next);
				if (!next) {
					keys.current?.clear();
					setMessage(null);
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="primary" icon={Add01Icon}>
					New from template
				</Button>
			</DialogTrigger>
			<DialogContent size="lg" className="h-[min(800px,calc(100dvh-24px))]">
				<DialogHeader
					title="New from template"
					description="Pick a template. Everyfield copies it for your church plant and fills in your church's details."
				/>
				<PickerList
					all={all}
					chosen={pending ? chosen : null}
					message={message}
					onChoose={choose}
					onRemove={remove}
					onEdited={(recordId, details) => setEdited((prior) => new Map(prior).set(recordId, details))}
				/>
			</DialogContent>
		</Dialog>
	);
}

function PickerList({
	all,
	chosen,
	message,
	onChoose,
	onRemove,
	onEdited,
}: {
	all: Choice[];
	chosen: string | null;
	message: string | null;
	onChoose: (templateId: string) => void;
	onRemove: (recordId: string) => Promise<void>;
	onEdited: (recordId: string, details: TemplateDetails) => void;
}) {
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
	const [saved, setSaved] = useState<string | null>(null);
	const list = useRef<HTMLDivElement>(null);
	const found = matching(all, search);
	const pageCount = Math.ceil(found.length / PAGE_SIZE);
	const shown = found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

	async function remove(recordId: string) {
		await onRemove(recordId);
		setSaved(null);
		setPage((current) => Math.min(current, Math.max(1, Math.ceil((found.length - 1) / PAGE_SIZE))));
	}

	return (
		<>
			<div className="flex-none px-7 pb-4 max-app-sm:px-5">
				<SearchInput
					value={search}
					onChange={(event) => {
						setSearch(event.target.value);
						setPage(1);
					}}
					placeholder="Search templates"
					aria-label="Search templates"
				/>
			</div>
			<DialogBody ref={list} className={cn("flex flex-col gap-6 pt-1", pageCount > 1 ? "pb-4" : "pb-7")}>
				<div role="status" className="empty:hidden">
					{saved ? (
						<p className="rounded-md bg-surface-2 px-4 py-3 text-md text-text-2">
							Saved “<span className="font-medium text-ink">{saved}</span>”. New documents from it take this name.
						</p>
					) : null}
				</div>
				{shown.length === 0 ? <p className="py-6 text-md text-text-2">No template matches “{search.trim()}”.</p> : null}
				{GROUPS.map(({ group, label }) => {
					const items = shown.filter((t) => t.group === group);
					if (!items.length) return null;
					const headed = group === "church" || shown.some((t) => t.group === "church");
					return (
						<section key={group} className="flex flex-col gap-3">
							{headed ? (
								<h3 aria-hidden="true" className="text-sm font-semibold text-text-2">
									{label}
								</h3>
							) : null}
							<ul className="flex flex-col gap-3" aria-label={label}>
								{items.map((t) => {
									const { recordId } = t;
									return (
										<TemplateCard
											key={t.templateId}
											template={t}
											busy={chosen === t.templateId}
											disabled={chosen !== null && chosen !== t.templateId}
											onChoose={() => onChoose(t.templateId)}
											onDelete={recordId ? () => remove(recordId) : null}
											onEdited={
												recordId
													? (details) => {
															onEdited(recordId, details);
															setSaved(details.title);
														}
													: null
											}
										/>
									);
								})}
							</ul>
						</section>
					);
				})}
				{message ? (
					<p role="alert" className="text-md text-magenta-600">
						{message}
					</p>
				) : null}
			</DialogBody>
			<p role="status" className="sr-only">
				{found.length === 1 ? "1 template" : `${found.length} templates`}
			</p>
			{pageCount > 1 ? (
				<div className="flex flex-none flex-wrap items-center justify-between gap-3 px-7 pt-4 pb-6 shadow-[0_-1px_0_var(--ef-line)] max-app-sm:px-5 max-app-sm:pb-5">
					<span className="text-sm text-text-3 tabular-nums">
						Showing {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + shown.length} of {found.length}
					</span>
					<Pagination
						label="Template pages"
						page={page}
						pageCount={pageCount}
						onPageChange={(next) => {
							setPage(next);
							list.current?.scrollTo({ top: 0 });
						}}
					/>
				</div>
			) : null}
		</>
	);
}

function TemplateCard({
	template: t,
	busy,
	disabled,
	onChoose,
	onDelete,
	onEdited,
}: {
	template: Choice;
	busy: boolean;
	disabled: boolean;
	onChoose: () => void;
	onDelete: (() => Promise<void>) | null;
	onEdited: ((details: TemplateDetails) => void) | null;
}) {
	const [editing, setEditing] = useState(false);
	return (
		<li className="relative">
			<button
				type="button"
				onClick={onChoose}
				aria-busy={busy || undefined}
				disabled={disabled}
				className={cn(
					"flex w-full items-start gap-4 rounded-card bg-surface-raised p-4 text-left",
					"shadow-[0_0_0_1px_var(--ef-line)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--ef-ink)]",
					"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
					"disabled:opacity-60",
					onDelete && "pr-26 max-app-sm:pr-16",
				)}
			>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="text-md font-medium text-ink">{t.title}</span>
					{t.description ? <span className="text-sm text-text-2 text-pretty">{t.description}</span> : null}
					<span className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-3">
						{t.group === "church" ? <Tag tone="green">Your church</Tag> : null}
						<Tag>{CLASS_LABEL[t.documentClass]}</Tag>
						<span>
							{t.version === null ? null : `v${t.version} · `}
							{paperText(t.page)} · {formatList(t.formats)}
						</span>
					</span>
				</span>
				{busy ? <Spinner size={18} /> : <Icon icon={ArrowRight01Icon} size={18} className="mt-0.5 text-text-3" />}
			</button>
			{onDelete ? (
				<span className="absolute top-3 right-3 flex gap-2 max-app-sm:flex-col">
					{onEdited && t.recordId ? (
						<>
							<IconButton
								icon={PencilEdit02Icon}
								label={`Edit template ${t.title}`}
								size="sm"
								disabled={disabled}
								onClick={() => setEditing(true)}
							/>
							{editing ? (
								<EditTemplateDialog
									onOpenChange={setEditing}
									templateId={t.recordId}
									details={{ title: t.title, description: t.description }}
									onSaved={onEdited}
								/>
							) : null}
						</>
					) : null}
					<ConfirmDialog
						trigger={
							<IconButton icon={Delete02Icon} label={`Delete template ${t.title}`} size="sm" disabled={disabled} />
						}
						tone="danger"
						title={`Delete the template "${t.title}"?`}
						description="It leaves New from template for everyone in your church plant."
						consequences={[
							"Documents already made from it keep their content, and still open, download and save.",
							"The document it was saved from stays as it is.",
						]}
						confirmLabel="Delete template"
						onConfirm={onDelete}
					/>
				</span>
			) : null}
		</li>
	);
}
