"use client";

import { Clock01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, EmptyState, Skeleton } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { useState } from "react";
import { Await, createRead, useRead } from "../../components/read.tsx";
import type { DocumentOutcome } from "./outcome.ts";
import { downloadSavedDocument, listSavedDocuments } from "./fetch.ts";
import { FORMAT_LABEL, documentProblem, savedWhen, type SavedFile } from "./model.ts";
import { loadProblem } from "../../components/read-failed.ts";
import type { ReadFailure } from "../../components/get-reads.ts";

export const savedDocuments = createRead(() => listSavedDocuments(), {
	failed: (): DocumentOutcome<SavedFile[]> | ReadFailure => ({ status: "lost" }),
});

export function SavedHistory({ enabled }: { enabled: boolean }) {
	const list = useRead(enabled ? savedDocuments : null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [link, setLink] = useState<{ id: string; url: string } | null>(null);

	async function download(entry: SavedFile) {
		setBusyId(entry.id);
		setNote(null);
		setLink(null);
		const result = await downloadSavedDocument(entry.id).catch(() => ({ status: "lost" }) as const);
		setBusyId(null);
		if (result.status === "lost" || result.status === "failed") {
			setNote(loadProblem(result, "The connection dropped, so the download did not start. Try again."));
			return;
		}
		if (result.status === "refused") {
			setNote(
				documentProblem(
					result.code,
					"problem" in result ? result.problem : undefined,
					"This download did not start. Try again.",
				),
			);
			return;
		}
		const opened = window.open(result.value.url, "_blank", "noopener,noreferrer");
		if (!opened) setLink({ id: entry.id, url: result.value.url });
	}

	return (
		<section id="saved" aria-labelledby="saved-heading" className="mt-8 scroll-mt-24">
			<Card className="gap-4">
				<h2 id="saved-heading" className="font-title text-title-sm tracking-[-0.02em] text-ink">
					Saved for your church
				</h2>
				{!enabled ? (
					<EmptyState icon={Clock01Icon} title="Nothing saved for your church yet." headingLevel="h3">
						A preview download stays on this device. It is not saved here.
					</EmptyState>
				) : (
					<Await
						state={list}
						fallback={
							<div aria-busy="true" className="flex flex-col gap-2">
								<span className="sr-only" role="status">
									Loading saved documents
								</span>
								<Skeleton className="h-14 w-full rounded-md" />
								<Skeleton className="h-14 w-full rounded-md" />
							</div>
						}
					>
						{(entries) =>
							entries.status !== "ok" ? (
								<EmptyState
									icon={Clock01Icon}
									title="Saved documents did not load"
									headingLevel="h3"
									action={
										<Button variant="secondary" onClick={list.retry}>
											Try again
										</Button>
									}
								>
									{loadProblem(entries, "This is a loading problem. Nothing was changed.")}
								</EmptyState>
							) : entries.value.length === 0 ? (
								<EmptyState icon={Clock01Icon} title="Nothing saved for your church yet." headingLevel="h3">
									Save a template to keep a copy here. A preview download stays on this device.
								</EmptyState>
							) : (
								<ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
									{entries.value.map((entry) => (
										<li
											key={entry.id}
											className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface px-4 py-3"
										>
											<div className="min-w-0">
												<p className="font-medium text-ink">{entry.savedTemplateName}</p>
												<p className="text-sm text-text-2">
													<Tag>{FORMAT_LABEL[entry.format]}</Tag>{" "}
													<time dateTime={entry.generatedAt}>{savedWhen(entry.generatedAt)}</time>
												</p>
											</div>
											<div className="flex flex-col items-start gap-2">
												<Button
													variant="secondary"
													icon={Download01Icon}
													loading={busyId === entry.id}
													aria-label={`Download ${entry.savedTemplateName}, ${FORMAT_LABEL[entry.format]}`}
													onClick={() => void download(entry)}
												>
													Download
												</Button>
												{link?.id === entry.id ? (
													<a
														href={link.url}
														target="_blank"
														rel="noopener noreferrer"
														className="rounded-sm text-sm text-ink underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
													>
														Open the download
													</a>
												) : null}
											</div>
										</li>
									))}
								</ul>
							)
						}
					</Await>
				)}
				{note ? (
					<p role="status" className="text-sm text-text-2">
						{note}
					</p>
				) : null}
			</Card>
		</section>
	);
}
