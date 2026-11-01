import { getViewer } from "@/server/request-context";
import { recordId } from "@everyfield/contracts/common";
import { Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChurchDocumentScreen } from "./ChurchDocumentScreen.tsx";
import { ChurchLibrary } from "./ChurchLibrary.tsx";
import { canManageChurch, loadChurchDocument, loadLibrary } from "./server.ts";

// The Church Documents routes. The files under apps/web/src/app/ only re-export these.

export const churchLibraryMetadata: Metadata = { title: "Church documents", robots: { index: false, follow: false } };
export const churchDocumentMetadata: Metadata = { title: "Church document", robots: { index: false, follow: false } };

async function activeAuthority(returnTo: string) {
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
	return viewer.status === "active" ? viewer.authority : null;
}

export async function ChurchLibraryPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const authority = await activeAuthority("/documents/church");
	if (!authority) return <Unavailable />;
	const loaded = await loadLibrary(authority);
	if (loaded.status === "failed") return <Failed />;
	if (loaded.status === "refused") return <Unavailable />;
	return (
		<ChurchLibrary
			documents={loaded.value.documents}
			templates={loaded.value.templates}
			canManage={canManageChurch(authority)}
			deleted={(await searchParams).deleted === "1"}
		/>
	);
}

export async function ChurchDocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
	const raw = (await params).documentId;
	const authority = await activeAuthority(`/documents/church/${encodeURIComponent(raw)}`);
	if (!authority) return <Unavailable />;
	const id = recordId.safeParse(raw);
	if (!id.success) return <Missing />;
	const loaded = await loadChurchDocument(authority, id.data);
	if (loaded.status === "failed") return <Failed />;
	if (loaded.status === "refused") return <Missing />;
	// The stored document goes to the browser only for an Owner or Admin, who can edit it. A Member gets the preview.
	const canManage = canManageChurch(authority);
	return (
		<ChurchDocumentScreen
			doc={loaded.value.view}
			editable={canManage ? loaded.value.document : null}
			canManage={canManage}
		/>
	);
}

function Unavailable() {
	return (
		<>
			<PageHeader size="xl" title="Church documents" />
			<Card>
				<StatePanel tone="lock" title="Church documents need a church plant seat" headingLevel="h2">
					Sign in with a seat on a church plant to read its documents.
				</StatePanel>
			</Card>
		</>
	);
}

function Missing() {
	return (
		<>
			<PageHeader breadcrumb={[{ label: "Church documents", href: "/documents/church" }]} title="Document not found" />
			<Card>
				<StatePanel tone="neutral" title="This document is not available" headingLevel="h2">
					It may have been deleted, or it belongs to another church plant.
				</StatePanel>
			</Card>
		</>
	);
}

function Failed() {
	return (
		<>
			<PageHeader size="xl" title="Church documents" />
			<Card>
				<StatePanel tone="error" title="We could not load church documents" headingLevel="h2">
					This is a loading problem. Nothing was changed. Try again in a moment.
				</StatePanel>
			</Card>
		</>
	);
}

/** The first paint while a church document loads: the page's shape, not a spinner. */
export function ChurchLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading
			</span>
			<Skeleton className="h-14 w-72 rounded-card" />
			<Skeleton className="h-6 w-96 max-w-full rounded-md" />
			<Skeleton className="mx-auto aspect-[612/792] w-full max-w-[880px] rounded-none" />
		</div>
	);
}
