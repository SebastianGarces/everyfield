import foundations from "../../../../../docs/reference/discovery-foundations.json" with { type: "json" };

/** The six Discovery foundations, in reading order. Titles only; bodies stay in the Wiki. */
export const FOUNDATION_ARTICLES = [...foundations.articles]
	.sort((a, b) => a.sort_order - b.sort_order)
	.map((a) => ({ id: a.id, title: a.title }));
