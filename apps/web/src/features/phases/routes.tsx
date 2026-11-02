import { getViewer } from "@/server/request-context";
import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { JourneyScreen } from "./JourneyScreen.tsx";
import { administers, loadJourney, phaseViewer } from "./server.ts";

// The /intelligence route (WP-038 builds its phase card, journey and timeline; WP-044 adds the rest of Plant
// Intelligence). apps/web/src/app/(product)/(frame)/intelligence/ only re-exports these.

export const intelligenceMetadata: Metadata = { title: "Plant Intelligence", robots: { index: false, follow: false } };

export async function IntelligencePage() {
	const viewer = await phaseViewer();
	if (!viewer) {
		const v = await getViewer();
		if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent("/intelligence")}`);
		return (
			<Blocked title="Plant Intelligence belongs to a church plant">
				Your account has no current seat in a church plant, so there is no journey to show here.
			</Blocked>
		);
	}
	// The journey and its phase controls are for Owners and Admins (phases.readHistory authority).
	if (!administers(viewer))
		return (
			<Blocked title="The journey is for Owners and Admins">
				Your Member seat does not include the church&apos;s phase journey. Ask an Owner or Admin if you need it.
			</Blocked>
		);
	const loaded = await loadJourney(viewer);
	if (loaded.status !== "ok")
		return (
			<Blocked title="We could not load the journey" tone="error">
				This is a loading problem. The journey is safe. Reload the page in a moment.
			</Blocked>
		);
	return <JourneyScreen {...loaded.value} viewer={{ accountId: viewer.accountId, name: viewer.displayName }} />;
}

function Blocked({
	title,
	tone = "lock",
	children,
}: {
	title: string;
	tone?: "lock" | "error";
	children: React.ReactNode;
}) {
	return (
		<>
			<PageHeader size="xl" title="Plant Intelligence" />
			<Card>
				<StatePanel tone={tone} icon={tone === "lock" ? LockKeyIcon : undefined} title={title} headingLevel="h2">
					{children}
				</StatePanel>
			</Card>
		</>
	);
}

/** The first paint while the journey loads: its shape, not a spinner. */
export function IntelligenceLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading the journey
			</span>
			<Skeleton className="h-14 w-72 rounded-card" />
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1.1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Skeleton className="h-80 rounded-card" />
				<Skeleton className="h-80 rounded-card" />
			</div>
		</div>
	);
}
