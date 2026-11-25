import type { Transaction } from "@everyfield/db/client";
import { articlePath, type WikiArticle, type WikiReply } from "@everyfield/contracts/wiki";
import { createWikiProducer } from "@everyfield/domain/wiki";
import type { EvryActor } from "../../context/actor.ts";
import { EvryRefusal } from "../../context/errors.ts";
import type { SourceRow } from "../../catalog/types.ts";

export const wiki = createWikiProducer();
export const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;

type Link = Pick<WikiArticle, "articleId" | "revisionId" | "sourceKind" | "title" | "slug">;
export function articleRow(article: Link, fields: SourceRow["fields"] = {}): SourceRow {
	return {
		kind: "article",
		id: article.revisionId,
		label: article.title,
		fields: { articleId: article.articleId, href: articlePath(article.slug), source: article.sourceKind, ...fields },
	};
}
export function value<T>(reply: WikiReply<T>): T {
	if (reply.status === "ok") return reply.value;
	throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "source_unavailable");
}
export async function shown(tx: Transaction, actor: EvryActor, articleId: string) {
	const { article } = value(await wiki.getArticle(tx, actor.authority, { articleId }));
	return article && !article.hidden && article.body != null ? article : null;
}
export const read = (article: Pick<WikiArticle, "observedFraction">) =>
	`${Math.round(Number(article.observedFraction) * 100)}%`;
