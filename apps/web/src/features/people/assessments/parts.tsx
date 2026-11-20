"use client";

import { Button, SegmentedControl } from "@everyfield/ui/controls";
import { cn } from "@everyfield/ui/foundations";
import { useId, useState, type ReactNode } from "react";
import type { Outcome } from "../../../components/save/model.ts";
import { problemText } from "../parts.tsx";
import { withCorrections, withRecord } from "./model.ts";
import { READ_FAILED } from "../../../components/read-failed.ts";
import type { ReadFailure } from "../../../components/get-reads.ts";

export function recordProblem(code: string): string {
	switch (code) {
		case "busy":
			return "Another save on this card was still running, so nothing was sent. Save it again when that save ends.";
		case "future_date":
			return "This date is after today at your church. Choose today or an earlier date.";
		case "storage_unavailable":
			return "Document storage is not set up yet. Save without the document, or try again later.";
		case "unreadable_document":
			return "This file could not be read as a PDF, JPG or PNG. Choose another file of 10 MB or less.";
		case "upload_failed":
			return "The document did not upload, and nothing was saved. Try again in a moment.";
		case "upload_lost":
			return "The document upload did not finish, and nothing was saved. Try again.";
		default:
			return problemText(code);
	}
}

export function ChoiceField<V extends string>({
	label,
	value,
	options,
	onChange,
	error,
	aside,
}: {
	label: string;
	value: V | "";
	options: readonly { value: V; label: string }[];
	onChange: (value: V) => void;
	error?: string | null;
	aside?: ReactNode;
}) {
	const id = useId();
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="flex items-center justify-between gap-3">
				<span aria-hidden="true" className="text-sm font-medium text-ink-2">
					{label}
				</span>
				{aside}
			</div>
			<div data-invalid={error ? "true" : undefined} className="min-w-0">
				<SegmentedControl
					label={error ? `${label}. ${error}` : label}
					value={value as V}
					onValueChange={onChange}
					options={options.map((o) => ({ value: o.value, label: o.label }))}
					className={cn(
						"w-full *:flex-1 *:justify-center",
						error && "shadow-[inset_0_0_0_1.5px_var(--ef-magenta-500)]",
					)}
				/>
			</div>
			<div aria-live="polite" className="empty:hidden">
				{error ? (
					<p id={`${id}-error`} className="text-xs font-medium text-magenta-600">
						{error}
					</p>
				) : null}
			</div>
		</div>
	);
}

export function ShowEarlier({
	loading,
	failed,
	onClick,
}: {
	loading: boolean;
	failed: "lost" | "failed" | null;
	onClick: () => void;
}) {
	return (
		<div className="mt-2 flex flex-wrap items-center gap-3">
			<Button size="sm" variant="ghost" loading={loading} onClick={onClick}>
				Show earlier
			</Button>
			<span aria-live="polite" className="text-xs text-text-3 empty:hidden">
				{failed === "failed" ? READ_FAILED : failed ? "Earlier records did not load. Try again." : ""}
			</span>
		</div>
	);
}

export function recorder(actor: { kind: string; accountId?: string }, accountId: string): string {
	if (actor.kind === "current_account") return actor.accountId === accountId ? "you" : "a team member";
	return "a former team member";
}

type Page<R> = { items: R[]; next: number | null; total: number };
type Dated = { id: string; occurredOn: string; recordedAt: string };

export function useHistory<R extends Dated & { revision: string }>(
	initial: Page<R> | null,
	load: (page: number) => Promise<Outcome<Page<R>> | ReadFailure>,
	pushed: readonly R[] = [],
) {
	const [page, setPage] = useState<Page<R>>(initial ?? { items: [], next: null, total: 0 });
	const [state, setState] = useState<"idle" | "loading" | "lost" | "failed">("idle");
	const add = (record: R) =>
		setPage((p) => ({
			...p,
			items: withRecord(p.items, record),
			total: p.items.some((r) => r.id === record.id) ? p.total : p.total + 1,
		}));
	async function more() {
		const next = page.next;
		if (next === null || state === "loading") return;
		setState("loading");
		const r = await load(next).catch((): Outcome<Page<R>> => ({ status: "lost" }));
		if (r.status !== "ok") return setState(r.status === "failed" ? "failed" : "lost");
		setState("idle");
		setPage((p) => ({
			items: [...p.items, ...r.value.items.filter((x) => !p.items.some((y) => y.id === x.id))],
			next: p.next === next ? r.value.next : p.next,
			total: Math.max(p.total, r.value.total),
		}));
	}
	const items = withCorrections(page.items, pushed);
	return {
		...page,
		items,
		setPage,
		add,
		more,
		loading: state === "loading",
		failed: state === "lost" || state === "failed" ? state : null,
	};
}
