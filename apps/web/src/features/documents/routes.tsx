import { getViewer } from "@/server/request-context";
import { Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DocumentsScreen } from "./DocumentsScreen.tsx";
import { parseQuery } from "./model.ts";
import { canEditDocuments, canStoreDocuments, loadDocuments, writtenScope } from "./server.ts";

// The documents routes. The files under apps/web/src/app/ only re-export these.

type Search = Promise<Record<string, string | string[] | undefined>>;
const params = (raw: Record<string, string | string[] | undefined>) => {
	const out = new URLSearchParams();
	for (const [key, value] of Object.entries(raw)) for (const one of [value ?? []].flat()) out.append(key, one);
	return out;
};

export const documentsMetadata: Metadata = { title: "Documents", robots: { index: false, follow: false } };

/** Signed out goes to sign-in. An active account sees the library. A church seat is required only to preview. */
export async function DocumentsPage({ searchParams }: { searchParams: Search }) {
	const query = parseQuery(params(await searchParams));
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated") redirect("/signin?returnTo=%2Fdocuments");
	if (viewer.status !== "active" || !viewer.authority) return <Unavailable />;
	const loaded = await loadDocuments(viewer.authority, query);
	if (loaded.status === "failed") return <Failed />;
	if (loaded.status === "refused") return <Unavailable />;
	return (
		<DocumentsScreen
			templates={loaded.templates}
			query={query}
			context={loaded.context}
			canPreview={loaded.canPreview}
			canEdit={canEditDocuments(viewer.authority)}
			canStore={canStoreDocuments()}
			written={writtenScope(viewer.authority)}
		/>
	);
}

function Unavailable() {
	return (
		<>
			<PageHeader size="xl" title="Documents" />
			<Card>
				<StatePanel tone="lock" title="Documents are not available for this account" headingLevel="h2">
					Sign in with an active account to read the template library.
				</StatePanel>
			</Card>
		</>
	);
}

function Failed() {
	return (
		<>
			<PageHeader size="xl" title="Documents" />
			<Card>
				<StatePanel tone="error" title="We could not load documents" headingLevel="h2">
					This is a loading problem. Nothing was changed. Try again in a moment.
				</StatePanel>
			</Card>
		</>
	);
}

/** The first paint while documents load: the page's shape, not a spinner. */
export function DocumentsLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading documents
			</span>
			<Skeleton className="h-14 w-64 rounded-card" />
			<Skeleton className="h-10 w-full max-w-xl rounded-md" />
			<div className="grid gap-4 sm:grid-cols-2">
				<Skeleton className="h-40 rounded-card" />
				<Skeleton className="h-40 rounded-card" />
				<Skeleton className="h-40 rounded-card" />
				<Skeleton className="h-40 rounded-card" />
			</div>
		</div>
	);
}
