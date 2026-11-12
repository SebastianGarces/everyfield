"use client";

import { Archive02Icon, ArchiveRestoreIcon } from "@hugeicons/core-free-icons";
import { Button, Card, ConfirmDialog, EmptyState, IntentLink, PageHeader } from "@everyfield/ui/controls";
import { Pagination, Tag } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import type { ArchivedChurchSummary } from "@everyfield/contracts/documents";
import Link from "next/link";
import { useRef, useState } from "react";
import { restoreChurchDocument, type ChurchActionResult } from "./actions.ts";
import { CLASS_LABEL, archivedText } from "./labels.ts";

// The church plant's archived Church Documents (T-284), newest archive first, for an Owner or Admin. Each row opens the
// archived document's read-only page, and Restore returns it to the library after a confirmation.

/** Rows on one page of the list. */
const PAGE_SIZE = 20;

export function ArchivedLibrary({ documents }: { documents: ArchivedChurchSummary[] }) {
	const [page, setPage] = useState(1);
	const top = useRef<HTMLElement>(null);
	const pageCount = Math.ceil(documents.length / PAGE_SIZE);
	const shown = documents.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	return (
		<>
			<PageHeader
				breadcrumb={[
					{ label: "Documents", href: "/documents" },
					{ label: "Church documents", href: "/documents/church" },
					{ label: "Archived" },
				]}
				title="Archived documents"
				subtitle="Archived documents are read-only, and their revisions and saved exports stay available. Restore one to return it to your church plant's library."
			/>
			{documents.length === 0 ? (
				<Card>
					<EmptyState
						icon={Archive02Icon}
						title="No archived documents"
						headingLevel="h2"
						action={
							<Button asChild variant="secondary">
								<Link href="/documents/church">Back to Church documents</Link>
							</Button>
						}
					>
						Your church plant has no archived documents. A document you archive from its page shows here.
					</EmptyState>
				</Card>
			) : (
				<section ref={top} aria-labelledby="archived-heading" className="flex scroll-mt-6 flex-col gap-4">
					<h2 id="archived-heading" className="sr-only">
						Archived documents
					</h2>
					<ul className="flex flex-col gap-3">
						{shown.map((doc) => (
							<ArchivedRow key={doc.id} doc={doc} />
						))}
					</ul>
					{pageCount > 1 ? (
						<div className="flex flex-wrap items-center justify-between gap-3">
							<span className="text-sm text-text-3 tabular-nums">
								Showing {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + shown.length} of {documents.length}
							</span>
							<Pagination
								label="Archived document pages"
								page={page}
								pageCount={pageCount}
								onPageChange={(next) => {
									setPage(next);
									top.current?.scrollIntoView({ block: "start" });
								}}
							/>
						</div>
					) : null}
				</section>
			)}
		</>
	);
}

/** One archived document: a link to its page, and Restore at its right edge (below it on a phone). */
function ArchivedRow({ doc }: { doc: ArchivedChurchSummary }) {
	async function restore() {
		const result: ChurchActionResult | undefined = await restoreChurchDocument(doc.id);
		// A success redirects to the library and returns nothing here; a refusal stays in the dialog with its reason.
		if (result?.status === "refused") throw new Error(result.message);
		if (result?.status === "lost") throw new Error("The connection dropped. Nothing was restored.");
	}
	return (
		<li
			className={cn(
				"flex items-center gap-4 rounded-card bg-surface-raised px-5 py-4 shadow-[0_0_0_1px_var(--ef-line)]",
				"max-app-sm:flex-col max-app-sm:items-start max-app-sm:gap-3",
			)}
		>
			<IntentLink
				href={`/documents/church/${doc.id}`}
				className={cn(
					"group flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center gap-1 rounded-md",
					"focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus",
				)}
			>
				<span className="text-lg font-medium text-ink text-pretty underline-offset-4 group-hover:underline">
					{doc.title}
				</span>
				<span className="text-sm text-text-3">{archivedText(doc.archivedAt, doc.archivedBy)}</span>
			</IntentLink>
			<span className="flex flex-none items-center gap-3">
				<Tag>{CLASS_LABEL[doc.documentClass]}</Tag>
				<ConfirmDialog
					trigger={
						<Button variant="secondary" icon={ArchiveRestoreIcon} aria-label={`Restore ${doc.title}`}>
							Restore
						</Button>
					}
					title={`Restore "${doc.title}"?`}
					description="It returns to your church plant's library and can be edited again."
					consequences={["Its revisions and saved exports stay as they are."]}
					confirmLabel="Restore document"
					onConfirm={restore}
				/>
			</span>
		</li>
	);
}
