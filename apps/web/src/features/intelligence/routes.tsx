import { requireSeat } from "@/server/sign-in";
import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { NoChurchPlantSeat, PlantIntelligenceBlocked } from "../phases/PlantIntelligenceBlocked.tsx";
import { administers } from "../phases/server.ts";
import { AssessmentScreen } from "./AssessmentScreen.tsx";
import { loadAssessment, loadTrends } from "./assessment-server.ts";
import { AttestationsScreen } from "./AttestationsScreen.tsx";
import { TrendsScreen } from "./TrendsScreen.tsx";
import { CheckInScreen } from "./CheckInScreen.tsx";
import { CHECK_IN_PATH } from "./path.ts";
import { loadCheckIn } from "./server.ts";
import { loadAttestations } from "./signals-server.ts";
import { ZoneStep } from "./ZoneStep.tsx";

export const checkInMetadata: Metadata = { title: "Weekly check-in", robots: { index: false, follow: false } };

export async function CheckInPage() {
	const viewer = await requireSeat(CHECK_IN_PATH);
	if (!viewer) return <Blocked title="The weekly check-in belongs to a church plant">{SEAT_TEXT}</Blocked>;
	if (viewer.role === "member")
		return <Blocked title="The weekly check-in is for Owners and Admins">{SEAT_TEXT}</Blocked>;
	const loaded = await loadCheckIn(viewer);
	if (loaded.status === "refused" && loaded.error.code === "personal_timezone_confirmation_required")
		return <ZoneStep name={viewer.accountName} />;
	if (loaded.status !== "ok")
		return (
			<Blocked title="We could not load your check-in" tone="error">
				This is a loading problem. Your check-ins are safe. Reload the page in a moment.
			</Blocked>
		);
	return <CheckInScreen initial={loaded.value} name={viewer.accountName} />;
}

const SEAT_TEXT =
	"Only an Owner or Admin of a church plant has a weekly check-in. There is nothing to show for your seat.";

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
			<PageHeader size="xl" title="Weekly check-in" />
			<Card>
				<StatePanel tone={tone} icon={tone === "lock" ? LockKeyIcon : undefined} title={title} headingLevel="h2">
					{children}
				</StatePanel>
			</Card>
		</>
	);
}

export function CheckInLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading your check-in
			</span>
			<Skeleton className="h-14 w-80" />
			<div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Skeleton className="h-[520px]" />
				<Skeleton className="h-[520px]" />
			</div>
		</div>
	);
}

export const attestationsMetadata: Metadata = { title: "Attestations", robots: { index: false, follow: false } };

export async function AttestationsPage() {
	const viewer = await requireSeat("/intelligence/attestations");
	if (!viewer) return <NoChurchPlantSeat />;
	if (viewer.role === "member")
		return (
			<PlantIntelligenceBlocked title="Attestations are for Owners and Admins">
				Your Member seat does not include the church&apos;s attestations. Ask an Owner or Admin if you need them.
			</PlantIntelligenceBlocked>
		);
	const loaded = await loadAttestations(viewer);
	if (loaded.status !== "ok")
		return (
			<PlantIntelligenceBlocked title="We could not load the attestations" tone="error">
				This is a loading problem. Your answers are safe. Reload the page in a moment.
			</PlantIntelligenceBlocked>
		);
	return <AttestationsScreen initial={loaded.value} viewerName={viewer.accountName} />;
}

export function AttestationsLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading the attestations
			</span>
			<Skeleton className="h-14 w-80" />
			<Skeleton className="h-10 w-72 rounded-md" />
			<div className="grid grid-cols-4 gap-4 max-app-md:grid-cols-2">
				<Skeleton className="h-28" />
				<Skeleton className="h-28" />
				<Skeleton className="h-28" />
				<Skeleton className="h-28" />
			</div>
			<Skeleton className="h-72" />
		</div>
	);
}

export const intelligenceMetadata: Metadata = { title: "Plant Intelligence", robots: { index: false, follow: false } };
export const trendsMetadata: Metadata = { title: "Trends", robots: { index: false, follow: false } };

async function ownerOrAdmin(path: string) {
	const viewer = await requireSeat(path);
	if (!viewer) return { blocked: <NoChurchPlantSeat /> } as const;
	if (!administers(viewer))
		return {
			blocked: (
				<PlantIntelligenceBlocked title="Plant Intelligence is for Owners and Admins">
					Your Member seat does not include the church&apos;s Plant Intelligence. Ask an Owner or Admin if you need it.
				</PlantIntelligenceBlocked>
			),
		} as const;
	return { viewer } as const;
}
const loadFailed = (
	<PlantIntelligenceBlocked title="We could not load Plant Intelligence" tone="error">
		This is a loading problem. Your assessments are safe. Reload the page in a moment.
	</PlantIntelligenceBlocked>
);

export async function PlantIntelligencePage() {
	const seat = await ownerOrAdmin("/intelligence");
	if (!seat.viewer) return seat.blocked;
	const loaded = await loadAssessment(seat.viewer.authority);
	if (loaded.status !== "ok") return loadFailed;
	return <AssessmentScreen {...loaded.value} />;
}

export async function TrendsPage() {
	const seat = await ownerOrAdmin("/intelligence/trends");
	if (!seat.viewer) return seat.blocked;
	const loaded = await loadTrends(seat.viewer.authority);
	if (loaded.status !== "ok") return loadFailed;
	return <TrendsScreen {...loaded.value} />;
}

export function PlantIntelligenceLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading Plant Intelligence
			</span>
			<Skeleton className="h-14 w-80" />
			<Skeleton className="h-10 w-96 max-w-full rounded-md" />
			<Skeleton className="h-28" />
			<div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-5 max-app-md:grid-cols-1">
				<Skeleton className="h-[300px]" />
				<Skeleton className="h-[300px]" />
			</div>
		</div>
	);
}
