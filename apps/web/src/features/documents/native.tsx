"use client";

import { Add01Icon, ArrowRight01Icon, Copy01Icon, File02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	EmptyState,
	IntentLink,
	Skeleton,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Await, createRead, useRead } from "../../components/read.tsx";
import { copyToChurch, loadCopySources, loadWrittenDocuments, type DocumentOutcome } from "./actions.ts";
import { documentProblem, type CopySource, type OwnedView } from "./model.ts";
import { SECTION } from "./written/notes.tsx";

type Scope = "church" | "account";

const KIND_LABEL: Record<OwnedView["kind"], string | null> = {
	native: null,
	core_values: "Core values",
	launch_summary: "Launch summary",
};

const ROW =
	"flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-md bg-surface-raised px-4 py-3 text-left shadow-[0_0_0_1px_var(--ef-line)] transition-shadow duration-150 hover:bg-surface focus-visible:shadow-[0_0_0_2px_var(--ef-ink),0_0_0_5px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)] focus-visible:outline-none disabled:opacity-60";

const writtenDocuments = createRead(() => loadWrittenDocuments(), {
	failed: (): DocumentOutcome<{ documents: OwnedView[]; evidence: string | null }> => ({ status: "lost" }),
});

const copySources = createRead(() => loadCopySources(), {
	failed: (): DocumentOutcome<CopySource[]> => ({ status: "lost" }),
});

export function NativeDocuments({ written, canEdit }: { written: Scope; canEdit: boolean }) {
	const listed = useRead(writtenDocuments);
	const [copyOpen, setCopyOpen] = useState(false);
	const evidenceLabel = written === "church" ? "Core values for your church" : "Your core values";

	const newDocument = canEdit ? (
		<Button asChild variant="secondary">
			<IntentLink href="/documents/written/new">
				<Icon icon={Add01Icon} size={18} />
				New document
			</IntentLink>
		</Button>
	) : null;

	return (
		<section aria-labelledby="written-heading" className="mt-8 flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 id="written-heading" className="font-title text-title-sm tracking-[-0.02em] text-ink">
					{SECTION[written]}
				</h2>
				<div className="flex flex-wrap gap-2">
					{written === "church" && canEdit ? (
						<Button
							variant="secondary"
							icon={Copy01Icon}
							onClick={() => {
								copySources.prefetch();
								setCopyOpen(true);
							}}
						>
							Use for this church
						</Button>
					) : null}
					{newDocument}
				</div>
			</div>
			<Await
				state={listed}
				fallback={
					<div aria-busy="true" className="flex flex-col gap-2">
						<span className="sr-only" role="status">
							Loading written documents
						</span>
						<Skeleton className="h-14 w-full rounded-md" />
						<Skeleton className="h-14 w-full rounded-md" />
					</div>
				}
			>
				{(result) =>
					result.status !== "ok" ? (
						<Card>
							<EmptyState
								icon={File02Icon}
								title="Written documents did not load"
								headingLevel="h3"
								action={
									<Button variant="secondary" onClick={listed.retry}>
										Try again
									</Button>
								}
							>
								This is a loading problem. Nothing was changed.
							</EmptyState>
						</Card>
					) : (
						<div className="flex min-w-0 flex-col gap-4">
							{result.value.evidence ? (
								<div className="rounded-md bg-surface-raised px-4 py-3 shadow-[0_0_0_1px_var(--ef-line)]">
									<h3 className="text-sm font-medium text-ink">{evidenceLabel}</h3>
									<div className="mt-2 max-h-40 overflow-y-auto text-sm whitespace-pre-wrap text-text-2">
										{result.value.evidence}
									</div>
								</div>
							) : null}
							{result.value.documents.length === 0 ? (
								<Card>
									<EmptyState icon={File02Icon} title="No written documents yet" headingLevel="h3" action={newDocument}>
										{canEdit
											? "Write a document here, or import a text or Word file into a new one."
											: "Documents written for this church show up here."}
									</EmptyState>
								</Card>
							) : (
								<ul className="flex flex-col gap-2">
									{result.value.documents.map((document) => {
										const label = KIND_LABEL[document.kind];
										return (
											<li key={document.id}>
												<IntentLink href={`/documents/written/${document.id}`} className={ROW}>
													<span className="min-w-0 font-medium text-ink">{document.title}</span>
													<span className="flex items-center gap-2">
														{label ? <Tag>{label}</Tag> : null}
														<Icon icon={ArrowRight01Icon} size={18} className="text-text-3" />
													</span>
												</IntentLink>
											</li>
										);
									})}
								</ul>
							)}
						</div>
					)
				}
			</Await>
			{written === "church" && canEdit && copyOpen ? <UseForChurch onClose={() => setCopyOpen(false)} /> : null}
		</section>
	);
}

function UseForChurch({ onClose }: { onClose: () => void }) {
	const router = useRouter();
	const sources = useRead(copySources);
	const [copying, setCopying] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const attempt = useRef<{ documentId: string; key: string } | null>(null);

	async function copy(source: CopySource) {
		if (copying) return;
		if (attempt.current?.documentId !== source.id)
			attempt.current = { documentId: source.id, key: crypto.randomUUID() };
		const key = attempt.current.key;
		setCopying(source.id);
		setProblem(null);
		const result = await copyToChurch({ documentId: source.id, revisionId: source.revisionId, requestKey: key }).catch(
			() => ({ status: "lost" }) as const,
		);
		if (result.status === "ok") {
			attempt.current = null;
			router.push(`/documents/written/${result.value.id}`);
			return;
		}
		setCopying(null);
		if (result.status === "lost") {
			setProblem("The connection dropped. Choose the document again; it will not make a second copy.");
			return;
		}
		attempt.current = null;
		setProblem(
			result.code === "conflict"
				? "This document changed since the list opened. Close this and try again."
				: documentProblem(result.code, result.problem, "This document cannot be copied. It may be archived or empty."),
		);
	}

	return (
		<Dialog open onOpenChange={(next) => !next && !copying && onClose()}>
			<DialogContent size="md">
				<DialogHeader
					title="Use for this church"
					description="Copy one of your own documents into this church plant. The original stays in Your documents, and later edits to it do not change the copy."
				/>
				<DialogBody className="pb-2">
					<Await
						state={sources}
						fallback={
							<div aria-busy="true" className="flex flex-col gap-2">
								<span className="sr-only" role="status">
									Loading your documents
								</span>
								<Skeleton className="h-12 w-full rounded-md" />
								<Skeleton className="h-12 w-full rounded-md" />
							</div>
						}
					>
						{(loaded) =>
							loaded.status !== "ok" ? (
								<p className="text-sm">Your documents did not load. Close this and try again.</p>
							) : loaded.value.length === 0 ? (
								<p className="text-sm text-pretty">
									You have no documents of your own with text yet. Write one in Your documents first, then copy it here.
								</p>
							) : (
								<ul aria-label="Your documents" className="flex flex-col gap-2 p-0.5">
									{loaded.value.map((source) => (
										<li key={source.id}>
											<button
												type="button"
												className={ROW}
												aria-busy={copying === source.id || undefined}
												disabled={copying !== null}
												onClick={() => void copy(source)}
											>
												<span className="min-w-0 font-medium text-ink">{source.title}</span>
												<span className="text-sm text-text-2">{copying === source.id ? "Copying…" : "Copy"}</span>
											</button>
										</li>
									))}
								</ul>
							)
						}
					</Await>
					{problem ? (
						<p role="alert" className="mt-3 text-sm text-magenta-600 text-pretty">
							{problem}
						</p>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" disabled={copying !== null} onClick={onClose}>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
