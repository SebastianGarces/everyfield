import { getViewer } from "@/server/request-context";
import { Clock01Icon, LockKeyIcon } from "@hugeicons/core-free-icons";
import { buttonVariants, Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckInScreen } from "./CheckInScreen.tsx";
import { CheckInHeader } from "./Header.tsx";
import { CHECK_IN_PATH } from "./path.ts";
import { careViewer, loadCheckIn } from "./server.ts";

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
		return <ConfirmZone name={viewer.displayName} />;
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

/** No personal time zone yet: the week starts on the author's own Monday, so the zone comes first (REQ-IDN-033). */
function ConfirmZone({ name }: { name: string }) {
	return (
		<>
			<CheckInHeader name={name} subtitle="A short check-in for you, not for the church." />
			<Card className="max-w-[720px]">
				<StatePanel
					tone="lock"
					icon={Clock01Icon}
					title="First, choose your time zone"
					headingLevel="h2"
					actions={
						<Link
							href="/settings/account"
							className={buttonVariants({ variant: "primary", className: "cursor-pointer" })}
						>
							Choose your time zone
						</Link>
					}
				>
					Your check-in week starts on Monday at midnight where you are. Everyfield does not guess your time zone from
					your church or your device. Choose it once in Settings, then come back here.
				</StatePanel>
			</Card>
		</>
	);
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
			<PageHeader size="xl" title="Weekly check-in" />
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
