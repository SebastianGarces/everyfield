import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { cn, Icon } from "@everyfield/ui/foundations";
import type { MailReport } from "@everyfield/contracts/communication";
import type { ReactNode } from "react";
import {
	audienceText,
	LEFT_OUT_REASON,
	RECIPIENT_OUTCOME,
	reportTime,
	sendTimeFull,
	sendTimeOf,
	sendTimeShort,
	stoppedReason,
	type Change,
	type Review,
} from "./model.ts";

// What an email review shows (MAIL51-009): the subject, who gets it and who is left out, the exact content, and the send
// time in the church's zone. After approval it shows only what the email service confirmed, never "delivered".

const find = (review: Review, field: string): Change | undefined =>
	review.review.changes.find((c) => c.field === field);
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
const New = ({ children }: { children: ReactNode }) => (
	<span className="font-medium break-words text-ink">{children}</span>
);

/** A long text kept in its own block so a body reads as the reader will see it. */
function Block({ label, children, muted }: { label: string; children: string; muted?: boolean }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="text-text-2">{label}</dt>
			<dd>
				<p
					className={cn(
						"rounded-md bg-surface-raised px-3 py-2 whitespace-pre-line shadow-[inset_0_0_0_1px_var(--ef-line)]",
						muted && "text-text-2",
					)}
				>
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

/** The people a review leaves out, each with the reason. */
const leftOutNames = (rows: { name: string; reason: string }[]) =>
	rows.map((r) => ({ name: r.name, note: LEFT_OUT_REASON[r.reason] ?? r.reason }));

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
						<New>{audienceText(audience?.after) ?? "Not chosen"}</New>
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
					<People label="Left out" names={leftOutNames(Array.isArray(leftOut) ? leftOut : [])} />
					<Block label="What each person sees">{text(content)}</Block>
				</>
			) : null}
			{op === "communication.rescheduleReviewed" ||
			op === "communication.cancelScheduledReviewed" ||
			op === "communication.replaceScheduledReviewed" ? (
				<Row label="People">
					<New>
						{String(count ?? 0)} {Number(count) === 1 ? "person" : "people"}
					</New>
				</Row>
			) : null}
			{op === "communication.replaceScheduledReviewed" && Array.isArray(leftOut) ? (
				<People label="Left out" names={leftOutNames(leftOut)} />
			) : null}
			{op === "communication.replaceScheduledReviewed" && audience ? (
				<Row label="Audience">
					<Old>{audienceText(audience.before)}</Old>
					<Then />
					<New>{audienceText(audience.after)}</New>
				</Row>
			) : null}
			{op === "communication.replaceScheduledReviewed" && body ? (
				<>
					<Block label="Body now" muted>
						{text(body.before)}
					</Block>
					<Block label={review.receipt?.report?.kind === "replace_stopped" ? "New body, not scheduled" : "Body after"}>
						{text(body.after)}
					</Block>
				</>
			) : null}
			{time ? (
				<Row label="Sends">
					{op === "communication.rescheduleReviewed" && was ? (
						<>
							<Old>{sendTimeFull(was)}</Old>
							<Then />
						</>
					) : null}
					<New>{sendTimeFull(time)}</New>
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
export const MAIL_CONSEQUENCE: Record<string, string> = {
	"communication.saveDraft": "The draft is saved in Messages. Nothing is sent.",
	"communication.scheduleReviewed":
		"Everyfield keeps the email until this time, then hands it to the email service. Anyone who unsubscribes before then doesn't get it.",
	"communication.rescheduleReviewed":
		"Recipients and content stay the same. The new time shows only once it is confirmed for every recipient.",
	"communication.cancelScheduledReviewed": "It says Cancelled only once every recipient's send is confirmed cancelled.",
	"communication.replaceScheduledReviewed":
		"The old send is cancelled first. The new one is scheduled at the same time only after every cancel is confirmed. If any cancel is not confirmed or already sent, nothing new is scheduled.",
};

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

const noun = (n: number) => (n === 1 ? "recipient" : "recipients");

/** The accepted, refused and unknown counts of one request to the email service. */
const handoffTally = (report: { accepted: number; refused: number; unknown: number }) => (
	<Tally
		items={[
			["Accepted", report.accepted],
			["Refused", report.refused],
			["Unknown", report.unknown],
		]}
	/>
);
const cancelTally = (report: { cancelled: number; sent: number; open: number }) => (
	<Tally
		items={[
			["Cancelled", report.cancelled],
			["Already sent", report.sent],
			["Not confirmed", report.open],
		]}
	/>
);

type Handoff = { confirmation: string; unknown: number; waiting?: number | undefined; leftOut?: number | undefined };
/** The email waits in Everyfield until its send time (D-927); the email service has not been asked yet. */
const waits = (report: Handoff) => report.confirmation === "confirmed" && report.waiting !== undefined;

/** The counts of one handoff: who waits in Everyfield, or what the email service answered. */
function handoffCounts(report: Handoff & { accepted: number; refused: number }) {
	return waits(report) ? (
		<Tally
			items={[
				["Waiting", report.waiting ?? 0],
				["Left out", report.leftOut ?? 0],
			]}
		/>
	) : (
		handoffTally(report)
	);
}

/** What one handoff means, in words that never go past what is known. */
function handoffText(report: Handoff, at: string | null): string {
	if (waits(report))
		return `Everyfield keeps this email until ${at}, then hands it to the email service. Anyone who unsubscribes before then doesn't get it.`;
	return report.confirmation === "confirmed"
		? `The email service accepted these for ${at}. Accepted does not mean the email arrived. The email service reports what happens next.`
		: `The email service has not answered for ${report.unknown} ${noun(report.unknown)}, so they may or may not get this email at ${at}. Check again asks it again.`;
}

function stoppedText(report: Extract<MailReport, { kind: "replace_stopped" }>, at: string | null) {
	if (report.confirmation === "not_confirmed")
		return `Nothing new was scheduled. The email service did not confirm every cancel, so the original email still goes out${at ? ` ${at}` : ""} to anyone not cancelled. Check again asks it again.`;
	if (report.confirmation === "blocked")
		return "Nothing new was scheduled. At least one recipient could not be cancelled because the email already went out.";
	return `The old send is cancelled, and the new one was not scheduled. ${stoppedReason(report.code)} Nobody gets this email unless you schedule it again.`;
}

/** The saved result of an email effect, in the words of what the email service said. */
export function MailResult({ review }: { review: Review }) {
	const report = review.receipt?.report;
	if (!report) return null;
	// The send time the review showed, for a result that says the original email may still go out.
	const time = sendTimeOf(review, "after") ?? sendTimeOf(review, "before");
	const sendAt = time ? sendTimeShort(time) : null;
	let lines: ReactNode = null;
	switch (report.kind) {
		case "schedule":
			lines = (
				<>
					{handoffCounts(report)}
					<p className="text-text-2">
						{report.confirmation === "refused"
							? report.code
								? `Messages shows this message as scheduled, but the email service was not asked, so no email is on its way. ${stoppedReason(report.code)}`
								: "The email service refused every recipient, so no email is on its way. Messages shows what it refused."
							: handoffText(report, reportTime(report.scheduledAt, review))}
					</p>
				</>
			);
			break;
		case "replace":
			lines = (
				<>
					{handoffCounts(report)}
					<p className="text-text-2">
						The old send is cancelled. {handoffText(report, reportTime(report.scheduledAt, review))}
					</p>
				</>
			);
			break;
		case "reschedule":
			lines =
				report.confirmation === "confirmed" ? (
					<p>
						{/* Mail still waiting in Everyfield is confirmed with no email service call (D-927), so the line names no confirmer. */}
						The new time is confirmed: {reportTime(report.scheduledAt, review)}. The earlier time is gone.
						{report.sent ? ` ${report.sent} ${noun(report.sent)} had already been sent.` : ""}
					</p>
				) : report.confirmation === "none" ? (
					<p>No recipient of this message is still waiting to send, so no time changed.</p>
				) : (
					<p>
						The email service did not confirm the new time for {report.open} {noun(report.open)}. They may still hold
						the earlier time. Check again asks it again.
					</p>
				);
			break;
		case "cancel":
			lines = (
				<>
					{cancelTally(report)}
					{report.confirmation === "not_confirmed" ? (
						<>
							<p>
								{`The email service hasn't confirmed the cancel. It may still go out${sendAt ? ` ${sendAt}` : ""}. Check again to ask it.`}
							</p>
							{report.people ? (
								<People
									label="Affected"
									names={report.people.map((p) => ({ name: p.name, note: RECIPIENT_OUTCOME[p.outcome] }))}
								/>
							) : null}
						</>
					) : null}
				</>
			);
			break;
		case "replace_stopped":
			lines = (
				<>
					{cancelTally(report)}
					<p>{stoppedText(report, sendAt)}</p>
					<People
						label="Affected"
						names={report.people.map((p) => ({ name: p.name, note: RECIPIENT_OUTCOME[p.outcome] }))}
					/>
				</>
			);
			break;
	}
	return <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">{lines}</div>;
}
