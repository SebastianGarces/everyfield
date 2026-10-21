"use client";

import { Link01Icon, LockKeyIcon, Unlink01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useState } from "react";
import { NotAvailable } from "../access/AccessStates";
import { formatDay, historyReason, subjectOf } from "./model";
import type { History, HistoryItem, NameOf, RelationshipPair } from "./port";

/** Reads the next page of the same history scope. `after` is the contract's `next` cursor. */
export type ReadHistory = (after: string | null) => Promise<{ status: "unavailable" } | History>;

/** The name of the other side of a pair, seen from the scope that asked for the history. */
export function otherSide(scope: History["scope"], pair: RelationshipPair, nameOf: NameOf): string {
	const fromOrganization = "organization" in scope && scope.organization.id === pair.organization.id;
	return fromOrganization ? nameOf(subjectOf(pair)) : nameOf(pair.organization);
}

/**
 * Connection history (REQ-IDN-021): who connected or ended which link and when, newest first. It shows only the
 * recorded events; a `partial` history says that earlier events were not recorded instead of inventing them. When a
 * later page is refused, every row already shown goes away (REQ-IDN-005).
 */
export function HistoryList({
	first,
	read,
	nameOf,
	zone,
}: {
	first: History;
	read: ReadHistory;
	nameOf: NameOf;
	zone: string;
}) {
	const [pages, setPages] = useState<History[]>([first]);
	const [state, setState] = useState<"idle" | "loading" | "failed" | "refused">("idle");
	const last = pages[pages.length - 1]!;
	const items = pages.flatMap((p) => p.items);

	if (state === "refused") return <NotAvailable scope="section" />;

	const more = async () => {
		setState("loading");
		try {
			const page = await read(last.next);
			if (page.status === "unavailable") return setState("refused");
			setPages([...pages, page]);
			setState("idle");
		} catch {
			setState("failed");
		}
	};

	return (
		<div>
			{items.length === 0 ? (
				<p className="py-4 text-text-2">No connection history yet.</p>
			) : (
				<ol className="flex flex-col">
					{items.map((item) => (
						<HistoryRow
							key={item.id}
							item={item}
							name={otherSide(first.scope, item.pair, nameOf)}
							nameOf={nameOf}
							zone={zone}
						/>
					))}
				</ol>
			)}
			<div aria-live="polite" className="empty:hidden">
				{state === "failed" ? (
					<p className="mt-3 text-sm text-magenta-600">Earlier history did not load. Nothing was changed.</p>
				) : null}
			</div>
			{last.next ? (
				<Button variant="secondary" size="sm" className="mt-3" loading={state === "loading"} onClick={more}>
					{state === "failed" ? "Try again" : "Show earlier history"}
				</Button>
			) : last.completeness === "partial" ? (
				<p className="mt-3 text-sm text-text-3">History before this was not recorded.</p>
			) : null}
		</div>
	);
}

function HistoryRow({ item, name, nameOf, zone }: { item: HistoryItem; name: string; nameOf: NameOf; zone: string }) {
	const approved = item.event === "approved";
	const reason = historyReason(item);
	const actor =
		item.actor.kind === "account" ? nameOf({ kind: "account", id: item.actor.accountId }) : "a deleted account";
	const occurred = formatDay(item.occurredAt, zone);
	const recorded = formatDay(item.recordedAt, zone);
	return (
		<li className="flex gap-3.5 border-t border-line py-3.5 first:border-t-0">
			<span
				aria-hidden="true"
				className={
					approved
						? "grid size-9 flex-none place-items-center rounded-pill bg-green-100 text-green-700"
						: "grid size-9 flex-none place-items-center rounded-pill bg-surface-2 text-text-2"
				}
			>
				<Icon icon={approved ? Link01Icon : Unlink01Icon} size={16} />
			</span>
			<div className="min-w-0 flex-1">
				<p className="font-medium text-ink">{approved ? `Connected with ${name}` : `Connection with ${name} ended`}</p>
				<p className="text-sm text-text-3">
					<time dateTime={item.occurredAt}>{occurred}</time> · by {actor}
					{recorded !== occurred ? ` · recorded ${recorded}` : null}
				</p>
				{reason?.kind === "text" ? (
					<p className="mt-1.5 border-l-2 border-line-2 pl-3 text-sm text-text-2 [overflow-wrap:anywhere]">
						{reason.text}
					</p>
				) : reason ? (
					<p className="mt-1.5 flex items-center gap-1.5 text-sm text-text-3">
						<Icon icon={LockKeyIcon} size={16} />
						{reason.text}
					</p>
				) : null}
			</div>
		</li>
	);
}
