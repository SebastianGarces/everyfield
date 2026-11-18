import type { Database } from "@everyfield/db/client";
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

export const wikiEffects = { setBookmark: setBookmarkIn, setMine: setMineIn };

export { sectionExcerpt } from "./excerpt.ts";

export type WikiConfig = { renderPdf?: PdfRenderer };

export function createWikiProducer(config: WikiConfig = {}) {
	const render = config.renderPdf ?? helveticaPdf;
	return {
		listArticles,
		getArticle,
		search,
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
	};
}
