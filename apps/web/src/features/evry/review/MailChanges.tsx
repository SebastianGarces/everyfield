import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { cn, Icon } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";
import {
	audienceOf,
	audienceText,
	LEFT_OUT_REASON,
	mailReport,
	reportTime,
	sendTimeFull,
	sendTimeOf,
	type Change,
	type MailReport,
	type Review,
} from "./model.ts";

// What an email review shows (MAIL51-009): the subject, who gets it and who is left out, the exact content, and the send
// time in the church's zone. After approval it shows only what the email service confirmed, never "delivered".

const find = (review: Review, field: string): Change | undefined => review.review.changes.find((c) => c.field === field);
const text = (value: unknown) => (typeof value === "string" ? value : "");

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[minmax(88px,auto)_1fr] items-baseline gap-x-3">
			<dt className="text-text-2">{label}</dt>
			<dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">{children}</dd>
		</div>
	);
}
const Then = () => (
	<>
		<Icon icon={ArrowRight02Icon} size={16} className="text-text-3" />
		<span className="sr-only"> to </span>
	</>
);
const Old = ({ children }: { children: ReactNode }) => <span className="text-text-2 line-through">{children}</span>;
const New = ({ children }: { children: ReactNode }) => <span className="font-medium break-words text-ink">{children}</span>;

/** A long text kept in its own block so a body reads as the reader will see it. */
function Block({ label, children, muted }: { label: string; children: string; muted?: boolean }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="text-text-2">{label}</dt>
			<dd>
				<p className={cn("rounded-md bg-surface-raised px-3 py-2 whitespace-pre-line shadow-[inset_0_0_0_1px_var(--ef-line)]", muted && "text-text-2")}>
					{children}
				</p>
			</dd>
		</div>
	);
}

function People({ label, names }: { label: string; names: { name: string; note?: string }[] }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="text-text-2">
				{label} <span className="tabular-nums">({names.length})</span>
			</dt>
			<dd>
				{names.length ? (
					<ul className="flex flex-col gap-0.5">
						{names.map((p, n) => (
							<li key={`${p.name}:${n}`} className="flex flex-wrap items-baseline gap-x-2">
								<span className="font-medium text-ink">{p.name}</span>
								{p.note ? <span className="text-xs text-text-2">{p.note}</span> : null}
							</li>
						))}
					</ul>
				) : (
					<span className="text-text-3 italic">Nobody</span>
				)}
			</dd>
		</div>
	);
}

/** The reviewed facts of one email change. */
export function MailChanges({ review }: { review: Review }) {
	const subject = text(find(review, "subject")?.after);
	const time = sendTimeOf(review, "after");
	const was = sendTimeOf(review, "before");
	const body = find(review, "body");
	const audience = find(review, "audience");
	const count = find(review, "recipientCount")?.after;
	const recipients = find(review, "recipients")?.after;
	const leftOut = find(review, "leftOut")?.after;
	const content = find(review, "content")?.after;
	const op = review.operation;
	return (
		<dl className="flex flex-col gap-3 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
			<Row label="Subject">
				<New>{subject || "Untitled draft"}</New>
			</Row>
			{op === "communication.saveDraft" ? (
				<>
					<Row label="Audience">
						<New>{audienceOf(audience?.after) ? audienceText(audienceOf(audience!.after)!) : "Not chosen"}</New>
					</Row>
					<Block label="Body">{text(body?.after)}</Block>
				</>
			) : null}
			{op === "communication.scheduleReviewed" ? (
				<>
					<People
						label="Will get it"
						names={(Array.isArray(recipients) ? recipients : []).map((r: { name: string }) => ({ name: r.name }))}
					/>
					<People
						label="Left out"
						names={(Array.isArray(leftOut) ? leftOut : []).map((r: { name: string; reason: string }) => ({
							name: r.name,
							note: LEFT_OUT_REASON[r.reason] ?? r.reason,
						}))}
					/>
					<Block label="What each person sees">{text(content)}</Block>
				</>
			) : null}
			{op === "communication.rescheduleReviewed" || op === "communication.cancelScheduledReviewed" || op === "communication.replaceScheduledReviewed" ? (
				<Row label="People">
					<New>
						{String(count ?? 0)} {Number(count) === 1 ? "person" : "people"}
					</New>
				</Row>
			) : null}
			{op === "communication.replaceScheduledReviewed" && audience ? (
				<Row label="Audience">
					{audienceOf(audience.before) ? <Old>{audienceText(audienceOf(audience.before)!)}</Old> : null}
					<Then />
					{audienceOf(audience.after) ? <New>{audienceText(audienceOf(audience.after)!)}</New> : null}
				</Row>
			) : null}
			{op === "communication.replaceScheduledReviewed" && body ? (
				<>
					<Block label="Body now" muted>
						{text(body.before)}
					</Block>
					<Block label="Body after">{text(body.after)}</Block>
				</>
			) : null}
			{time ? (
				<Row label={op === "communication.cancelScheduledReviewed" ? "Was set for" : "Sends"}>
					{op === "communication.rescheduleReviewed" && was ? (
						<>
							<Old>{sendTimeFull(was)}</Old>
							<Then />
						</>
					) : null}
					{op === "communication.cancelScheduledReviewed" ? null : <New>{sendTimeFull(time)}</New>}
				</Row>
			) : null}
			{op === "communication.cancelScheduledReviewed" && was ? (
				<Row label="Was set for">
					<New>{sendTimeFull(was)}</New>
				</Row>
			) : null}
		</dl>
	);
}

/** What the card tells the owner will and will not happen, in one sentence. */
export function mailConsequence(review: Review): string | null {
	switch (review.operation) {
		case "communication.saveDraft":
			return "The draft is saved in Messages. Nothing is sent.";
		case "communication.scheduleReviewed":
			return "The email service holds the email until this time. It says Scheduled only after the email service accepts it.";
		case "communication.rescheduleReviewed":
			return "Recipients and content stay the same. The new time shows only after the email service confirms it.";
		case "communication.cancelScheduledReviewed":
			return "It says Cancelled only after the email service confirms every cancel.";
		case "communication.replaceScheduledReviewed":
			return "The old send is cancelled first. The new one is scheduled at the same time only after the email service confirms every cancel. If any cancel is not confirmed or already sent, nothing new is scheduled.";
		default:
			return null;
	}
}

const COUNTS: [keyof MailReport, string][] = [
	["accepted", "Accepted"],
	["refused", "Refused"],
	["unknown", "Unknown"],
];
function Tally({ items }: { items: [string, number][] }) {
	return (
		<ul className="flex flex-wrap gap-x-4 gap-y-1">
			{items.map(([label, n]) => (
				<li key={label}>
					<span className="text-text-2">{label} </span>
					<span className="font-medium tabular-nums text-ink">{n}</span>
				</li>
			))}
		</ul>
	);
}

/** The saved result of an email effect, in the words of what the email service said. */
export function MailResult({ review }: { review: Review }) {
	const report = mailReport(review);
	if (!report) return null;
	const at = reportTime(report, review);
	let lines: ReactNode = null;
	if (report.kind === "schedule" || (report.kind === "replace" && report.replaced))
		lines = (
			<>
				<Tally items={COUNTS.map(([k, label]) => [label, Number(report[k] ?? 0)])} />
				<p className="text-text-2">
					The email service accepted these for {at}. Accepted is not delivered. It reports delivery later.
				</p>
			</>
		);
	if (report.kind === "reschedule")
		lines =
			report.confirmation === "confirmed" ? (
				<p>The email service confirmed {at}. The earlier time is gone.</p>
			) : (
				<p>
					The email service did not confirm the new time for {Number(report.open ?? 0)}{" "}
					{report.open === 1 ? "recipient" : "recipients"}. They may still hold the earlier time
					{report.heldAt ? "" : ""}. Check again asks it again.
				</p>
			);
	if (report.kind === "cancel")
		lines = (
			<>
				<Tally
					items={[
						["Cancelled", Number(report.cancelled ?? 0)],
						["Already sent", Number(report.sent ?? 0)],
						["Not confirmed", Number(report.open ?? 0)],
					]}
				/>
				{report.confirmation === "not_confirmed" ? (
					<p className="text-text-2">Not confirmed is not cancelled. Check again asks the email service again.</p>
				) : null}
			</>
		);
	if (report.kind === "replace" && !report.replaced)
		lines = (
			<>
				<p>
					Nothing new was scheduled.{" "}
					{report.confirmation === "not_confirmed"
						? "The email service did not confirm every cancel. Check again asks it again."
						: "At least one recipient could not be cancelled because the email already went out."}
				</p>
				{report.people?.length ? (
					<People label="Affected" names={report.people.map((p) => ({ name: p.name, note: p.outcome }))} />
				) : null}
			</>
		);
	return <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">{lines}</div>;
}
