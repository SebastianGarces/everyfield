import { LockKeyIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { recordId } from "@everyfield/contracts/common";
import {
	buttonVariants,
	Card,
	EmptyState,
	IntentLink,
	PageHeader,
	Skeleton,
	StatePanel,
} from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { plantViewer } from "../meetings/server.ts";
import { isAdmin, loadTeam, loadTeams, type Viewer } from "./server.ts";
import { TeamScreen } from "./TeamScreen.tsx";
import { TeamsScreen } from "./TeamsScreen.tsx";

// The ministries routes. The files under apps/web/src/app/ only re-export these, so the screens, their data loading
// and their states stay in this feature folder.

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
						<StatePanel tone="lock" icon={LockKeyIcon} title="Ministries are not part of your seat" headingLevel="h2">
							Ministries belong to a church plant workspace. Your account has no current seat in one, so there is
							nothing to show here.
						</StatePanel>
					) : (
						<StatePanel tone="error" title="We could not load ministries" headingLevel="h2">
							This is a loading problem. Nothing was changed. Try again in a moment.
						</StatePanel>
					)}
				</Card>
			</>
		),
	};
}

type Search = Promise<Record<string, string | string[] | undefined>>;

export const teamsMetadata: Metadata = { title: "Ministries", robots: { index: false, follow: false } };
export async function TeamsPage({ searchParams }: { searchParams: Search }) {
	const tab = (await searchParams).view === "chart" ? "chart" : "teams";
	const g = await gate(tab === "chart" ? "/ministries?view=chart" : "/ministries", "Ministries");
	if ("blocked" in g) return g.blocked;
	return <TeamsScreen view={await loadTeams(g.viewer)} tab={tab} admin={isAdmin(g.viewer)} />;
}

export const teamMetadata: Metadata = { title: "Ministry", robots: { index: false, follow: false } };
export async function TeamPage({ params: route }: { params: Promise<{ teamId: string }> }) {
	const raw = (await route).teamId;
	const g = await gate(`/ministries/${encodeURIComponent(raw)}`, "Ministry");
	if ("blocked" in g) return g.blocked;
	const id = recordId.safeParse(raw);
	if (!id.success) notFound();
	const loaded = await loadTeam(g.viewer, id.data);
	if (loaded.status === "missing") notFound();
	if (loaded.status === "failed")
		return (
			<>
				<PageHeader
					title="Ministry"
					breadcrumb={[{ label: "Ministries", href: "/ministries" }, { label: "Ministry" }]}
				/>
				<Card>
					<StatePanel tone="error" title="This ministry did not load" headingLevel="h2">
						This is a loading problem. Nothing was changed. Reload the page in a moment.
					</StatePanel>
				</Card>
			</>
		);
	return <TeamScreen key={loaded.team.id} data={loaded} />;
}

/** A ministry that is not here: missing, in another church or a malformed link all read the same. */
export function TeamNotFound() {
	return (
		<>
			<PageHeader
				title="Ministry not found"
				breadcrumb={[{ label: "Ministries", href: "/ministries" }, { label: "Not found" }]}
			/>
			<Card>
				<EmptyState
					icon={UserGroupIcon}
					title="This ministry is not here"
					headingLevel="h2"
					action={
						<IntentLink href="/ministries" className={buttonVariants({ variant: "primary" })}>
							Back to Ministries
						</IntentLink>
					}
				>
					The link may be old, or the ministry belongs to another church.
				</EmptyState>
			</Card>
		</>
	);
}

/** The first paint while a ministries page loads: the page's shape, not a spinner. */
export function TeamsLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading ministries
			</span>
			<Skeleton className="h-14 w-60 rounded-card" />
			<div className="grid grid-cols-3 gap-5 max-app-lg:grid-cols-2 max-app-sm:grid-cols-1">
				<Skeleton className="h-[150px] rounded-card" />
				<Skeleton className="h-[150px] rounded-card" />
				<Skeleton className="h-[150px] rounded-card max-app-sm:hidden" />
			</div>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4">
				{Array.from({ length: 6 }, (_, i) => (
					<Skeleton key={i} className="h-[184px] rounded-card" />
				))}
			</div>
		</div>
	);
}
