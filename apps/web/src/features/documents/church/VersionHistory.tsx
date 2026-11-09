"use client";

import { cn } from "@everyfield/ui/foundations";
import { useState } from "react";
import { ChurchPdf } from "./ChurchPdf.tsx";
import type { RevisionRow } from "./server.ts";

// Version history: the saved revisions of a Church Document, newest first, and the real PDF of the one chosen. It only
// reads: nothing here changes the document, and the editor under it keeps its draft and its Undo history.

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Props = {
	/** The page's saved revisions, newest first; a save on the page adds its row. */
	revisions: RevisionRow[];
	title: string;
	/** The revision the document is at now. */
	current: string;
	/** The preview address of one revision in one format. */
	file: (format: string, revision: string) => string;
	page: { width: number; height: number };
};

export function VersionHistory({ revisions, title, current, file, page }: Props) {
	const [chosen, setChosen] = useState<number | null>(null);
	const shown = chosen ?? Number(current);
	const at = String(shown);
	return (
		<section aria-label="Version history" className="grid gap-5 lg:grid-cols-[minmax(240px,300px)_1fr] lg:items-start">
			<div className="flex flex-col gap-2 lg:sticky lg:top-[calc(var(--ef-topbar-h)+28px)]">
				<h2 className="text-md font-semibold text-ink">Saved revisions</h2>
				<ol className="flex max-h-[min(60vh,560px)] flex-col gap-1.5 overflow-y-auto p-0.5">
					{revisions.map((r) => {
						const on = r.number === shown;
						return (
							<li key={r.number}>
								<button
									type="button"
									aria-current={on ? "true" : undefined}
									onClick={() => setChosen(r.number)}
									className={cn(
										"flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-card px-3 py-2.5 text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)]",
										on
											? "bg-surface-raised shadow-[0_0_0_1.5px_var(--ef-ink)]"
											: "shadow-[0_0_0_1px_var(--ef-line)] hover:bg-surface-raised",
									)}
								>
									<span className="flex w-full items-center justify-between gap-2 text-sm font-semibold text-ink">
										<span className="tabular-nums">Revision {r.number}</span>
										{String(r.number) === current ? (
											<span className="rounded-pill bg-green-100 px-2 py-0.5 text-xs font-medium text-ink">
												Current
											</span>
										) : null}
									</span>
									<span className="text-sm text-text-2 tabular-nums">{WHEN.format(new Date(r.recordedAt))}</span>
									<span className="text-sm text-text-2">{r.authorName ?? "Unknown author"}</span>
								</button>
							</li>
						);
					})}
				</ol>
			</div>
			<div className="flex min-w-0 flex-col gap-3">
				<p className="text-sm text-text-2">
					<span className="font-semibold text-ink tabular-nums">Revision {at}</span>, read-only
				</p>
				<ChurchPdf key={file("pdf", at)} title={`${title}, revision ${at}`} src={file("pdf", at)} page={page} />
			</div>
		</section>
	);
}
