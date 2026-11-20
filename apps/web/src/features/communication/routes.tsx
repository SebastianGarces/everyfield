import { signIn } from "@/server/sign-in";
import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { Card, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { CommunicationScreen } from "./CommunicationScreen.tsx";
import { parseRoute, routeHref } from "./model.ts";
import { params } from "../../components/search-params.ts";
import { canWrite } from "../../components/seat-role.ts";
import { communicationViewer, isReviewedFollowUp, loadCommunicationPage, type Viewer } from "./server.ts";

async function gate(returnTo: string, title: string): Promise<{ viewer: Viewer } | { blocked: ReactNode }> {
	const seat = await communicationViewer();
	if (seat.signedOut) signIn(returnTo);
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
	const query = searchParams ? Object.fromEntries(params(await searchParams)) : {};
	const g = await gate("/communication", "Messages");
	if ("blocked" in g) return g.blocked;
	const route = parseRoute(query);
	if (route.kind === "compose" && route.id === "new" && !route.handoff && route.step !== "who")
		redirect(routeHref({ ...route, step: "who" }));
	if (route.kind === "history" && route.message && (await isReviewedFollowUp(g.viewer, route.message)))
		redirect(routeHref({ kind: "compose", id: route.message, step: "review", handoff: null }));
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
