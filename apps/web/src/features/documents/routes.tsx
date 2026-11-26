import { getViewer } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { discoveryTemplates, TEXT_TEMPLATE_IDS } from "@everyfield/domain/documents";
import { PageState, Skeleton } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { DiscoveryDocuments } from "./DiscoveryDocuments.tsx";
import { DocumentsScreen } from "./DocumentsScreen.tsx";
import { parseQuery } from "./model.ts";
import { canEditDocuments, canStoreDocuments, loadDocuments, writtenScope } from "./server.ts";
import { params } from "../../components/search-params.ts";

type Search = Promise<Record<string, string | string[] | undefined>>;
export const documentsMetadata: Metadata = { title: "Documents", robots: { index: false, follow: false } };

export async function DocumentsPage({ searchParams }: { searchParams: Search }) {
	const query = parseQuery(params(await searchParams));
	const authority = await requireActor("/documents");
	if (!authority) return <Unavailable />;
	if ((await getViewer()).discovery) return <DiscoveryDocuments templates={discoveryTemplates()} />;
	const loaded = await loadDocuments(authority, query);
	if (loaded.status === "lost") return <Failed />;
	if (loaded.status === "refused") return <Unavailable />;
	return (
		<DocumentsScreen
			templates={loaded.templates}
			version={loaded.version}
			context={loaded.context}
			canPreview={loaded.canPreview}
			canEdit={canEditDocuments(authority)}
			canStore={canStoreDocuments()}
			textTemplates={TEXT_TEMPLATE_IDS}
			written={writtenScope(authority)}
			mine={loaded.mine}
		/>
	);
}

function Unavailable() {
	return (
		<PageState page="Documents" tone="lock" title="Documents are not available for this account">
			Sign in with an active account to read the template library.
		</PageState>
	);
}

function Failed() {
	return (
		<PageState page="Documents" tone="error" title="We could not load documents">
			This is a loading problem. Nothing was changed. Try again in a moment.
		</PageState>
	);
}

export function DocumentsLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-5">
			<span className="sr-only" role="status">
				Loading documents
			</span>
			<Skeleton className="h-14 w-64" />
			<Skeleton className="h-10 w-full max-w-xl rounded-md" />
			<div className="grid gap-4 sm:grid-cols-2">
				<Skeleton className="h-40" />
				<Skeleton className="h-40" />
				<Skeleton className="h-40" />
				<Skeleton className="h-40" />
			</div>
		</div>
	);
}
