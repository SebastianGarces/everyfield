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
	Spinner,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { Icon, cn } from "@everyfield/ui/foundations";
import type { DocTemplateSummary } from "@everyfield/domain/documents";
import { useRef, useState, useTransition } from "react";
import { createChurchDocument, type ChurchActionResult } from "./actions.ts";
import { CLASS_LABEL, formatList, paperText, updatedText } from "./labels.ts";
import type { LibraryEntry } from "./server.ts";

type Props = {
	documents: LibraryEntry[];
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

/** "New from template": the built-in templates. Choosing one makes the document and opens its page. */
function TemplatePicker({ templates }: { templates: DocTemplateSummary[] }) {
	const [open, setOpen] = useState(false);
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
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="primary" icon={Add01Icon}>
					New from template
				</Button>
			</DialogTrigger>
			<DialogContent size="lg">
				<DialogHeader
					title="New from template"
					description="Pick a template. Everyfield copies it for your church plant and fills in your church's details."
				/>
				<DialogBody className="pb-7">
					<ul className="flex flex-col gap-3" aria-label="Templates">
						{templates.map((t) => {
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
			</DialogContent>
		</Dialog>
	);
}
