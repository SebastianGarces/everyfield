import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { Card, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { CommunicationScreen } from "./CommunicationScreen.tsx";
import { canWrite, communicationViewer, loadCommunicationPage, type Viewer } from "./server.ts";

// The Messages route. apps/web/src/app only re-exports this module. The screen and its states stay in this feature.

/** Signed out goes to sign-in and comes back. No plant seat sees a lock. A broken setup sees an error. */
async function gate(returnTo: string, title: string): Promise<{ viewer: Viewer } | { blocked: ReactNode }> {
	const seat = await communicationViewer();
	if (seat.signedOut) redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
	if (seat.viewer) return { viewer: seat.viewer };
	return {
		blocked: (
			<>
				<PageHeader size="xl" title={title} />
				<Card>
					{seat.ok ? (
						<StatePanel tone="lock" icon={LockKeyIcon} title="Messages are not part of your seat" headingLevel="h2">
							Messages belong to a church plant workspace. Your account has no current seat in one, so there is nothing
							to show here.
						</StatePanel>
					) : (
						<StatePanel tone="error" title="Messages did not load" headingLevel="h2">
							This is a loading problem. Nothing was changed. Try again in a moment.
						</StatePanel>
					)}
				</Card>
			</>
		),
	};
}

export const communicationMetadata: Metadata = { title: "Messages", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

export async function CommunicationPage({ searchParams }: { searchParams?: Search }) {
	// The address is read on the client from useSearchParams. This awaits it so the page stays dynamic.
	if (searchParams) await searchParams;
	const g = await gate("/communication", "Messages");
	if ("blocked" in g) return g.blocked;
	const loaded = await loadCommunicationPage(g.viewer);
	if (loaded.status !== "ok") {
		return (
			<>
				<PageHeader size="xl" title="Messages" />
				<Card>
					<StatePanel tone="error" title="Messages did not load" headingLevel="h2">
						This is a loading problem. Nothing was changed. Reload the page in a moment.
					</StatePanel>
				</Card>
			</>
		);
	}
	return <CommunicationScreen data={loaded.value} canWrite={canWrite(g.viewer)} />;
}
