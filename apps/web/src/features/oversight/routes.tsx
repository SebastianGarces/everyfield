import {
	loadDirectory,
	loadIntelligence,
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
import { cache, type ReactNode } from "react";
import { NotAvailable } from "../access/AccessStates";
import { level, type Level } from "@everyfield/contracts/oversight";
import { intelligenceWords } from "./model.ts";
import { DirectoryScreen, IntelligenceScreen, PlantScreen, RosterScreen, SendingChurchScreen } from "./screens.tsx";

const hidden = { robots: { index: false, follow: false } } as const;
export const networkMetadata: Metadata = { title: "Plants", ...hidden };
export const plantMetadata: Metadata = { title: "Plant", ...hidden };
export const rosterMetadata: Metadata = { title: "Sending churches", ...hidden };
export const sendingChurchMetadata: Metadata = { title: "Sending church", ...hidden };

const organizationViewer = cache(oversightViewer);

type Params<K extends string> = { params: Promise<Record<K, string>> };

async function organizationOnly(path: string, page: (viewer: OversightViewer) => Promise<ReactNode>) {
	const who = await organizationViewer();
	if (who.kind === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(path)}`);
	if (who.kind !== "organization")
		return (
			<Card className="mx-auto mt-12 max-w-[560px]">
				<NotAvailable scope="page" homeHref="/home" />
			</Card>
		);
	return page(who.viewer);
}

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

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type SearchParams = Awaited<Search["searchParams"]>;
const intelligenceQuery = (q: SearchParams) => ({
	shownLevel: level.catch("portfolio").parse(typeof q.level === "string" ? q.level : undefined),
	run: typeof q.run === "string" ? q.run : null,
});
const intelligenceFor = cache(async (viewer: OversightViewer, shownLevel: Level, run: string | null) =>
	loadIntelligence(viewer, shownLevel, run),
);

export async function intelligenceMetadata({ searchParams }: Search): Promise<Metadata> {
	const who = await organizationViewer();
	if (who.kind !== "organization") return { title: "Intelligence", ...hidden };
	const { shownLevel, run } = intelligenceQuery(await searchParams);
	const loaded = await intelligenceFor(who.viewer, shownLevel, run);
	const kind = who.viewer.organizationKind;
	if (loaded.status === "ok") return { title: intelligenceWords(kind, loaded.value.organizationName).title, ...hidden };
	return { title: kind === "sending_church" ? "Intelligence" : "Network Intelligence", ...hidden };
}

export async function IntelligencePage({ searchParams }: Search) {
	const { shownLevel, run } = intelligenceQuery(await searchParams);
	return organizationOnly("/network/intelligence", async (viewer) =>
		shown(await intelligenceFor(viewer, shownLevel, run), (view) => (
			<IntelligenceScreen key={`${view.level}:${view.run?.runId ?? ""}`} view={view} kind={viewer.organizationKind} />
		)),
	);
}
