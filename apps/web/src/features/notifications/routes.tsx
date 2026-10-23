import type { RequestActor } from "@everyfield/domain/access";
import { Card, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { parseQuery, querySearch } from "./model.ts";
import { NotificationsScreen } from "./NotificationsScreen.tsx";
import { OptOutScreen, type OptOutView } from "./OptOutScreen.tsx";
import { call, loadFeedPage, notificationActor, notificationsMount } from "./server.ts";

// The notification routes. The files under apps/web/src/app/ only re-export these, so the screens, their data loading
// and their states stay in this feature folder.

type Search = Promise<Record<string, string | string[] | undefined>>;
const params = (raw: Record<string, string | string[] | undefined>) => {
	const out = new URLSearchParams();
	for (const [k, v] of Object.entries(raw)) for (const one of [v ?? []].flat()) out.append(k, one);
	return out;
};

export const notificationsMetadata: Metadata = { title: "Notifications", robots: { index: false, follow: false } };

/** The feed page: the first page and the unread count of its filter, read on the server (REQ-NTF-003). */
export async function NotificationsPage({ searchParams }: { searchParams: Search }) {
	const query = parseQuery(params(await searchParams));
	const actor = await notificationActor();
	if (!actor) redirect(`/signin?returnTo=${encodeURIComponent("/notifications" + querySearch(query))}`);
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
	return <NotificationsScreen initialQuery={query} initial={loaded.value} />;
}

export const optOutMetadata: Metadata = {
	title: "Email preferences",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

/**
 * The email preferences link (REQ-NTF-012). Opening it only describes the token, so a mail scanner that follows the
 * link changes nothing; a malformed, tampered or wrong-purpose token reads as invalid.
 */
export async function OptOutPage({ params: route }: { params: Promise<{ token: string }> }) {
	const token = (await route).token;
	return <OptOutScreen token={token} view={await describe(token)} />;
}

async function describe(token: string): Promise<OptOutView> {
	if (!notificationsMount()?.optOut) return { state: "unavailable" };
	// The token is the authority; describe never reads a session. The producer's signature still names one.
	const r = await call(({ db, producer }) => producer.describeEmailOptOut(db, NO_SESSION, { token }));
	if (r.status === "lost") return { state: "unavailable" };
	if (r.status === "refused") return { state: "invalid" };
	if (r.value.purpose !== "disable") return { state: "invalid" };
	if (r.value.expired) return { state: "expired", category: r.value.category };
	return { state: "open", category: r.value.category, emailEnabled: r.value.emailEnabled };
}
const NO_SESSION = undefined as unknown as RequestActor;
