import { getViewer } from "@/server/request-context";
import { Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LaunchScreen } from "./LaunchScreen.tsx";
import { administers, launchViewer, loadPlan } from "./server.ts";

// The /launch route (WP-045). apps/web/src/app/(product)/(frame)/launch/ only re-exports these.

export const launchMetadata: Metadata = { title: "Launch plan", robots: { index: false, follow: false } };

export async function LaunchPage() {
	const viewer = await launchViewer();
	if (!viewer) {
		const v = await getViewer();
		if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent("/launch")}`);
		return (
			<StatePanel tone="lock" title="The Launch plan belongs to a church">
				Choose a church plant seat to see its Launch plan.
			</StatePanel>
		);
	}
	const loaded = await loadPlan(viewer);
	// A failed load is never "no launch date": the page says it could not load (LCH-008).
	if (loaded.status !== "ok")
		return (
			<StatePanel tone="error" title="The Launch plan could not load">
				This is a loading problem. Your Launch plan is safe. Reload the page in a moment.
			</StatePanel>
		);
	return <LaunchScreen plan={loaded.value} viewer={{ accountId: viewer.accountId, admin: administers(viewer) }} />;
}

/** The first paint while the plan loads: its shape, not a spinner. */
export function LaunchLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading the Launch plan
			</span>
			<Skeleton className="h-14 w-72 rounded-card" />
			<div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)] gap-5 max-app-md:grid-cols-1">
				<Skeleton className="h-72 rounded-card" />
				<Skeleton className="h-72 rounded-card" />
			</div>
			<Skeleton className="h-96 rounded-card" />
		</div>
	);
}
