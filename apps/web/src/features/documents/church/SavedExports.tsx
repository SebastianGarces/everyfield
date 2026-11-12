"use client";

import { Delete02Icon, Download01Icon, FileLockedIcon } from "@hugeicons/core-free-icons";
import type { SavedExport } from "@everyfield/contracts/documents";
import { Button, Card, ConfirmDialog, EmptyState } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { deleteSavedExport } from "./actions.ts";
import { FORMAT_LABEL } from "../model.ts";
import { savedAt as exportedAt } from "./labels.ts";

// The saved exports of one Church Document, newest first. Each row downloads the stored bytes of that export, which never
// change after later edits, brand kit changes or renderer changes. Only an Owner or Admin sees Delete.

/** The stored file of one saved export. The route reads the bytes; it never renders. */
export const savedExportHref = (saved: Pick<SavedExport, "documentId" | "id">) =>
	`/documents/church/${saved.documentId}/exports/${saved.id}`;

function size(bytes: number) {
	return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SavedExports({
	exports,
	canManage,
	onDeleted,
}: {
	exports: SavedExport[];
	canManage: boolean;
	onDeleted: (id: string) => void;
}) {
	return (
		<section aria-labelledby="saved-exports-heading" className="mx-auto mt-8 flex w-full max-w-[880px] flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h2 id="saved-exports-heading" className="font-title text-title-sm text-ink">
					Saved exports
				</h2>
				<p className="text-md text-text-2 text-pretty">
					Each download saves a copy that never changes, even after the document or the brand kit does.
				</p>
			</div>
			{exports.length === 0 ? (
				<Card>
					<EmptyState icon={FileLockedIcon} title="No saved exports yet" headingLevel="h3">
						Download this document as PDF, Word or, for a budget, Excel, and Everyfield saves that exact file here. It
						stays the same later, so you can always get back the copy you shared.
					</EmptyState>
				</Card>
			) : (
				<ul className="flex flex-col gap-2" aria-label="Saved exports, newest first">
					{exports.map((saved) => (
						<li
							key={saved.id}
							className={cn(
								"flex items-center gap-4 rounded-card bg-surface-raised px-5 py-3.5 shadow-[0_0_0_1px_var(--ef-line)]",
								"max-app-sm:flex-col max-app-sm:items-stretch max-app-sm:gap-3 max-app-sm:px-4",
							)}
						>
							<div className="flex min-w-0 flex-1 items-start gap-3">
								<Tag>{FORMAT_LABEL[saved.format]}</Tag>
								<div className="flex min-w-0 flex-col gap-0.5">
									<span className="text-md font-medium text-ink tabular-nums">Revision {saved.revision}</span>
									<span className="text-sm text-text-3">
										<time dateTime={saved.generatedAt} suppressHydrationWarning className="tabular-nums">
											{exportedAt(saved.generatedAt)}
										</time>
										{" · "}
										{saved.creatorName ?? "A former member"}
										{" · "}
										<span className="tabular-nums">{size(saved.byteCount)}</span>
									</span>
								</div>
							</div>
							<div className="flex flex-none items-center gap-2">
								<Button variant="secondary" icon={Download01Icon} asChild className="max-app-sm:flex-1">
									<a
										href={savedExportHref(saved)}
										download={saved.downloadName}
										aria-label={`Download revision ${saved.revision} ${FORMAT_LABEL[saved.format]}, saved ${exportedAt(saved.generatedAt)}`}
									>
										Download
									</a>
								</Button>
								{canManage ? <DeleteExport saved={saved} onDeleted={onDeleted} /> : null}
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function DeleteExport({ saved, onDeleted }: { saved: SavedExport; onDeleted: (id: string) => void }) {
	async function remove() {
		const result = await deleteSavedExport(saved.documentId, saved.id).catch(() => ({ status: "lost" as const }));
		if (result.status === "refused") throw new Error(result.message);
		if (result.status === "lost") throw new Error("The connection dropped. Nothing was deleted. Try again.");
		onDeleted(saved.id);
	}
	const label = `${FORMAT_LABEL[saved.format]} copy of revision ${saved.revision}`;
	return (
		<ConfirmDialog
			trigger={
				<Button
					variant="secondary"
					icon={Delete02Icon}
					aria-label={`Delete the saved ${label}`}
					className="max-app-sm:flex-1"
				>
					Delete
				</Button>
			}
			tone="danger"
			title={`Delete the saved ${label}?`}
			description={`Saved ${exportedAt(saved.generatedAt)} by ${saved.creatorName ?? "a former member"}.`}
			consequences={[
				"No one can download this copy again. The file you or others already downloaded is not affected.",
				"The document and its revisions stay. A new download saves a new copy.",
			]}
			confirmLabel="Delete saved export"
			onConfirm={remove}
		/>
	);
}
