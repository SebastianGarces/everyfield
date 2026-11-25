import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { counted } from "@everyfield/contracts/common";
import { APP_PAGES } from "@everyfield/contracts/wiki";
import { captured } from "@everyfield/evry";
import { randomUUID } from "node:crypto";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { id: string; label: string; fields: Record<string, unknown> };
type Output = {
	operation?: string;
	error?: unknown;
	rows?: Row[];
	facts?: Record<string, unknown>;
	next?: number | null;
};
type Reference = { kind: string; id: string; label: string };

const MENU = /\bwhat(?:['’]s| is) in (?:the|our) wiki\b|\bwiki(?:['’]s)? (?:menu|contents)\b/i;
const LIST =
	/\b(?:list|show me|which|what)\b.*?\bwiki(?:['’]s)? articles\b(?:.*?\b(?:in|under|for) (?:the )?(.+?)(?: (?:section|phase))?)?(?:,? page (\d+))?[?.!\s]*$/i;
const QUOTE = /\bquote the ["“](.+?)["”] section (?:of|in) (?:the )?(.+?)(?: article)?[?.!\s]*$/i;
const HEADINGS =
	/\b(?:sections|headings) (?:of|in|does|are in) (?:the )?(.+?)(?: article)?(?: (?:have|has))?[?.!\s]*$/i;
const AROUND = /\b(?:what|which article) comes (next|before) ?(?:after )?(?:the )?(.+?)(?: article)?[?.!\s]*$/i;
const RELATED = /\brelated to (?:the )?(.+?)(?: article)?[?.!\s]*$/i;
const GUIDE = /\bguide (?:to|for|on) (?:the )?(.+?)(?: page)?[?.!\s]*$/i;
const GUIDE_ALONE = /\b(?:show|give) me the guide[?.!\s]*$/i;
const BOOKMARKS = /\bwhat (?:have I|did I) bookmark(?:ed)?\b|\bmy bookmarks\b/i;
const RECENT = /\bwhat (?:have I|did I) read recently\b/i;
const STATS = /\bhow much (?:of the wiki )?have I read\b/i;
const FEEDBACK = /\bwhat feedback (?:have I|did I) (?:left|leave|give)(?: on (?:the )?(.+?)(?: article)?)?[?.!\s]*$/i;
const ASKS = [MENU, LIST, QUOTE, HEADINGS, AROUND, RELATED, GUIDE, GUIDE_ALONE, BOOKMARKS, RECENT, STATS, FEEDBACK];
const THIS = /^(?:this|it|this article|this page|here|the page)$/i;
const VERIFIED = "Verified references on the user's page: ";

const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const read = (operation: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName: "wiki_read", input: JSON.stringify({ operation, input }) },
];
const linked = (row: Row) => `[${row.label}](${String(row.fields.href)})`;
const bare = (title: string) => title.toLowerCase().replace(/^the /, "");
const bullets = (rows: Row[], line: (row: Row) => string) => rows.map((row) => `- ${line(row)}`).join("\n");

function outputs(prompt: Prompt): Output[] {
	const start = prompt.findLastIndex((m) => m.role === "user");
	return prompt
		.slice(start + 1)
		.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Output] : [],
					)
				: [],
		);
}
function pageReference(prompt: Prompt, kind: string): Reference | null {
	const system = prompt.find((m) => m.role === "system")?.content;
	const line = typeof system === "string" ? system.split(VERIFIED)[1]?.split("\n")[0] : undefined;
	return line ? ((JSON.parse(line) as Reference[]).find((r) => r.kind === kind) ?? null) : null;
}

function onArticle(
	options: LanguageModelV4CallOptions,
	title: string,
	done: Output[],
	answer: (articleId: string, results: Output[]) => LanguageModelV4Content[],
): LanguageModelV4Content[] {
	if (THIS.test(title)) {
		const open = pageReference(options.prompt, "article")?.id;
		return open ? answer(open, done) : say("Which article? Open it on the Wiki page or tell me its title.");
	}
	const [found, ...rest] = done;
	if (!found) return read("wiki.search", { query: title });
	const id = found.rows?.find((r) => bare(r.label) === bare(title))?.fields.articleId;
	return typeof id === "string" ? answer(id, rest) : say(`The Wiki has no article called ${title}.`);
}

export function wikiBrowseStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	if (!ASKS.some((ask) => ask.test(text))) return null;
	const tool = options.tools?.find((t) => t.name === "wiki_read");
	if (!tool || !JSON.stringify(tool).includes('"wiki.navigation"')) return null;
	const done = outputs(options.prompt);
	const last = done.at(-1);
	if (last?.error) return say(`I could not read the Wiki (${String(last.error)}).`);
	const rows = last?.rows ?? [];
	const facts = last?.facts ?? {};

	const guide = GUIDE.exec(text);
	if (guide || GUIDE_ALONE.test(text)) {
		const named = guide ? captured(guide, 1) : "this";
		const route = THIS.test(named)
			? pageReference(options.prompt, "page")?.id
			: APP_PAGES.find((page) => page.name.toLowerCase() === named.toLowerCase())?.route;
		if (!route)
			return say(THIS.test(named) ? "Which page do you want the guide for?" : `Everyfield has no ${named} page.`);
		if (!last) return read("wiki.contextGuide", { route });
		const [row] = rows;
		if (!row) return say(`The ${String(facts.page)} page has no guide.`);
		const section = row.fields.section ? `, section ${String(row.fields.section)}` : "";
		return say(`The guide for the ${String(facts.page)} page is ${linked(row)}${section}, quoted above.`);
	}
	if (MENU.test(text)) {
		if (!last) return read("wiki.navigation", {});
		if (!rows.length) return say("The Wiki has no articles yet.");
		return say(
			`The Wiki holds:\n\n${bullets(rows, (r) => `${r.label}: ${counted(Number(r.fields.articles), "article")}`)}`,
		);
	}
	if (STATS.test(text)) {
		if (!last) return read("wiki.reading.stats", {});
		return say(
			`You've read ${String(facts.articlesRead)} of ${counted(Number(facts.articlesTotal), "article")}.\n\n${bullets(rows, (r) => `${r.label}: ${String(r.fields.read)} of ${String(r.fields.total)}`)}\n\nDiscovery reading: ${String(facts.discoveryRead)} of ${String(facts.discoveryTotal)}.`,
		);
	}
	if (BOOKMARKS.test(text)) {
		if (!last) return read("wiki.bookmarks.list", {});
		return say(
			rows.length ? `You bookmarked:\n\n${bullets(rows, linked)}` : "You haven't bookmarked a Wiki article yet.",
		);
	}
	if (RECENT.test(text)) {
		if (!last) return read("wiki.reading.recent", {});
		return say(
			rows.length
				? `You read these recently:\n\n${bullets(rows, (r) => `${linked(r)} (${String(r.fields.read)} read)`)}`
				: "You haven't opened a Wiki article yet.",
		);
	}
	const feedback = FEEDBACK.exec(text);
	if (feedback && !feedback[1]) {
		if (!last) return read("wiki.feedback.getMine", {});
		return say(
			rows.length
				? `Your feedback:\n\n${bullets(rows, (r) => `${linked(r)}: ${String(r.fields.vote)}`)}`
				: "You haven't left feedback on a Wiki article yet.",
		);
	}
	if (feedback)
		return onArticle(options, captured(feedback, 1), done, (articleId, results) => {
			if (!results.length) return read("wiki.feedback.getMine", { articleId });
			const [row] = rows;
			return say(row ? `Your feedback on ${linked(row)}: ${String(row.fields.vote)}.` : "I can't find that article.");
		});
	const quote = QUOTE.exec(text);
	if (quote)
		return onArticle(options, captured(quote, 2), done, (articleId, results) => {
			const heading = captured(quote, 1);
			const [toc, excerpt] = results;
			if (!toc) return read("wiki.tableOfContents", { articleId });
			if (!toc.rows?.some((r) => r.fields.heading === heading))
				return say(`That article has no section called ${heading}.`);
			if (!excerpt) return read("wiki.referenceExcerpt", { articleId, heading });
			const [row] = rows;
			return row
				? say(`From ${linked(row)}, ${heading}:\n\n${String(row.fields.excerpt)}`)
				: say(`That article has no section called ${heading}.`);
		});
	const around = AROUND.exec(text);
	const related = RELATED.exec(text);
	const near = around?.[2] ?? related?.[1];
	if (near)
		return onArticle(options, near, done, (articleId, results) => {
			if (!results.length) return read("wiki.articleNeighbors", { articleId });
			const relation = around ? (captured(around, 1).toLowerCase() === "next" ? "next" : "previous") : "related";
			const found = rows.filter((r) => r.fields.relation === relation);
			if (relation === "related")
				return say(found.length ? `Related:\n\n${bullets(found, linked)}` : "That article has no related articles.");
			const [row] = found;
			if (!row) return say(`Nothing comes ${relation === "next" ? "after" : "before"} that article.`);
			const section = row.fields.section ? `, in ${String(row.fields.section)}` : "";
			return say(`${relation === "next" ? "Next" : "Before it"} is ${linked(row)}${section}.`);
		});
	const headings = HEADINGS.exec(text);
	if (headings)
		return onArticle(options, captured(headings, 1), done, (articleId, results) => {
			if (!results.length) return read("wiki.tableOfContents", { articleId });
			const [row] = rows;
			return row
				? say(`${linked(row)} has these sections:\n\n${bullets(rows, (r) => String(r.fields.heading))}`)
				: say("That article has no sections.");
		});
	const list = LIST.exec(text);
	if (!list) return null;
	const section = list[1];
	if (!last)
		return read("wiki.articles.list", {
			...(section ? { section } : {}),
			...(list[2] ? { page: Number(list[2]) } : {}),
		});
	if (!rows.length)
		return say(
			facts.sectionFound === false
				? `The Wiki has no section called ${String(facts.section)}. Its sections are: ${String(facts.sections)}.`
				: `The Wiki has no articles in ${String(facts.section)}.`,
		);
	const more = last.next ? `\n\nThere are more: ask for page ${last.next}.` : "";
	return say(`${section ? String(facts.section) : "The Wiki"} holds:\n\n${bullets(rows, linked)}${more}`);
}
