import { feedbackCategory, feedbackStatus } from "@everyfield/contracts/feedback";
import { Card, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { OwnFeedbackList, OwnFeedbackItem } from "./OwnFeedback.tsx";
import { feedbackWriter, publicationSetup, run, type Run } from "./server.ts";
import { TriageItem, TriageList } from "./Triage.tsx";

export const sentFeedbackMetadata: Metadata = { title: "Sent feedback", robots: { index: false, follow: false } };
export const triageMetadata: Metadata = { title: "Feedback triage", robots: { index: false, follow: false } };

const SENT = [{ label: "Sent feedback", href: "/feedback" }];
const TRIAGE = [{ label: "Feedback triage", href: "/feedback/triage" }];

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
const LOAD_FAILED = "This is a loading problem, not an empty list. Nothing was changed. Reload the page in a moment.";

export async function SentFeedbackPage() {
	const r = settled(await run((db, a) => feedbackWriter.listOwn(db, a, {})), "/feedback");
	return (
		<>
			<PageHeader
				title="Sent feedback"
				subtitle="What you sent with Send feedback, and where it stands. The Everyfield team reads every message."
			/>
			{r.status === "ok" ? (
				<OwnFeedbackList initial={r.value} />
			) : (
				<Panel tone="error" title="Your feedback did not load">
					{LOAD_FAILED}
				</Panel>
			)}
		</>
	);
}

export async function OwnFeedbackPage({ params }: { params: Promise<{ feedbackId: string }> }) {
	const { feedbackId } = await params;
	const r = settled(
		await run((db, a) => feedbackWriter.getOwnStatus(db, a, { feedbackId })),
		`/feedback/${feedbackId}`,
	);
	return (
		<>
			<PageHeader title="Feedback" breadcrumb={[...SENT, { label: "Feedback" }]} />
			{r.status === "ok" ? (
				<OwnFeedbackItem item={r.value} />
			) : r.status === "refused" ? (
				<Panel tone="neutral" title="There is no feedback here">
					This feedback does not exist, or it was sent from another account.
				</Panel>
			) : (
				<Panel tone="error" title="This feedback did not load">
					{LOAD_FAILED}
				</Panel>
			)}
		</>
	);
}

function TriageClosed() {
	return (
		<Panel tone="lock" title="Feedback triage needs a triage grant">
			Only an Everyfield team member with feedback triage access sees other people&rsquo;s feedback. A church role does
			not give that access.
		</Panel>
	);
}

export async function TriagePage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const raw = await searchParams;
	const filter = {
		status: feedbackStatus.safeParse(raw.status).data ?? null,
		category: feedbackCategory.safeParse(raw.category).data ?? null,
	};
	const r = settled(await run((db, a) => feedbackWriter["admin.list"](db, a, filter)), "/feedback/triage");
	return (
		<>
			<PageHeader title="Feedback triage" subtitle="Private feedback from every account. It never leaves Everyfield." />
			{r.status === "ok" ? (
				<TriageList
					key={`${filter.status}-${filter.category}`}
					initial={r.value}
					filter={filter}
					setup={publicationSetup()}
				/>
			) : r.status === "refused" ? (
				<TriageClosed />
			) : (
				<Panel tone="error" title="Feedback did not load">
					{LOAD_FAILED}
				</Panel>
			)}
		</>
	);
}

export async function TriageItemPage({ params }: { params: Promise<{ feedbackId: string }> }) {
	const { feedbackId } = await params;
	const r = settled(
		await run((db, a) => feedbackWriter["admin.get"](db, a, { feedbackId })),
		`/feedback/triage/${feedbackId}`,
	);
	return (
		<>
			<PageHeader title="Feedback" breadcrumb={[...TRIAGE, { label: "Feedback" }]} />
			{r.status === "ok" ? (
				<TriageItem initial={r.value} setup={publicationSetup()} />
			) : r.status === "refused" && r.code === "access_denied" ? (
				<TriageClosed />
			) : r.status === "refused" ? (
				<Panel tone="neutral" title="There is no feedback here">
					This feedback does not exist.
				</Panel>
			) : (
				<Panel tone="error" title="This feedback did not load">
					{LOAD_FAILED}
				</Panel>
			)}
		</>
	);
}
