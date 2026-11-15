import type { ReviewRun } from "@everyfield/contracts/intelligence";
import { Card, CardHeader, CardHeading, CardTitle, EmptyState, PageHeader, StatePanel } from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, List, ListRow, Tag } from "@everyfield/ui/display";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { CAUSE, count, DEMAND, RULE, timeLabel } from "./model.ts";
import { assessments, run, type Run } from "./server.ts";

// Assessment review (PI-042): the plants held after three failed scheduled assessments, and one run's real cause. It
// shows causes, rules and counters only, never a plant's facts, the model's input or any draft's words. The pages open
// only for an account with a current assessment_operator grant; anyone else sees the same closed page.

export const reviewMetadata: Metadata = { title: "Assessment review", robots: { index: false, follow: false } };
const REVIEW = [{ label: "Assessment review", href: "/assessment-review" }];

function settled<T>(r: Run<T>, returnTo: string): Exclude<Run<T>, { status: "signed_out" }> {
	if (r.status === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
	return r as Exclude<Run<T>, { status: "signed_out" }>;
}
function Panel({ title, tone, children }: { title: string; tone: "error" | "lock" | "neutral"; children: ReactNode }) {
	return (
		<Card>
			<StatePanel tone={tone} title={title} headingLevel="h2">
				{children}
			</StatePanel>
		</Card>
	);
}
const Closed = () => (
	<Panel tone="lock" title="Assessment review needs an operator grant">
		Only an Everyfield team member with assessment review access sees held assessments. A church role does not give that
		access.
	</Panel>
);
const LOAD_FAILED = "This is a loading problem, not an empty list. Nothing was changed. Reload the page in a moment.";
const CauseTag = ({ run }: { run: ReviewRun }) => <Tag tone="amber">{CAUSE[run.cause].label}</Tag>;

/** /assessment-review: every plant held for review, newest failure first. */
export async function ReviewListPage() {
	const r = settled(await run((db, a) => assessments.listRunsForReview(db, a, {})), "/assessment-review");
	return (
		<>
			<PageHeader
				title="Assessment review"
				subtitle="Plants whose last three scheduled assessments failed. Each keeps showing its last good assessment."
			/>
			{r.status === "ok" ? (
				<Card>
					{r.value.length ? (
						<List aria-label="Held assessments">
							{r.value.map((item) => (
								<ListRow
									key={item.runId}
									href={`/assessment-review/${item.runId}`}
									linkAs={Link}
									title={item.plantName}
									subtitle={`Last failed ${timeLabel(item.settledAt)}`}
									trailing={<CauseTag run={item} />}
								/>
							))}
						</List>
					) : (
						<EmptyState icon={CheckmarkCircle02Icon} title="Nothing is held" headingLevel="h2">
							No plant has three failed scheduled assessments in a row.
						</EmptyState>
					)}
				</Card>
			) : r.status === "refused" ? (
				<Closed />
			) : (
				<Panel tone="error" title="Held assessments did not load">
					{LOAD_FAILED}
				</Panel>
			)}
		</>
	);
}

/** /assessment-review/[runId]: one run that did not publish, its cause, counters and the plant's failed streak. */
export async function ReviewRunPage({ params }: { params: Promise<{ runId: string }> }) {
	const { runId } = await params;
	const r = settled(
		await run((db, a) => assessments.describeRunFailure(db, a, { runId })),
		`/assessment-review/${runId}`,
	);
	return (
		<>
			<PageHeader
				title={r.status === "ok" ? r.value.plantName : "Assessment run"}
				breadcrumb={[...REVIEW, { label: "Run" }]}
			/>
			{r.status === "ok" ? (
				<RunDetail run={r.value} />
			) : r.status === "refused" && r.code === "access_denied" ? (
				<Closed />
			) : r.status === "refused" ? (
				<Panel tone="neutral" title="There is no failed run here">
					This run does not exist, or it did not fail.
				</Panel>
			) : (
				<Panel tone="error" title="This run did not load">
					{LOAD_FAILED}
				</Panel>
			)}
		</>
	);
}

function RunDetail({ run: item }: { run: ReviewRun }) {
	return (
		<div className="grid items-start gap-5 app-lg:grid-cols-[minmax(0,1fr)_360px]">
			<Card className="gap-4">
				<CardHeader>
					<CardHeading>
						<CardTitle>Cause</CardTitle>
					</CardHeading>
					<CauseTag run={item} />
				</CardHeader>
				<p className="m-0 text-md text-ink">{CAUSE[item.cause].detail}</p>
				{item.violations.length ? (
					<KeyValueList>
						{item.violations.map((v, i) => (
							<KeyValue key={`${v.rule}-${v.where}-${i}`} size="sm" k={RULE[v.rule]} value={v.where} />
						))}
					</KeyValueList>
				) : null}
			</Card>
			<div className="flex flex-col gap-5">
				<Card className="gap-3">
					<CardHeader>
						<CardTitle>Run</CardTitle>
					</CardHeader>
					<KeyValueList>
						<KeyValue size="sm" k="Why it ran" value={DEMAND[item.demand]} />
						<KeyValue size="sm" k="As of" value={timeLabel(item.asOf)} />
						<KeyValue size="sm" k="Ended" value={timeLabel(item.settledAt)} />
						<KeyValue size="sm" k="Drafts" value={count(item.drafts)} />
						<KeyValue size="sm" k="Provider attempts" value={count(item.usage.attempts)} />
						<KeyValue size="sm" k="Input tokens" value={count(item.usage.inputTokens)} />
						<KeyValue size="sm" k="Output tokens" value={count(item.usage.outputTokens)} />
					</KeyValueList>
				</Card>
				<Card className="gap-3">
					<CardHeader>
						<CardTitle>Failed in a row</CardTitle>
					</CardHeader>
					<ol className="m-0 flex list-none flex-col gap-3 p-0">
						{item.streak.map((s) => (
							<li key={s.runId} className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-2">
								<span>{timeLabel(s.settledAt)}</span>
								<Tag tone="amber">{CAUSE[s.cause].label}</Tag>
							</li>
						))}
					</ol>
				</Card>
			</div>
		</div>
	);
}
