"use client";

import { Clock01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, EmptyState, Skeleton } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { useEffect, useState } from "react";
import { downloadSavedDocument, listSavedDocuments } from "./actions.ts";
import { FORMAT_LABEL, documentProblem, savedWhen, type SavedFile } from "./model.ts";

// Saved generated files. The list loads after the page, so the documents route keeps its statement budget.
// Each download asks for a new five-minute link. The stored bytes do not change when the template changes.

type Props = { enabled: boolean; refreshKey: number };

export function SavedHistory({ enabled, refreshKey }: Props) {
	const [entries, setEntries] = useState<SavedFile[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [link, setLink] = useState<{ id: string; url: string } | null>(null);

	useEffect(() => {
		if (!enabled) return;
		let cancel = false;
		listSavedDocuments().then((result) => {
			if (cancel) return;
			if (result.status !== "ok") {
				setEntries([]);
				setFailed(true);
				return;
			}
			setFailed(false);
			setEntries(result.value);
		});
		return () => {
			cancel = true;
		};
	}, [enabled, refreshKey, attempt]);

	async function download(entry: SavedFile) {
		setBusyId(entry.id);
		setNote(null);
		setLink(null);
		const result = await downloadSavedDocument(entry.id);
		setBusyId(null);
		if (result.status !== "ok") {
			setNote(
				documentProblem(
					result.status === "refused" ? result.code : "lost",
					result.status === "refused" ? result.problem : undefined,
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
				) : entries === null ? (
					<div aria-busy="true" className="flex flex-col gap-2">
						<span className="sr-only" role="status">
							Loading saved documents
						</span>
						<Skeleton className="h-14 w-full rounded-md" />
						<Skeleton className="h-14 w-full rounded-md" />
					</div>
				) : failed ? (
					<EmptyState
						icon={Clock01Icon}
						title="Saved documents did not load"
						headingLevel="h3"
						action={
							<Button
								variant="secondary"
								onClick={() => {
									setEntries(null);
									setFailed(false);
									setAttempt((current) => current + 1);
								}}
							>
								Try again
							</Button>
						}
					>
						This is a loading problem. Nothing was changed.
					</EmptyState>
				) : entries.length === 0 ? (
					<EmptyState icon={Clock01Icon} title="Nothing saved for your church yet." headingLevel="h3">
						Save a template to keep a copy here. A preview download stays on this device.
					</EmptyState>
				) : (
					<ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
						{entries.map((entry) => (
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
										<a href={link.url} target="_blank" rel="noopener noreferrer" className="rounded-sm text-sm text-ink underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
											Open the download
										</a>
									) : null}
								</div>
							</li>
						))}
					</ul>
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
