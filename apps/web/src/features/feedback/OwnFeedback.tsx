"use client";

import { READ_FAILED } from "../../components/read-failed.ts";
import { MessageEdit01Icon } from "@hugeicons/core-free-icons";
import type { OwnFeedback, OwnFeedbackPage } from "@everyfield/contracts/feedback";
import { Button, Card, EmptyState } from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, List, ListRow, Tag } from "@everyfield/ui/display";
import Link from "next/link";
import { useState, useTransition } from "react";
import { loadOwnFeedback } from "./fetch.ts";
import { CATEGORY_NAME, dateLabel, STATUS_NAME, STATUS_TONE } from "./model.ts";

function StatusTag({ item }: { item: OwnFeedback }) {
	return <Tag tone={STATUS_TONE[item.status]}>{STATUS_NAME[item.status]}</Tag>;
}

function PublicLink({ url }: { url: string }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1 text-sm font-medium text-ink underline underline-offset-2"
		>
			Public issue
		</a>
	);
}

export function OwnFeedbackList({ initial }: { initial: OwnFeedbackPage }) {
	const [items, setItems] = useState(initial.items);
	const [next, setNext] = useState(initial.next);
	const [failed, setFailed] = useState<"lost" | "failed" | null>(null);
	const [pending, start] = useTransition();

	function more() {
		if (!next) return;
		setFailed(null);
		start(async () => {
			const r = await loadOwnFeedback(next);
			if (r.status !== "ok") return setFailed(r.status === "failed" ? "failed" : "lost");
			setItems((shown) => [...shown, ...r.value.items]);
			setNext(r.value.next);
		});
	}

	if (!items.length)
		return (
			<Card>
				<EmptyState icon={MessageEdit01Icon} title="You have not sent feedback yet" headingLevel="h2">
					Use Send feedback in the rail on any page. What you send shows here with its status.
				</EmptyState>
			</Card>
		);
	return (
		<Card>
			<List aria-label="Sent feedback">
				{items.map((item) => (
					<ListRow
						key={item.id}
						title={
							<Link href={`/feedback/${item.id}`} className="hover:underline hover:underline-offset-2">
								{CATEGORY_NAME[item.category]}
							</Link>
						}
						subtitle={`Sent ${dateLabel(item.submittedAt)}${item.publicUrl ? "" : " · Public issue: None yet"}`}
						trailing={
							<span className="flex items-center gap-4">
								{item.publicUrl ? <PublicLink url={item.publicUrl} /> : null}
								<StatusTag item={item} />
							</span>
						}
					/>
				))}
			</List>
			{next || failed ? (
				<div className="flex items-center justify-center gap-3 pt-4">
					{failed ? (
						<span role="alert" className="text-sm text-magenta-600">
							{failed === "failed" ? READ_FAILED : "The next feedback did not load. Try again."}
						</span>
					) : null}
					{next ? (
						<Button variant="secondary" onClick={more} loading={pending}>
							Show 25 more
						</Button>
					) : null}
				</div>
			) : null}
		</Card>
	);
}

export function OwnFeedbackItem({ item }: { item: OwnFeedback }) {
	return (
		<Card>
			<KeyValueList>
				<KeyValue size="sm" k="Type" value={CATEGORY_NAME[item.category]} />
				<KeyValue size="sm" k="Sent" value={dateLabel(item.submittedAt)} />
				<KeyValue size="sm" k="Status" value={<StatusTag item={item} />} />
				<KeyValue
					size="sm"
					k="Public issue"
					value={item.publicUrl ? <PublicLink url={item.publicUrl} /> : <span className="text-text-3">None yet</span>}
				/>
			</KeyValueList>
		</Card>
	);
}
