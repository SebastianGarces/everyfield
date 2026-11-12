import { getViewer } from "@/server/request-context";
import { recordId } from "@everyfield/contracts/common";
import { Button, Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotAvailable } from "../../access/AccessStates";
import { AFTER_SIGN_IN } from "../../identity/SignInScreen";
import { ArchivedLibrary } from "./ArchivedLibrary.tsx";
import { ChurchDocumentScreen } from "./ChurchDocumentScreen.tsx";
import { ChurchLibrary } from "./ChurchLibrary.tsx";
import { canManageChurch, loadArchived, loadChurchDocument, loadLibrary } from "./server.ts";

// The Church Documents routes. The files under apps/web/src/app/ only re-export these.

export const churchLibraryMetadata: Metadata = { title: "Church documents", robots: { index: false, follow: false } };
export const churchArchivedMetadata: Metadata = {
	title: "Archived documents",
	robots: { index: false, follow: false },
};
export const churchDocumentMetadata: Metadata = { title: "Church document", robots: { index: false, follow: false } };

async function activeViewer(returnTo: string) {
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
	return viewer.status === "active" ? viewer : null;
}

export async function ChurchLibraryPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const authority = (await activeViewer("/documents/church"))?.authority;
	if (!authority) return <Unavailable />;
	const loaded = await loadLibrary(authority);
	if (loaded.status === "failed") return <Failed />;
	if (loaded.status === "refused") return <Unavailable />;
	return (
		<ChurchLibrary
			documents={loaded.value.documents}
			templates={loaded.value.templates}
			churchTemplates={loaded.value.churchTemplates}
			canManage={canManageChurch(authority)}
			notice={noticeOf(await searchParams)}
		/>
	);
}

/** The one-line notice the library shows after a delete, an archive or a restore returned to it. */
function noticeOf(params: Record<string, string | string[] | undefined>) {
	if (params.restored === "1") return "restored" as const;
	if (params.archived === "1") return "archived" as const;
	if (params.deleted === "1") return "deleted" as const;
	return null;
}

/**
 * The church plant's archived Church Documents (T-284). Only an Owner or Admin opens it; a Member gets the same "not
 * available" state as any page they cannot use.
 */
export async function ChurchArchivedPage() {
	const authority = (await activeViewer("/documents/church/archived"))?.authority;
	if (!authority) return <Unavailable />;
	if (!canManageChurch(authority)) return <NotAvailablePage />;
	const loaded = await loadArchived(authority);
	if (loaded.status === "failed") return <Failed />;
	if (loaded.status === "refused") return <NotAvailablePage />;
	return <ArchivedLibrary documents={loaded.value} />;
}

function NotAvailablePage() {
	return (
		<div className="py-12">
			<Card className="mx-auto max-w-[560px]">
				<NotAvailable scope="page" homeHref={AFTER_SIGN_IN} />
			</Card>
		</div>
	);
}

export async function ChurchDocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
	const raw = (await params).documentId;
	const viewer = await activeViewer(`/documents/church/${encodeURIComponent(raw)}`);
	const authority = viewer?.authority;
	if (!viewer || !authority) return <Unavailable />;
	const id = recordId.safeParse(raw);
	if (!id.success) return <Missing />;
	const loaded = await loadChurchDocument(authority, id.data);
	if (loaded.status === "failed") return <Failed />;
	if (loaded.status === "refused") return <Missing />;
	if (loaded.status === "deleted") return <Deleted />;
	// The stored document goes to the browser only for an Owner or Admin, who can edit it. A Member gets the preview.
	const canManage = canManageChurch(authority);
	const { brands, template, mergeValues } = loaded.value;
	return (
		<ChurchDocumentScreen
			doc={loaded.value.view}
			editable={canManage && brands ? { document: loaded.value.document, brands, template, mergeValues } : null}
			canManage={canManage}
			exports={loaded.value.exports}
			revisions={loaded.value.revisions}
			revisionsTruncated={loaded.value.revisionsTruncated}
			viewerName={viewer.displayName || null}
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

/** A seat of the church plant opened a deleted document or one of its saved exports: nothing of it shows. */
function Deleted() {
	return (
		<>
			<PageHeader breadcrumb={[{ label: "Church documents", href: "/documents/church" }]} title="Document deleted" />
			<Card>
				<StatePanel
					tone="neutral"
					title="This document was deleted"
					headingLevel="h2"
					actions={
						<Button asChild variant="primary">
							<Link href="/documents/church">Back to Church documents</Link>
						</Button>
					}
				>
					Its saved exports can no longer be opened or downloaded.
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
