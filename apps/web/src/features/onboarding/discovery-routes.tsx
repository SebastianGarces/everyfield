import { getViewer } from "@/server/request-context";
import { signIn } from "@/server/sign-in";
import { DISCOVERY_HOME, LANDING_ROUTE } from "@everyfield/contracts/identity";
import { articlePath } from "@everyfield/contracts/wiki";
import { PageState } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { namesFor, ownResidencyLinks, readDiscoverySharing, viewerOf } from "../organizations/mount";
import { DiscoveryHome } from "./DiscoveryHome";
import { FOUNDATION_ARTICLES } from "./foundations";
import { onboardingEntry } from "./mount";
import { parseEntry } from "./port";

export const discoveryHomeMetadata: Metadata = { title: "Discovery", robots: { index: false, follow: false } };

export async function DiscoveryHomePage() {
	const viewer = await getViewer();
	if (viewer.status === "unauthenticated") signIn(DISCOVERY_HOME);
	if (!viewer.discovery) redirect(LANDING_ROUTE);
	const load = parseEntry(await onboardingEntry(viewer));
	if (load.kind === "signed_out") signIn(DISCOVERY_HOME);
	if (load.entry.kind !== "discovery")
		return (
			<PageState page="Discovery" tone="error" title="Discovery didn't load">
				This is a loading problem. Nothing was changed. Reload the page in a moment.
			</PageState>
		);
	const profile = load.entry.profile;
	const who = await viewerOf();
	const [names, residencies, sharing] = await Promise.all([
		who.kind === "viewer"
			? namesFor(
					who.mount.db,
					who.viewer,
					profile.relationships.map((r) => r.organization.id),
				)
			: ({} as Record<string, string>),
		ownResidencyLinks(),
		who.kind === "viewer"
			? readDiscoverySharing(who.mount.db, who.authority)
			: ({} as Record<string, { shareFoundations: boolean }>),
	]);
	const live = residencies.find((l) => l.sharing.status === "active");
	const read = new Set<string>(profile.reading.articles.map((a) => a.articleId));
	return (
		<DiscoveryHome
			data={{
				firstName: viewer.displayName?.trim().split(/\s+/)[0] ?? null,
				foundations: FOUNDATION_ARTICLES.map((a) => ({
					id: a.id,
					title: a.title,
					href: articlePath(a.slug),
					read: read.has(a.id),
				})),
				links: profile.relationships.map((r) => ({
					id: r.relationshipId,
					name: names[r.organization.id] ?? "Your sending church",
					kind: r.organization.organizationKind === "sending_network" ? "Network" : "Sending church",
					sharesFoundations: sharing[r.relationshipId]?.shareFoundations === true,
				})),
				residency: live ? { organizationName: live.organizationName } : null,
			}}
		/>
	);
}
