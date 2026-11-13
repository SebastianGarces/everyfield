import {
	loadDirectory,
	loadPlant,
	loadRoster,
	loadSendingChurch,
	oversightViewer,
	type Loaded,
	type OversightViewer,
} from "@/server/oversight";
import { Button, Card, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { NotAvailable } from "../access/AccessStates";
import { DirectoryScreen, PlantScreen, RosterScreen, SendingChurchScreen } from "./screens.tsx";

// The /network routes (WP-047a): the organization home, one plant, and a network's sending churches.
// apps/web/src/app/(product)/(frame)/network/ only re-exports these. A plant this organization is not linked to now, a
// plant that does not exist and a sending church a network does not have all render the same not-found page, with a 404
// status: the pages have no loading boundary, so nothing streams before the read decides.

const hidden = { robots: { index: false, follow: false } } as const;
export const networkMetadata: Metadata = { title: "Plants", ...hidden };
export const plantMetadata: Metadata = { title: "Plant", ...hidden };
export const rosterMetadata: Metadata = { title: "Sending churches", ...hidden };
export const sendingChurchMetadata: Metadata = { title: "Sending church", ...hidden };

type Params<K extends string> = { params: Promise<Record<K, string>> };

/** The organization seat for this page; a sign-in for a signed-out reader, the refusal page for anyone else. */
async function organizationOnly(path: string, page: (viewer: OversightViewer) => Promise<ReactNode>) {
	const who = await oversightViewer();
	if (who.kind === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(path)}`);
	if (who.kind !== "organization")
		return (
			<Card className="mx-auto mt-12 max-w-[560px]">
				<NotAvailable scope="page" homeHref="/home" />
			</Card>
		);
	return page(who.viewer);
}

/** A loaded page body: the screen, the shared not-found page, or a load failure that says so. */
function shown<T>(loaded: Loaded<T>, screen: (value: T) => ReactNode) {
	if (loaded.status === "missing") notFound();
	if (loaded.status === "lost")
		return (
			<Card className="mx-auto mt-12 max-w-[560px]">
				<StatePanel
					tone="error"
					title="We couldn't load this page"
					headingLevel="h1"
					actions={
						<Button asChild variant="primary">
							<a href="">Try again</a>
						</Button>
					}
				>
					This is a loading problem. Nothing was changed. Reload the page in a moment.
				</StatePanel>
			</Card>
		);
	return screen(loaded.value);
}

export async function NetworkPage() {
	return organizationOnly("/network", async (viewer) =>
		shown(await loadDirectory(viewer), (directory) => (
			<DirectoryScreen directory={directory} kind={viewer.organizationKind} />
		)),
	);
}

export async function PlantPage({ params }: Params<"plantId">) {
	const { plantId } = await params;
	return organizationOnly(`/network/plants/${plantId}`, async (viewer) =>
		shown(await loadPlant(viewer, plantId), (view) => <PlantScreen view={view} />),
	);
}

/** A network's roster. A sending church seat has no roster: its address is not found, as for any other unknown page. */
export async function RosterPage() {
	return organizationOnly("/network/sending-churches", async (viewer) =>
		shown(await loadRoster(viewer), (roster) => <RosterScreen roster={roster} />),
	);
}

export async function SendingChurchPage({ params }: Params<"churchId">) {
	const { churchId } = await params;
	return organizationOnly(`/network/sending-churches/${churchId}`, async (viewer) =>
		shown(await loadSendingChurch(viewer, churchId), (church) => <SendingChurchScreen church={church} />),
	);
}
