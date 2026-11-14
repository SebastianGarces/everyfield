"use client";

import { InboxIcon } from "@hugeicons/core-free-icons";
import type {
	FeedbackCategory,
	FeedbackStatus,
	TriageChange,
	TriageDetail,
	TriagePage,
} from "@everyfield/contracts/feedback";
import { Button, Card, CardHeader, CardTitle, EmptyState, SegmentedControl } from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, List, ListRow, Tag } from "@everyfield/ui/display";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { changeFeedbackStatus, loadTriage } from "./actions.ts";
import {
	CATEGORIES,
	CATEGORY_NAME,
	dateLabel,
	HELD_REASON,
	operatorMailShown,
	publicationShown,
	STATUS_NAME,
	STATUS_TONE,
	timeLabel,
	type PublicationSetup,
} from "./model.ts";

const STATUSES: FeedbackStatus[] = ["new", "reviewed", "resolved", "dismissed"];
type Filter = { status: FeedbackStatus | null; category: FeedbackCategory | null };

const StatusTag = ({ status }: { status: FeedbackStatus }) => (
	<Tag tone={STATUS_TONE[status]}>{STATUS_NAME[status]}</Tag>
);

type Item = TriagePage["items"][number];
/** "Issue published" and "Email sent": where the public issue and the operator email stand. */
function Delivery({ item, setup }: { item: Item; setup: PublicationSetup }) {
	const issue = publicationShown(item.publication.state, setup);
	const mail = operatorMailShown(item.operatorMail, setup);
	return (
		<>
			<Tag tone={issue.tone}>Issue {issue.text.toLowerCase()}</Tag>
			<Tag tone={mail.tone}>Email {mail.text.toLowerCase()}</Tag>
		</>
	);
}

/** The triage list: filters by status and type in the address, 25 at a time with "Show more". */
export function TriageList({
	initial,
	filter,
	setup,
}: {
	initial: TriagePage;
	filter: Filter;
	setup: PublicationSetup;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const [items, setItems] = useState(initial.items);
	const [next, setNext] = useState(initial.next);
	const [failed, setFailed] = useState(false);
	const [pending, start] = useTransition();

	function go(change: Partial<Filter>) {
		const to = { ...filter, ...change };
		const query = new URLSearchParams();
		if (to.status) query.set("status", to.status);
		if (to.category) query.set("category", to.category);
		router.push(query.size ? `${pathname}?${query}` : pathname);
	}
	function more() {
		if (!next) return;
		setFailed(false);
		start(async () => {
			const r = await loadTriage({ ...filter, cursor: next });
			if (r.status !== "ok") return setFailed(true);
			setItems((shown) => [...shown, ...r.value.items]);
			setNext(r.value.next);
		});
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<SegmentedControl
					label="Status"
					size="sm"
					value={filter.status ?? "all"}
					onValueChange={(v) => go({ status: v === "all" ? null : (v as FeedbackStatus) })}
					options={[
						{ value: "all", label: "Any status" },
						...STATUSES.map((s) => ({ value: s, label: STATUS_NAME[s] })),
					]}
				/>
				<SegmentedControl
					label="Type"
					size="sm"
					value={filter.category ?? "all"}
					onValueChange={(v) => go({ category: v === "all" ? null : (v as FeedbackCategory) })}
					options={[
						{ value: "all", label: "Any type" },
						...CATEGORIES.map((c) => ({ value: c.value, label: CATEGORY_NAME[c.value] })),
					]}
				/>
			</div>
			<Card>
				{items.length ? (
					<List aria-label="Feedback">
						{items.map((item) => (
							<ListRow
								key={item.id}
								href={`/feedback/triage/${item.id}`}
								linkAs={Link}
								title={<span className="line-clamp-1">{item.description}</span>}
								subtitle={
									<>
										{[
											CATEGORY_NAME[item.category],
											item.details.page ?? "Unknown page",
											item.author.name,
											dateLabel(item.submittedAt),
										].join(" · ")}
										<span className="mt-2 flex flex-wrap gap-2">
											<Delivery item={item} setup={setup} />
										</span>
									</>
								}
								trailing={<StatusTag status={item.status} />}
							/>
						))}
					</List>
				) : (
					<EmptyState icon={InboxIcon} title="No feedback matches" headingLevel="h2">
						Nothing has this status and type. Choose another filter to see more.
					</EmptyState>
				)}
				{next || failed ? (
					<div className="flex items-center justify-center gap-3 pt-4">
						{failed ? (
							<span role="alert" className="text-sm text-magenta-600">
								The next feedback did not load. Try again.
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
		</div>
	);
}

type Notice = { tone: "info" | "error"; text: string } | null;

/**
 * One feedback for a triager: the words, the private details, the status and its history. A status change shows at
 * once; when someone changed it first, nothing is overwritten and the current status comes back with a notice.
 */
export function TriageItem({ initial, setup }: { initial: TriageDetail; setup: PublicationSetup }) {
	const [status, setStatus] = useState(initial.status);
	const [revision, setRevision] = useState(initial.revision);
	const [history, setHistory] = useState<TriageChange[]>(initial.history);
	const [notice, setNotice] = useState<Notice>(null);
	const [pending, start] = useTransition();
	const d = initial.details;

	function change(to: FeedbackStatus) {
		if (to === status || pending) return;
		const from = status;
		setStatus(to);
		setNotice(null);
		start(async () => {
			const r = await changeFeedbackStatus({ feedbackId: initial.id, expectedRevision: revision, status: to });
			if (r.status !== "ok") {
				setStatus(from);
				setNotice({ tone: "error", text: "The status did not save. Nothing changed. Try again." });
				return;
			}
			setStatus(r.value.status);
			setRevision(r.value.revision);
			if (r.value.outcome === "changed")
				setHistory((h) => [...h, { from, to, by: "You", at: new Date().toISOString() }]);
			if (r.value.outcome === "stale")
				setNotice({
					tone: "info",
					text: `Someone else changed this to ${STATUS_NAME[r.value.status]} after you opened it. Nothing was overwritten. Reload to see who changed it, and choose again if it still needs to change.`,
				});
		});
	}

	const rows: [string, string | null][] = [
		["From", `${initial.author.name} · ${initial.author.email}`],
		["Sent", timeLabel(initial.submittedAt)],
		["Page", d.page],
		["Address", d.address],
		["Church", d.church],
		["Role", d.role],
		["Browser", d.browser],
		["Screen", d.screenWidth && d.screenHeight ? `${d.screenWidth} × ${d.screenHeight}` : null],
		["Theme", d.theme === "dark" ? "Dark" : d.theme === "light" ? "Light" : null],
		["App version", d.appVersion],
	];

	return (
		<div className="grid items-start gap-5 app-lg:grid-cols-[minmax(0,1fr)_360px]">
			<Card className="gap-4">
				<CardHeader>
					<CardTitle>{CATEGORY_NAME[initial.category]}</CardTitle>
				</CardHeader>
				<p className="m-0 whitespace-pre-wrap text-md text-ink [overflow-wrap:anywhere]">{initial.description}</p>
				<KeyValueList>
					{rows.map(([k, v]) => (
						<KeyValue key={k} size="sm" k={k} value={v ?? <span className="font-normal text-text-3">Unknown</span>} />
					))}
				</KeyValueList>
			</Card>
			<div className="flex flex-col gap-5">
				<Card className="gap-3">
					<CardHeader>
						<CardTitle>Status</CardTitle>
					</CardHeader>
					<SegmentedControl
						label="Status"
						size="sm"
						wrap
						value={status}
						onValueChange={change}
						options={STATUSES.map((s) => ({ value: s, label: STATUS_NAME[s] }))}
					/>
					<div aria-live="polite" className="empty:hidden">
						{notice ? (
							<p
								role={notice.tone === "error" ? "alert" : undefined}
								className={
									notice.tone === "error"
										? "m-0 text-sm font-medium text-magenta-600"
										: "m-0 rounded-md bg-amber-100 px-3 py-2.5 text-sm text-ink"
								}
							>
								{notice.text}
							</p>
						) : null}
					</div>
				</Card>
				<PublicIssue item={initial} setup={setup} />
				<Card className="gap-3">
					<CardHeader>
						<CardTitle>History</CardTitle>
					</CardHeader>
					{history.length ? (
						<ol className="m-0 flex list-none flex-col gap-3 p-0">
							{history.map((h, i) => (
								<li key={`${h.at}-${i}`} className="flex flex-col gap-0.5 text-sm">
									<span className="text-ink">
										{STATUS_NAME[h.from]} → <b className="font-semibold">{STATUS_NAME[h.to]}</b> by {h.by}
									</span>
									<span className="text-text-3">{timeLabel(h.at)}</span>
								</li>
							))}
						</ol>
					) : (
						<p className="m-0 text-sm text-text-3">No status changes yet. It arrived as New.</p>
					)}
				</Card>
			</div>
		</div>
	);
}

/**
 * The public issue and the operator email: the reference both carry, where each stands, and why it is held. The issue
 * says only the type and area; its state on GitHub never changes the status here.
 */
function PublicIssue({ item, setup }: { item: TriageDetail; setup: PublicationSetup }) {
	const issue = publicationShown(item.publication.state, setup);
	const mail = operatorMailShown(item.operatorMail, setup);
	const held = item.publication.heldReason;
	return (
		<Card className="gap-3">
			<CardHeader>
				<CardTitle>Public issue</CardTitle>
			</CardHeader>
			<KeyValueList>
				<KeyValue size="sm" k="Reference" value={<span className="font-mono">{item.reference}</span>} />
				<KeyValue size="sm" k="Issue" value={<Tag tone={issue.tone}>{issue.text}</Tag>} />
				{item.publication.url ? (
					<KeyValue
						size="sm"
						k="Link"
						value={
							<a
								href={item.publication.url}
								target="_blank"
								rel="noreferrer"
								className="cursor-pointer font-medium text-ink underline underline-offset-2 [overflow-wrap:anywhere]"
							>
								{item.publication.url.replace(/^https:\/\//, "")}
							</a>
						}
					/>
				) : null}
				<KeyValue size="sm" k="Team email" value={<Tag tone={mail.tone}>{mail.text}</Tag>} />
			</KeyValueList>
			{held ? <p className="m-0 rounded-md bg-magenta-100 px-3 py-2.5 text-sm text-ink">{HELD_REASON[held]}</p> : null}
			{item.operatorMail === "failed" || item.operatorMail === "unknown" ? (
				<p className="m-0 rounded-md bg-amber-100 px-3 py-2.5 text-sm text-ink">
					{item.operatorMail === "failed"
						? "The team email was not sent. The feedback itself is saved."
						: "The email service did not say whether the team email went. It is checked again on the next run."}
				</p>
			) : null}
			<p className="m-0 text-sm text-text-3">
				The issue says only the type and area. Closing it on GitHub does not change the status here.
			</p>
		</Card>
	);
}
