import type { Database } from "@everyfield/db/client";
import type { WikiQueryEmbedder } from "@everyfield/reference/wiki-embedding";
import "server-only";
import type { RequestActor } from "../access/session.ts";
import { helveticaPdf, type PdfRenderer } from "./pdf.ts";
import {
	articleNeighbors,
	bookmarksList,
	contextGuide,
	exportPdf,
	getArticle,
	listArticles,
	navigation,
	printArticle,
	publicPreviewMetadata,
	readingRecent,
	readingResume,
	readingStats,
	recommendForPhase,
	referenceExcerpt,
	renderGlobalPreview,
	search,
	tableOfContents,
} from "./reads.ts";
import {
	addOrganizationArticle,
	editOrganizationArticle,
	emitUpstreamReview,
	getMine,
	getOrganizationDraft,
	hideOrganizationArticle,
	publishOrganizationArticle,
	setMine,
	setMineIn,
} from "./editorial.ts";
import { recordView, setBookmark, setBookmarkIn, setSourceOrder, updateProgress } from "./writes.ts";
import { getReadingRevision, listCompletedArticles, listOrganizationNames, readEditorState } from "./page.ts";

export const wikiEffects = { setBookmark: setBookmarkIn, setMine: setMineIn };

export { sectionExcerpt } from "./excerpt.ts";

export type { StoredEditor } from "./page.ts";
export type WikiConfig = { renderPdf?: PdfRenderer; queryEmbedder?: WikiQueryEmbedder | null };

export function createWikiProducer(config: WikiConfig = {}) {
	const render = config.renderPdf ?? helveticaPdf;
	return {
		listArticles,
		getArticle,
		search:
			config.queryEmbedder === undefined
				? search
				: (db: Database, authority: RequestActor, raw: unknown) => search(db, authority, raw, config.queryEmbedder),
		navigation,
		articleNeighbors,
		tableOfContents,
		contextGuide,
		referenceExcerpt,
		readingRecent,
		readingResume,
		readingStats,
		recommendForPhase,
		publicPreviewMetadata,
		renderGlobalPreview,
		bookmarksList,
		exportPdf: (db: Database, authority: RequestActor, raw: unknown) => exportPdf(db, authority, raw, render),
		printArticle,
		setBookmark,
		recordView,
		updateProgress,
		setSourceOrder,
		getMine,
		setMine,
		addOrganizationArticle,
		editOrganizationArticle,
		hideOrganizationArticle,
		publishOrganizationArticle,
		getOrganizationDraft,
		emitUpstreamReview,
		readEditorState,
		getReadingRevision,
		listCompletedArticles,
		listOrganizationNames,
	};
}
