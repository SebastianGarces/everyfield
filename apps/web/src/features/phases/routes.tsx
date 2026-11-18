import { getViewer } from "@/server/request-context";
import { Skeleton } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { JourneyScreen } from "./JourneyScreen.tsx";
import { NoChurchPlantSeat, PlantIntelligenceBlocked } from "./PlantIntelligenceBlocked.tsx";
import { administers, loadJourney, phaseViewer } from "./server.ts";

export const journeyMetadata: Metadata = { title: "Journey", robots: { index: false, follow: false } };

export async function JourneyPage() {
	const viewer = await phaseViewer();
	if (!viewer) {
		const v = await getViewer();
		if (!v || v.status === "unauthenticated")
			redirect(`/signin?returnTo=${encodeURIComponent("/intelligence/journey")}`);
		return <NoChurchPlantSeat />;
	}
	if (!administers(viewer))
		return (
			<PlantIntelligenceBlocked title="The journey is for Owners and Admins">
				Your Member seat does not include the church&apos;s phase journey. Ask an Owner or Admin if you need it.
			</PlantIntelligenceBlocked>
		);
	const loaded = await loadJourney(viewer);
	if (loaded.status !== "ok")
		return (
			<PlantIntelligenceBlocked title="We could not load the journey" tone="error">
				This is a loading problem. The journey is safe. Reload the page in a moment.
			</PlantIntelligenceBlocked>
		);
	return <JourneyScreen {...loaded.value} viewer={{ accountId: viewer.accountId, name: viewer.displayName }} />;
}

export function IntelligenceLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading the journey
			</span>
			<Skeleton className="h-14 w-72" />
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1.1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Skeleton className="h-80" />
				<Skeleton className="h-80" />
			</div>
		</div>
	);
}
