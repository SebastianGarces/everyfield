import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { DASHBOARD_HOME, landingFor } from "@everyfield/contracts/identity";
import { dashboardReader } from "@everyfield/domain/dashboard";
import { PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ActivityCard, CardFailed, CardLoading, LaunchCard, MetricsCards, MetricsLoading } from "./cards.tsx";
import { GetStarted, QuickActions } from "./client.tsx";
import { phaseText } from "./model.ts";
import { loadActivity, loadFrame, loadLaunch, loadMetrics } from "./server.ts";

// The /overview route (WP-048), a church plant's home. apps/web/src/app/(product)/(frame)/overview/ only re-exports
// these. The server decides who may see it from the seat and the saved setup (ADM-004); each card then reads on its
// own and streams in behind its own loading state.

export const overviewMetadata: Metadata = { title: "Overview", robots: { index: false, follow: false } };

export async function OverviewPage() {
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated")
		redirect(`/signin?returnTo=${encodeURIComponent(DASHBOARD_HOME)}`);
	const db = requestDatabase();
	const plant =
		viewer.status === "active" && db ? await dashboardReader.resolveHome(db, viewer.authority ?? null) : "none";
	// An unfinished church goes back to its setup step, an organization seat to its home, an account to Discovery.
	const home = landingFor({ status: viewer.status, plant });
	if (home !== DASHBOARD_HOME) redirect(home);

	const frame = await loadFrame();
	if (frame.status === "denied")
		return (
			<StatePanel tone="lock" title="You do not have access to this church">
				Your seat in this church ended, or it changed while you were signed in. Reload the page, or ask one of its
				Owners to invite you again.
			</StatePanel>
		);
	const ready = frame.status === "ok" ? frame.value : null;
	const failed = frame.status === "lost" ? frame : null;
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				size="xl"
				title="Overview"
				subtitle={
					ready
						? `${ready.plantName} · ${phaseText(ready.phase)}`
						: "Your church's name and phase could not load. Reload the page in a moment."
				}
				className="mb-1"
			/>
			{ready ? <GetStarted frame={ready} /> : null}
			{failed ? <CardFailed what="Your next steps" loaded={failed} /> : null}
			<Suspense fallback={<MetricsLoading />}>
				<Metrics />
			</Suspense>
			<div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Suspense fallback={<CardLoading label="recent changes" height={520} />}>
					<RecentChanges />
				</Suspense>
				<div className="flex flex-col gap-5">
					<Suspense fallback={<CardLoading label="Launch Sunday" />}>
						<Launch admin={ready ? ready.role !== "member" : false} />
					</Suspense>
					{ready ? <QuickActions actions={ready.actions} /> : null}
				</div>
			</div>
		</div>
	);
}

async function Metrics() {
	return <MetricsCards loaded={await loadMetrics()} />;
}
async function RecentChanges() {
	return <ActivityCard loaded={await loadActivity()} />;
}
async function Launch({ admin }: { admin: boolean }) {
	return <LaunchCard loaded={await loadLaunch()} admin={admin} />;
}

/** The first paint while the page decides and reads: its shape, not a spinner. */
export function OverviewLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading your overview
			</span>
			<Skeleton className="h-14 w-72 rounded-card" />
			<MetricsLoading />
			<div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<CardLoading label="recent changes" height={520} />
				<CardLoading label="Launch Sunday" />
			</div>
		</div>
	);
}
