"use client";

import { Add01Icon, ArrowRight01Icon, File02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	DialogTrigger,
	EmptyState,
	IntentLink,
	PageHeader,
	SearchInput,
	Spinner,
} from "@everyfield/ui/controls";
import { Pagination, Tag } from "@everyfield/ui/display";
import { Icon, cn } from "@everyfield/ui/foundations";
import type { ChurchSummary } from "@everyfield/contracts/documents";
import type { DocTemplateSummary } from "@everyfield/domain/documents";
import { useRef, useState, useTransition } from "react";
import { createChurchDocument, type ChurchActionResult } from "./actions.ts";
import { CLASS_LABEL, formatList, paperText, updatedText } from "./labels.ts";

type Props = {
	documents: ChurchSummary[];
	templates: DocTemplateSummary[];
	canManage: boolean;
	deleted: boolean;
};

export function ChurchLibrary({ documents, templates, canManage, deleted }: Props) {
	return (
		<>
			<PageHeader
				size="xl"
				breadcrumb={[{ label: "Documents", href: "/documents" }, { label: "Church documents" }]}
				title="Church documents"
				subtitle="Your church plant's own copies of Everyfield templates. Each one previews as the real PDF and downloads as PDF and Word."
				actions={canManage ? <TemplatePicker templates={templates} /> : null}
			/>
			{deleted ? (
				<p
					role="status"
					className="mb-4 rounded-md bg-surface-raised px-4 py-3 text-md text-text-2 shadow-[0_0_0_1px_var(--ef-line)]"
				>
					The document was deleted.
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
										"group flex min-h-11 cursor-pointer items-center gap-4 rounded-card bg-surface-raised px-5 py-4",
										"shadow-[0_0_0_1px_var(--ef-line)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--ef-ink)]",
										"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
										"max-app-sm:flex-col max-app-sm:items-start max-app-sm:gap-2",
									)}
								>
									<span className="flex min-w-0 flex-1 flex-col gap-1">
										<span className="text-lg font-medium text-ink text-pretty">{doc.title}</span>
										<span className="text-sm text-text-3">
											from {doc.templateId} v{doc.templateVersion} · {updatedText(doc.updatedAt)}
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

/** Templates on one page of the picker. */
const PAGE_SIZE = 10;

/** The templates whose name, description or category holds every word of the search, in their order. */
function matching(templates: DocTemplateSummary[], search: string) {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return templates;
	return templates.filter((t) => {
		const text = [t.title, t.description ?? "", CLASS_LABEL[t.documentClass]].join(" ").toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

/**
 * "New from template": the built-in templates. A search over name, description and category and pages of ten keep a
 * long list easy to browse. Choosing one makes the document and opens its page.
 */
function TemplatePicker({ templates }: { templates: DocTemplateSummary[] }) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
	const list = useRef<HTMLDivElement>(null);
	const found = matching(templates, search);
	const pageCount = Math.ceil(found.length / PAGE_SIZE);
	const shown = found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	const [chosen, setChosen] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [pending, start] = useTransition();
	// One request key for each template while the dialog is open: a double click opens the same document.
	const keys = useRef(new Map<string, string>());

	function choose(id: string) {
		if (pending) return;
		const key = keys.current.get(id) ?? crypto.randomUUID();
		keys.current.set(id, key);
		setChosen(id);
		setMessage(null);
		start(async () => {
			const result: ChurchActionResult | undefined = await createChurchDocument(id, key);
			// A success redirects to the new document and returns nothing here; only a refusal comes back.
			if (!result) return;
			setChosen(null);
			setMessage(result.status === "refused" ? result.message : "The connection dropped. Nothing was made. Try again.");
		});
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (pending) return;
				setOpen(next);
				if (!next) {
					keys.current.clear();
					setMessage(null);
					setSearch("");
					setPage(1);
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="primary" icon={Add01Icon}>
					New from template
				</Button>
			</DialogTrigger>
			{/* One height for every search result, so the centered dialog never moves or shrinks while someone types. */}
			<DialogContent size="lg" className="h-[min(800px,calc(100dvh-24px))]">
				<DialogHeader
					title="New from template"
					description="Pick a template. Everyfield copies it for your church plant and fills in your church's details."
				/>
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
				{/* pt-1 keeps the first card's ring and focus outline inside the scroll area, which clips its edges. */}
				<DialogBody ref={list} className={cn("pt-1", pageCount > 1 ? "pb-4" : "pb-7")}>
					{shown.length === 0 ? (
						<p className="py-6 text-md text-text-2">No template matches “{search.trim()}”.</p>
					) : null}
					<ul className="flex flex-col gap-3" aria-label="Templates">
						{shown.map((t) => {
							const busy = pending && chosen === t.id;
							return (
								<li key={t.id}>
									<button
										type="button"
										onClick={() => choose(t.id)}
										aria-busy={busy || undefined}
										disabled={pending && !busy}
										className={cn(
											"flex w-full cursor-pointer items-start gap-4 rounded-card bg-surface-raised p-4 text-left",
											"shadow-[0_0_0_1px_var(--ef-line)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--ef-ink)]",
											"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
											"disabled:cursor-not-allowed disabled:opacity-60",
										)}
									>
										<span className="flex min-w-0 flex-1 flex-col gap-1">
											<span className="text-md font-medium text-ink">{t.title}</span>
											{t.description ? <span className="text-sm text-text-2 text-pretty">{t.description}</span> : null}
											<span className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-3">
												<Tag>{CLASS_LABEL[t.documentClass]}</Tag>
												<span>
													{paperText(t.page)} · {formatList(t.formats)}
												</span>
											</span>
										</span>
										{busy ? (
											<Spinner size={18} />
										) : (
											<Icon icon={ArrowRight01Icon} size={18} className="mt-0.5 text-text-3" />
										)}
									</button>
								</li>
							);
						})}
					</ul>
					{message ? (
						<p role="alert" className="mt-4 text-md text-magenta-600">
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
			</DialogContent>
		</Dialog>
	);
}
