import { getViewer } from "@/server/request-context";
import { Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { canEditDocuments, canStoreDocuments, writtenScope } from "../server.ts";
import { loadWritten } from "./server.ts";
import { WrittenScreen } from "./WrittenScreen.tsx";

// The native document route. The file under apps/web/src/app/ only re-exports it. "new" opens a blank document that
// the first save creates.

export const writtenMetadata: Metadata = { title: "Document", robots: { index: false, follow: false } };

const BACK = [{ label: "Documents", href: "/documents" }];

export async function WrittenDocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
	const raw = (await params).documentId;
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated")
		redirect(`/signin?returnTo=${encodeURIComponent(`/documents/written/${raw}`)}`);
	const authority = viewer.status === "active" ? viewer.authority : null;
	const scope = authority ? writtenScope(authority) : null;
	if (!authority || !scope) return <Missing />;
	const canEdit = canEditDocuments(authority);
	if (raw === "new") {
		if (!canEdit) return <Missing />;
		return <WrittenScreen doc={null} scope={scope} canEdit canStore={canStoreDocuments()} />;
	}
	const loaded = await loadWritten(authority, raw);
	if (loaded.status === "failed") return <Failed />;
	if (loaded.status === "missing") return <Missing />;
	return <WrittenScreen doc={loaded.value} scope={scope} canEdit={canEdit} canStore={canStoreDocuments()} />;
}

function Missing() {
	return (
		<>
			<PageHeader breadcrumb={BACK} title="Document not found" />
			<Card>
				<StatePanel tone="neutral" title="This document is not available" headingLevel="h2">
					The link may be wrong, or the document belongs to someone else.
				</StatePanel>
			</Card>
		</>
	);
}

function Failed() {
	return (
		<>
			<PageHeader breadcrumb={BACK} title="Document" />
			<Card>
				<StatePanel tone="error" title="We could not load this document" headingLevel="h2">
					This is a loading problem. Nothing was changed. Try again in a moment.
				</StatePanel>
			</Card>
		</>
	);
}

/** The first paint while a document loads: the page's shape, not a spinner. */
export function WrittenLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading
			</span>
			<Skeleton className="h-14 w-72 rounded-card" />
			<Skeleton className="h-12 w-full rounded-card" />
			<Skeleton className="mx-auto h-[640px] w-full max-w-[816px] rounded-none" />
		</div>
	);
}
