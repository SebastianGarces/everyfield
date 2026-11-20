import { signIn } from "@/server/sign-in";
import { Card, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { parseQuery, querySearch } from "./model.ts";
import { NotificationsScreen } from "./NotificationsScreen.tsx";
import { OptOutScreen, type OptOutView } from "./OptOutScreen.tsx";
import { call, loadFeedPage, notificationActor, optOutReady } from "./server.ts";
import { params } from "../../components/search-params.ts";
import { viewerZone, ZONE_COOKIE } from "../../components/viewer-zone.ts";

type Search = Promise<Record<string, string | string[] | undefined>>;
export const notificationsMetadata: Metadata = { title: "Notifications", robots: { index: false, follow: false } };

export async function NotificationsPage({ searchParams }: { searchParams: Search }) {
	const query = parseQuery(params(await searchParams));
	const actor = await notificationActor();
	if (!actor) signIn(`/notifications${querySearch(query)}`);
	const loaded = await loadFeedPage(actor, query);
	if (loaded.status !== "ok")
		return (
			<>
				<PageHeader size="xl" title="Notifications" />
				<Card>
					<StatePanel tone="error" title="We could not load your notifications" headingLevel="h2">
						This is a loading problem, not an empty list. Nothing was marked read. Reload the page in a moment.
					</StatePanel>
				</Card>
			</>
		);
	const zone = viewerZone((await cookies()).get(ZONE_COOKIE)?.value);
	return <NotificationsScreen initial={loaded.value} served={zone ? { zone, now: loaded.value.at } : null} />;
}

export const optOutMetadata: Metadata = {
	title: "Email preferences",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export async function OptOutPage({ params: route }: { params: Promise<{ token: string }> }) {
	const token = (await route).token;
	return <OptOutScreen token={token} view={await describe(token)} />;
}

async function describe(token: string): Promise<OptOutView> {
	if (!optOutReady()) return { state: "unavailable" };
	const r = await call(({ db, producer }) => producer.describeEmailOptOut(db, { token }));
	if (r.status === "lost") return { state: "unavailable" };
	if (r.status === "refused") return { state: "invalid" };
	if (r.value.purpose !== "disable") return { state: "invalid" };
	if (r.value.expired) return { state: "expired", category: r.value.category };
	return { state: "open", category: r.value.category, emailEnabled: r.value.emailEnabled };
}
