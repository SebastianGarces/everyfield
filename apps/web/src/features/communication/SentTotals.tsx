// The sent-email summary. Pure, so a render test can load it without the panel's server actions.
import { rateText, type DeliveryTotals } from "./model.ts";

export function when(iso: string | null): string {
	if (!iso) return "Not recorded";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * One recipient's status. A person who unsubscribed is skipped, never failed: before the email goes out they won't
 * receive it; after, they are listed as skipped (`gone` true).
 */
export function deliveryName(status: string, gone = true): string {
	if (status === "unsubscribed") return gone ? "Skipped: unsubscribed" : "Unsubscribed, won't receive this";
	const labels: Record<string, string> = {
		delivered: "Delivered",
		sent: "Sent",
		accepted: "Accepted",
		dispatched: "Sending",
		pending: "Waiting",
		scheduled: "Scheduled",
		refused: "Refused",
		unsubscribed: "Unsubscribed",
		failed: "Failed",
		cancelled: "Cancelled",
		unknown: "Unknown",
	};
	return labels[status] ?? status;
}

export function Tile({ label, value }: { label: string; value: number }) {
	return (
		<div className="flex flex-col gap-1 rounded-lg bg-surface px-4 py-3">
			<span className="font-display text-[28px] leading-none tracking-[-0.02em] text-ink tabular-nums">{value}</span>
			<span className="text-sm text-text-2">{label}</span>
		</div>
	);
}

export function Totals({ totals }: { totals: DeliveryTotals }) {
	const groups: { title: string; rows: { label: string; value: number }[] }[] = [
		{
			title: "Delivery",
			rows: [
				{ label: "Selected", value: totals.selected },
				{ label: "Reachable", value: totals.reachable },
				{ label: "Attempted", value: totals.attempted },
				{ label: "Accepted", value: totals.accepted },
				{ label: "Sent", value: totals.sent },
				{ label: "Delivered", value: totals.delivered },
			],
		},
		{
			title: "Engagement",
			rows: [
				{ label: "Opened", value: totals.opened },
				{ label: "Clicked", value: totals.clicked },
			],
		},
		{
			title: "Not delivered",
			rows: [
				{ label: "Bounced", value: totals.bounced },
				{ label: "Failed", value: totals.failed },
				{ label: "Suppressed", value: totals.suppressed },
				{ label: "Unknown", value: totals.unknown },
			],
		},
		// A person who unsubscribed is skipped, never a failed send, so they stay out of "Not delivered" (T-282).
		{
			title: "Skipped",
			rows: [{ label: "Unsubscribed", value: totals.unsubscribed }],
		},
	];
	return (
		<div className="flex flex-col gap-6">
			<p className="text-sm text-text-2">Counts as of {when(totals.asOf)}. A draft or an unknown result is not sent.</p>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Tile label="Reachable" value={totals.reachable} />
				<Tile label="Delivered" value={totals.delivered} />
				<Tile label="Opened" value={totals.opened} />
				<Tile label="Not delivered" value={totals.bounced + totals.failed + totals.suppressed + totals.unknown} />
			</div>
			{groups.map((group) => (
				<div key={group.title} className="flex flex-col gap-3">
					<h3 className="text-sm font-medium text-ink-2">{group.title}</h3>
					<dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
						{group.rows.map((row) => (
							<div key={row.label}>
								<dt className="text-sm text-text-3">{row.label}</dt>
								<dd className="text-md font-medium text-ink tabular-nums">{row.value}</dd>
							</div>
						))}
					</dl>
				</div>
			))}
			<p className="text-sm text-text-2">{rateText(totals.delivered, totals.reachable, totals.rate)}</p>
			<p className="text-sm text-text-2">An open and a click stay separate. Neither one is a typed contact.</p>
			{totals.unknown > 0 ? (
				<p className="text-sm text-text-2">Some recipients have no result yet. Unknown is not delivered.</p>
			) : null}
			<p className="text-sm text-text-2">
				{totals.sentForAll ? "Every recipient record is sent." : "Not every recipient record is sent."}
				{totals.outcomes.length > 0
					? ` Provider words: ${totals.outcomes.map((word) => deliveryName(word)).join(", ")}.`
					: ""}
			</p>
		</div>
	);
}
