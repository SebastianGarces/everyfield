import { requestDatabase } from "@/server/database";
import { Calendar03Icon, LockKeyIcon } from "@hugeicons/core-free-icons";
import { meetingId as meetingIdSchema, rsvpToken } from "@everyfield/contracts/meetings";
import { describeRsvpToken } from "@everyfield/domain/meetings";
import { buttonVariants, Card, EmptyState, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import { TableSkeleton } from "@everyfield/ui/display";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { MeetingScreen } from "./MeetingScreen.tsx";
import { MeetingsScreen } from "./MeetingsScreen.tsx";
import { parseQuery, querySearch } from "./model.ts";
import { RsvpScreen } from "./RsvpScreen.tsx";
import { canWrite, loadMeeting, loadMeetings, plantViewer, type Viewer } from "./server.ts";

// The meetings routes. The files under apps/web/src/app/ only re-export these, so the screens, their data loading and
// their states stay in this feature folder.

type Search = Promise<Record<string, string | string[] | undefined>>;
const params = (raw: Record<string, string | string[] | undefined>) => {
	const out = new URLSearchParams();
	for (const [k, v] of Object.entries(raw)) for (const one of [v ?? []].flat()) out.append(k, one);
	return out;
};

/** Signed out goes to sign-in and comes back; no seat in a plant sees a lock; a broken setup sees an error. */
async function gate(returnTo: string, title: string): Promise<{ viewer: Viewer } | { blocked: ReactNode }> {
	const v = await plantViewer();
	if (v.signedOut) redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
	if (v.viewer) return { viewer: v.viewer };
	return {
		blocked: (
			<>
				<PageHeader size="xl" title={title} />
				<Card>
					{v.ok ? (
						<StatePanel tone="lock" icon={LockKeyIcon} title="Meetings are not part of your seat" headingLevel="h2">
							Meetings belong to a church plant workspace. Your account has no current seat in one, so there is nothing
							to show here.
						</StatePanel>
					) : (
						<StatePanel tone="error" title="We could not load meetings" headingLevel="h2">
							This is a loading problem. Nothing was changed. Try again in a moment.
						</StatePanel>
					)}
				</Card>
			</>
		),
	};
}

export const meetingsMetadata: Metadata = { title: "Meetings", robots: { index: false, follow: false } };
export async function MeetingsPage({ searchParams }: { searchParams: Search }) {
	const query = parseQuery(params(await searchParams));
	const g = await gate("/meetings" + querySearch(query), "Meetings");
	if ("blocked" in g) return g.blocked;
	return <MeetingsScreen view={await loadMeetings(g.viewer, query)} canWrite={canWrite(g.viewer)} />;
}

export const meetingMetadata: Metadata = { title: "Meeting", robots: { index: false, follow: false } };
export async function MeetingPage({ params: route }: { params: Promise<{ meetingId: string }> }) {
	const raw = (await route).meetingId;
	const g = await gate(`/meetings/${encodeURIComponent(raw)}`, "Meeting");
	if ("blocked" in g) return g.blocked;
	const id = meetingIdSchema.safeParse(raw);
	if (!id.success) notFound();
	const loaded = await loadMeeting(g.viewer, id.data);
	if (loaded.status === "missing") notFound();
	if (loaded.status === "failed")
		return (
			<>
				<PageHeader title="Meeting" breadcrumb={[{ label: "Meetings", href: "/meetings" }, { label: "Meeting" }]} />
				<Card>
					<StatePanel tone="error" title="This meeting did not load" headingLevel="h2">
						This is a loading problem. Nothing was changed. Reload the page in a moment.
					</StatePanel>
				</Card>
			</>
		);
	return <MeetingScreen key={loaded.meeting.id} data={loaded} canWrite={canWrite(g.viewer)} />;
}

/** A meeting that is not here: missing, deleted, in another church or a malformed link all read the same. */
export function MeetingNotFound() {
	return (
		<>
			<PageHeader
				title="Meeting not found"
				breadcrumb={[{ label: "Meetings", href: "/meetings" }, { label: "Not found" }]}
			/>
			<Card>
				<EmptyState
					icon={Calendar03Icon}
					title="This meeting is not here"
					headingLevel="h2"
					action={
						<Link href="/meetings" className={buttonVariants({ variant: "primary" })}>
							Back to Meetings
						</Link>
					}
				>
					The link may be old, the meeting may have been deleted, or it belongs to another church.
				</EmptyState>
			</Card>
		</>
	);
}

/** The first paint while a meetings page loads: the page's shape, not a spinner. */
export function MeetingsLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading meetings
			</span>
			<Skeleton className="h-14 w-60 rounded-card" />
			<Skeleton className="h-[120px] rounded-card" />
			<Card className="gap-4">
				<div className="flex flex-wrap gap-3">
					<Skeleton className="h-10 w-48 rounded-md" />
					<Skeleton className="h-10 w-72 rounded-md" />
				</div>
				<TableSkeleton rows={6} />
			</Card>
		</div>
	);
}

export const rsvpMetadata: Metadata = {
	title: "Your invitation",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};
/** The public RSVP link (COM-010): no session. Opening it only reads; a malformed token reads as unavailable. */
export async function RsvpPage({ params: route }: { params: Promise<{ token: string }> }) {
	const raw = (await route).token;
	const token = rsvpToken.safeParse(raw);
	const db = requestDatabase();
	const view =
		token.success && db ? await describeRsvpToken(db, { token: token.data }) : ({ state: "unavailable" } as const);
	return <RsvpScreen token={raw} view={view} />;
}
