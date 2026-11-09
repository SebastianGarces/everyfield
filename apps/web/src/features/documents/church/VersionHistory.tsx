"use client";

import { Download01Icon } from "@hugeicons/core-free-icons";
import { Button, Skeleton, StatePanel } from "@everyfield/ui/controls";
import { cn } from "@everyfield/ui/foundations";
import { useEffect, useState } from "react";
import { listChurchRevisions, type RevisionEntry } from "./actions.ts";
import { ChurchPdf } from "./ChurchPdf.tsx";

// Version history: the saved revisions of a Church Document, newest first, and the real PDF of the one chosen. It only
// reads: nothing here changes the document, and the editor under it keeps its draft and its Undo history.

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Props = {
	docId: string;
	title: string;
	/** The revision the document is at now; the list loads again when it moves. */
	current: string;
	/** The file route of one revision in one format. */
	file: (format: "pdf" | "docx", download: boolean, revision: string) => string;
	page: { width: number; height: number };
};

export function VersionHistory({ docId, title, current, file, page }: Props) {
	// The list as loaded for one revision of the document: a save moves `current`, and the list loads again.
	const [loaded, setLoaded] = useState<{ at: string; list: RevisionEntry[] | "failed" } | null>(null);
	const [chosen, setChosen] = useState<number | null>(null);
	const revisions = loaded?.at === current ? loaded.list : null;

	useEffect(() => {
		let cancelled = false;
		listChurchRevisions(docId).then(
			(result) => !cancelled && setLoaded({ at: current, list: result.status === "ok" ? result.revisions : "failed" }),
			() => !cancelled && setLoaded({ at: current, list: "failed" }),
		);
		return () => {
			cancelled = true;
		};
	}, [docId, current]);

	if (revisions === "failed")
		return (
			<StatePanel tone="error" title="Version history did not load" headingLevel="h2" className="py-8">
				This is a loading problem. Nothing was changed. Close history and open it again.
			</StatePanel>
		);
	const shown = chosen ?? Number(current);
	const at = String(shown);
	return (
		<section aria-label="Version history" className="grid gap-5 lg:grid-cols-[minmax(240px,300px)_1fr] lg:items-start">
			<div className="flex flex-col gap-2 lg:sticky lg:top-[calc(var(--ef-topbar-h)+28px)]">
				<h2 className="text-md font-semibold text-ink">Saved revisions</h2>
				{revisions === null ? (
					<div aria-busy="true" className="flex flex-col gap-2">
						<span className="sr-only" role="status">
							Loading version history
						</span>
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} className="h-16 w-full rounded-card" />
						))}
					</div>
				) : (
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
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-sm text-text-2">
						<span className="font-semibold text-ink tabular-nums">Revision {at}</span>, read-only
					</p>
					<div className="flex flex-wrap gap-2">
						{(["pdf", "docx"] as const).map((format) => (
							<Button key={format} variant="secondary" size="sm" icon={Download01Icon} asChild>
								<a href={file(format, true, at)} download>
									{format === "pdf" ? "Download PDF" : "Download Word"}
								</a>
							</Button>
						))}
					</div>
				</div>
				<ChurchPdf
					key={file("pdf", false, at)}
					title={`${title}, revision ${at}`}
					src={file("pdf", false, at)}
					page={page}
				/>
			</div>
		</section>
	);
}
