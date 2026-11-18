"use client";

import { Download01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@everyfield/ui/controls";
import { LocalTime, Tag } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { useState } from "react";
import { FORMAT_LABEL } from "../model.ts";
import type { RevisionRow } from "./server.ts";

type Format = keyof typeof FORMAT_LABEL;

const FIRST_SHOWN = 10;
const FORMATS = ["pdf", "docx", "xlsx"] as const satisfies readonly Format[];

export function ChurchRevisions({
	revisions,
	truncated,
	current,
	exporting,
	error,
	onDownload,
}: {
	revisions: RevisionRow[];
	truncated: boolean;
	current: number;
	exporting: { at: number; format: Format } | null;
	error: { at: number | null; message: string } | null;
	onDownload: (at: number, format: Format) => void;
}) {
	const [all, setAll] = useState(false);
	const shown = all ? revisions : revisions.slice(0, FIRST_SHOWN);
	return (
		<section aria-labelledby="revisions-heading" className="mx-auto mt-8 flex w-full max-w-[880px] flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h2 id="revisions-heading" className="font-title text-title-sm text-ink">
					Revisions
				</h2>
				<p className="text-md text-text-2 text-pretty">
					Each save makes a new revision. Download an earlier one to get the document as it was then.
				</p>
			</div>
			<ul className="flex flex-col gap-2" aria-label="Revisions, newest first">
				{shown.map((r) => (
					<li
						key={r.number}
						className="flex flex-col gap-3 rounded-card bg-surface-raised px-5 py-3.5 shadow-[0_0_0_1px_var(--ef-line)] max-app-sm:px-4"
					>
						<div
							className={cn("flex items-center gap-4", "max-app-sm:flex-col max-app-sm:items-stretch max-app-sm:gap-3")}
						>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="flex items-center gap-2">
									<span className="text-md font-medium text-ink tabular-nums">Revision {r.number}</span>
									{r.number === current ? <Tag>Current</Tag> : null}
								</span>
								<span className="text-sm text-text-3 wrap-anywhere">
									Saved <LocalTime iso={r.recordedAt} className="tabular-nums" /> by{" "}
									<span className="text-text-2">{r.savedBy ?? "A former member"}</span>
								</span>
							</div>
							<div className="flex flex-none flex-wrap items-center gap-2">
								{FORMATS.filter((f) => r.formats.includes(f)).map((format) => {
									const busy = exporting?.at === r.number && exporting.format === format;
									return (
										<Button
											key={format}
											variant="secondary"
											size="sm"
											icon={Download01Icon}
											loading={busy}
											disabled={exporting !== null && !busy}
											aria-label={`Download revision ${r.number} as ${FORMAT_LABEL[format]}`}
											className="max-app-sm:flex-1"
											onClick={() => onDownload(r.number, format)}
										>
											{FORMAT_LABEL[format]}
										</Button>
									);
								})}
							</div>
						</div>
						{error?.at === r.number ? (
							<p role="alert" className="rounded-md bg-magenta-100 px-3 py-2 text-sm text-magenta-600">
								{error.message}
							</p>
						) : null}
					</li>
				))}
			</ul>
			{revisions.length > shown.length ? (
				<Button variant="ghost" className="self-start" onClick={() => setAll(true)}>
					{truncated ? `Show the newest ${revisions.length} revisions` : `Show all ${revisions.length} revisions`}
				</Button>
			) : null}
			{truncated ? (
				<p className="text-sm text-text-3 text-pretty">
					Only the newest {revisions.length} revisions are listed. Older revisions are kept but not shown here.
				</p>
			) : null}
		</section>
	);
}
