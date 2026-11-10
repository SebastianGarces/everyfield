import { getViewer } from "@/server/request-context";
import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NoChurchPlantSeat, PlantIntelligenceBlocked } from "../phases/PlantIntelligenceBlocked.tsx";
import { AttestationsScreen } from "./AttestationsScreen.tsx";
import { CheckInScreen } from "./CheckInScreen.tsx";
import { CHECK_IN_PATH } from "./path.ts";
import { careViewer, loadCheckIn } from "./server.ts";
import { loadAttestations } from "./signals-server.ts";
import { ZoneStep } from "./ZoneStep.tsx";

// The /me/check-in route (WP-039): the private weekly check-in of a church plant's Owner or Admin.
// apps/web/src/app/(product)/(frame)/me/check-in/ only re-exports these. The page takes no address parameters: the
// author is always the signed-in account.

export const checkInMetadata: Metadata = { title: "Weekly check-in", robots: { index: false, follow: false } };

export async function CheckInPage() {
	const viewer = await careViewer();
	if (!viewer) {
		const v = await getViewer();
		if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent(CHECK_IN_PATH)}`);
		return <Blocked title="The weekly check-in belongs to a church plant">{SEAT_TEXT}</Blocked>;
	}
	// The check-in is for a plant's Owners and Admins only (privateCare.* authority). A Member has no page.
	if (viewer.role === "member")
		return <Blocked title="The weekly check-in is for Owners and Admins">{SEAT_TEXT}</Blocked>;
	const loaded = await loadCheckIn(viewer);
	if (loaded.status === "refused" && loaded.error.code === "personal_timezone_confirmation_required")
		return <ZoneStep name={viewer.displayName} />;
	if (loaded.status !== "ok")
		return (
			<Blocked title="We could not load your check-in" tone="error">
				This is a loading problem. Your check-ins are safe. Reload the page in a moment.
			</Blocked>
		);
	return <CheckInScreen initial={loaded.value} name={viewer.displayName} />;
}

const SEAT_TEXT =
	"Only an Owner or Admin of a church plant has a weekly check-in. There is nothing to show for your seat.";

function Blocked({
	title,
	tone = "lock",
	heading = "Weekly check-in",
	children,
}: {
	title: string;
	tone?: "lock" | "error";
	/** The page's own title: this state stands in for the whole page. */
	heading?: string;
	children: React.ReactNode;
}) {
	return (
		<>
			<PageHeader size="xl" title={heading} />
			<Card>
				<StatePanel tone={tone} icon={tone === "lock" ? LockKeyIcon : undefined} title={title} headingLevel="h2">
					{children}
				</StatePanel>
			</Card>
		</>
	);
}

/** The first paint while the check-in loads: its shape, not a spinner. */
export function CheckInLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading your check-in
			</span>
			<Skeleton className="h-14 w-80 rounded-card" />
			<div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Skeleton className="h-[520px] rounded-card" />
				<Skeleton className="h-[520px] rounded-card" />
			</div>
		</div>
	);
}

// The Attestations page (WP-039 slice 2): /intelligence/attestations. A Member and a signed-in account without a
// church-plant seat get the same lock page that /intelligence shows them, inside the app frame, and no attestations read.
export const attestationsMetadata: Metadata = { title: "Attestations", robots: { index: false, follow: false } };

export async function AttestationsPage() {
	const viewer = await careViewer();
	if (!viewer) {
		const v = await getViewer();
		if (!v || v.status === "unauthenticated")
			redirect(`/signin?returnTo=${encodeURIComponent("/intelligence/attestations")}`);
		return <NoChurchPlantSeat />;
	}
	// Attestations are for a plant's Owners and Admins only (signals authority).
	if (viewer.role === "member")
		return (
			<PlantIntelligenceBlocked title="Attestations are for Owners and Admins">
				Your Member seat does not include the church&apos;s attestations. Ask an Owner or Admin if you need them.
			</PlantIntelligenceBlocked>
		);
	const loaded = await loadAttestations(viewer);
	if (loaded.status !== "ok")
		return (
			<Blocked title="We could not load the attestations" tone="error" heading="Attestations">
				This is a loading problem. Your answers are safe. Reload the page in a moment.
			</Blocked>
		);
	return <AttestationsScreen initial={loaded.value} viewerName={viewer.displayName} />;
}

/** The first paint while the attestations load: their shape, not a spinner. */
export function AttestationsLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading the attestations
			</span>
			<Skeleton className="h-14 w-80 rounded-card" />
			<Skeleton className="h-10 w-72 rounded-md" />
			<div className="grid grid-cols-4 gap-4 max-app-md:grid-cols-2">
				<Skeleton className="h-28 rounded-card" />
				<Skeleton className="h-28 rounded-card" />
				<Skeleton className="h-28 rounded-card" />
				<Skeleton className="h-28 rounded-card" />
			</div>
			<Skeleton className="h-72 rounded-card" />
		</div>
	);
}
