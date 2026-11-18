import foundations from "../../../../../docs/reference/discovery-foundations.json" with { type: "json" };

export const FOUNDATION_ARTICLES = [...foundations.articles]
	.sort((a, b) => a.sort_order - b.sort_order)
	.map((a) => ({ id: a.id, title: a.title }));
