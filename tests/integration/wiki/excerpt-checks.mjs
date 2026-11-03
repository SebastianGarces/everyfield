// WP-034/api: the Guide and reference excerpt cut rules. No database: sectionExcerpt is the pure cut both reads return.
// tests/integration/wiki/excerpt.test.mts runs every check in CI; tests/ui/wiki/guide-excerpt.test.mjs runs each one
// under its AC: marker beside the rendered Guide.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sectionExcerpt } from "../../../packages/domain/src/wiki/excerpt.ts";
import { GUIDE_ROUTES } from "../../../packages/domain/src/wiki/guides.ts";

/** The app's global corpus: the living Wiki seed the reference bundle installs. */
export const SEED = JSON.parse(
	readFileSync(new URL("../../../docs/reference/wiki/seed.json", import.meta.url), "utf8"),
);

export function seedBody(slug) {
	const article = SEED.articles.find((row) => row.slug === slug);
	assert.ok(article, slug);
	return article.content;
}

/** The section under `heading` as the source holds it, or the whole text without one. */
export function sourceSection(body, heading) {
	const lines = body.split("\n");
	const start = heading ? lines.findIndex((line) => line.replace(/^#{1,6}\s+/, "").trim() === heading) : -1;
	if (start < 0) return body;
	const level = /^(#+)/.exec(lines[start])[1].length;
	const end = lines.findIndex((line, index) => index > start && /^(#+)\s/.exec(line)?.[1].length <= level);
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const LETTER = /[\p{L}\p{N}]/u;

/**
 * Criterion 3's rule for one excerpt of `section`: it ends at a block end, a sentence end, or a whole word with "…",
 * never inside a row, an item, a component or an inline span, and never on a break or a bare heading.
 */
export function assertCleanEnd(body, section, label) {
	const text = body.endsWith("…") ? body.slice(0, -1) : body;
	// A cut code block closes its fence again, so only the text before that line is the source's.
	const refenced = /\n(```|~~~)$/.test(text) && !section.startsWith(text);
	const core = refenced ? text.slice(0, text.lastIndexOf("\n")) : text;
	assert.ok(core.length > 0, `${label}: the excerpt has text`);
	assert.ok(section.startsWith(core), `${label}: the excerpt is the start of its section`);
	const next = section[core.length];
	if (refenced) assert.equal(next, "\n", `${label}: a cut code block keeps whole lines`);
	else if (body.endsWith("…")) {
		assert.ok(LETTER.test(core.at(-1) ?? "") || /[*_`)\]]/.test(core.at(-1) ?? ""), `${label}: … follows a word`);
		assert.ok(next != null && !LETTER.test(next), `${label}: the word before … is whole`);
	} else {
		const sentence = /[.!?][*_"'”’)]*$/.test(core) && (next == null || /\s/.test(next));
		assert.ok(next == null || next === "\n" || sentence, `${label}: ends at a block or sentence end`);
	}
	const prose = text.replace(/^(```|~~~).*\n[\s\S]*?^\1.*$/gm, "");
	const last = core.split("\n").at(-1) ?? "";
	if (/^\s*\|/.test(last)) assert.match(last, /\|\s*$/, `${label}: the last table row is whole`);
	assert.doesNotMatch(last, /^ {0,3}([-*_])(\s*\1){2,}\s*$/, `${label}: no closing thematic break`);
	assert.doesNotMatch(last, /^#{1,6}\s/, `${label}: no closing heading without text`);
	const opened = [...prose.matchAll(/<([A-Z][\w.]*)\b[^>]*?(\/?)>/g)].filter((match) => !match[2]);
	for (const [, name] of opened)
		assert.equal(
			prose.split(`<${name}`).length - 1 - (prose.match(new RegExp(`<${name}\\b[^>]*/>`, "g")) ?? []).length,
			prose.split(`</${name}>`).length - 1,
			`${label}: every <${name}> closes`,
		);
	const inline = prose.replace(/`[^`]*`/g, "");
	assert.equal((prose.match(/`/g) ?? []).length % 2, 0, `${label}: backticks pair`);
	assert.equal((inline.match(/\*\*/g) ?? []).length % 2, 0, `${label}: ** pairs`);
	const single = inline.replace(/\*\*/g, "").replace(/^\s*\*\s/gm, "");
	assert.equal((single.match(/\*/g) ?? []).length % 2, 0, `${label}: * pairs`);
	assert.equal((inline.match(/\[/g) ?? []).length, (inline.match(/\]/g) ?? []).length, `${label}: [ ] pair`);
	assert.equal(
		(inline.match(/\]\(/g) ?? []).length,
		(inline.match(/\]\([^)]*\)/g) ?? []).length,
		`${label}: ]( closes`,
	);
	if (body.length >= 500) {
		assert.match(last, /^\s*\|.*\|\s*$/, `${label}: a body of 500 or more characters ends with a table row`);
		assert.ok(body.length <= 1500, `${label}: within the table ceiling`);
	}
}

/** Every route's Guide body on the seeded corpus, with its source section. */
export function seededGuides() {
	return GUIDE_ROUTES.map((entry) => {
		const body = seedBody(entry.slug);
		return {
			...entry,
			excerpt: sectionExcerpt("safe_mdx", body, entry.heading),
			section: sourceSection(body, entry.heading),
		};
	});
}

const guideOf = (route) => {
	const guide = seededGuides().find((entry) => entry.route === route);
	assert.ok(guide, route);
	return guide;
};

export const PHASE_ROWS = [
	"| **Phase 0** | Discovery | Discerning calling, understanding frameworks, setting initial goals |",
	"| **Phase 1** | Core Group | Vision Meetings, building the Core Group, formalizing commitment |",
	"| **Phase 2** | Launch Team | Setting launch date, training, establishing leadership roles |",
	"| **Phase 3** | Training | Preparing teams for their responsibilities |",
	"| **Phase 4** | Pre-Launch | Final preparations, promotion |",
	"| **Phase 5** | Launch Sunday | The big day and execution |",
	"| **Phase 6** | Post-Launch | Establishing rhythms, guest assimilation, sustainability |",
];

const sentence = (n, word = "plan") => `${`The team will ${word} the work together. `.repeat(n)}`;
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

export const checks = {
	1() {
		const { excerpt } = guideOf("/intelligence");
		assert.equal(
			excerpt,
			[
				"## How to Navigate the Playbook",
				"",
				"The Launch Playbook is organized into phases that follow the natural progression of a church plant:",
				"",
				"| Phase | Focus | Key Activities |",
				"|-------|-------|----------------|",
				...PHASE_ROWS,
			].join("\n"),
		);
		assert.equal((excerpt.match(/\*\*/g) ?? []).length % 2, 0);
	},
	2() {
		const { excerpt, section } = guideOf("/meetings");
		assert.doesNotMatch(excerpt, /Present the vis…?$/);
		assertCleanEnd(excerpt, section, "/meetings");
		// The next paragraph has no sentence end inside the limit, so it keeps whole words and gets "…".
		assert.match(excerpt, /\n\nPresent the…$/);
	},
	3() {
		for (const { route, excerpt, section } of seededGuides()) assertCleanEnd(excerpt, section, route);
		// Every heading of every seeded article holds the same rule, not only the mapped ones.
		const failures = [];
		for (const article of SEED.articles)
			for (const line of article.content.split("\n")) {
				const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line)?.[1];
				if (!heading) continue;
				const label = `${article.slug} # ${heading}`;
				try {
					assertCleanEnd(
						sectionExcerpt("safe_mdx", article.content, heading),
						sourceSection(article.content, heading),
						label,
					);
				} catch (error) {
					failures.push(error.message);
				}
			}
		assert.deepEqual(failures, []);
	},
	4() {
		// A sentence end inside the limit: the cut keeps whole sentences only.
		const sentences = `## Plan\n${sentence(20)}`;
		const cut = sectionExcerpt("safe_mdx", sentences, "Plan");
		assert.equal(cut, `## Plan\n${sentence(12).trimEnd()}`);
		// No sentence end inside the limit: the last whole word, then "…".
		const plain = `## Plan\n${words(100)}`;
		const wordCut = sectionExcerpt("safe_mdx", plain, "Plan");
		assert.equal(wordCut, `## Plan\n${words(100).slice(0, 489).replace(/ \S*$/, "")}…`);
		assert.ok(wordCut.length < 500);
		// A cut inside a span moves back to before the span opens.
		for (const [open, close] of [
			["**", "**"],
			["*", "*"],
			["_", "_"],
			["`", "`"],
			["[", "](https://example.org/a)"],
		]) {
			const span = `${open}${words(30)}${close}`;
			const text = `## Plan\n${words(60)} ${span} tail`;
			assert.equal(sectionExcerpt("safe_mdx", text, "Plan"), `## Plan\n${words(60)}…`, open);
		}
		// A sentence end inside a bold span counts once the span closes.
		const bold = `## Plan\n**Lead with prayer.** ${words(100)}`;
		assert.equal(sectionExcerpt("safe_mdx", bold, "Plan"), "## Plan\n**Lead with prayer.**");
	},
	5() {
		const items = Array.from({ length: 30 }, (_, i) => `- Item ${i} keeps its whole line of text`);
		const cut = sectionExcerpt("safe_mdx", ["## List", "", ...items, "", "After"].join("\n"), "List");
		const kept = cut.split("\n").slice(2);
		assert.ok(kept.length > 0 && kept.length < items.length);
		assert.deepEqual(kept, items.slice(0, kept.length));
		assert.ok(cut.length < 500);
		assert.ok(`${cut}\n${items[kept.length]}`.length >= 500, "every item that fits stays");
		// Continuation lines stay with their item.
		const nested = ["## List", "", ...items.slice(0, 11).map((item) => `${item}\n  more of the same item`)].join("\n");
		const nestedCut = sectionExcerpt("safe_mdx", nested, "List");
		assert.match(nestedCut, /\n {2}more of the same item$/);
	},
	6() {
		const head = ["| Name | Notes |", "|------|-------|"];
		const rows = (n) => Array.from({ length: n }, (_, i) => `| Row ${i} | A note about row ${i} |`);
		// Inside the ceiling: the table stays whole even past the limit, and nothing comes after it.
		const whole = sectionExcerpt(
			"safe_mdx",
			["## Table", "", ...head, ...rows(30), "", "After the table."].join("\n"),
			"Table",
		);
		assert.equal(whole, ["## Table", "", ...head, ...rows(30)].join("\n"));
		assert.ok(whole.length >= 500 && whole.length <= 1500);
		// Past the ceiling: the header, the separator and the whole rows that fit.
		const long = sectionExcerpt("safe_mdx", ["## Table", "", ...head, ...rows(80)].join("\n"), "Table");
		const kept = long.split("\n").slice(2);
		assert.deepEqual(kept.slice(0, 2), head);
		assert.deepEqual(kept.slice(2), rows(80).slice(0, kept.length - 2));
		assert.ok(long.length <= 1500 && `${long}\n${rows(80)[kept.length - 2]}`.length > 1500);
		// A paragraph that crosses the limit ends the excerpt, so a table after it is left out.
		const late = sectionExcerpt(
			"safe_mdx",
			["## Table", "", sentence(14).trimEnd(), "", ...head, ...rows(3)].join("\n"),
			"Table",
		);
		assert.equal(late, ["## Table", "", sentence(12).trimEnd()].join("\n"));
		assert.ok(late.length < 500);
	},
	7() {
		const callout = ['<Callout type="important">', "  Keep the whole component.", "</Callout>"];
		const fits = sectionExcerpt(
			"safe_mdx",
			["## Box", "", sentence(5).trimEnd(), "", ...callout, "## Next", sentence(20)].join("\n"),
			"Box",
		);
		assert.equal(fits, ["## Box", "", sentence(5).trimEnd(), "", ...callout].join("\n"));
		const late = sectionExcerpt("safe_mdx", ["## Box", "", sentence(12).trimEnd(), "", ...callout].join("\n"), "Box");
		assert.equal(late, ["## Box", "", sentence(12).trimEnd()].join("\n"));
		// One line, self-closing or not, is one component too.
		assert.equal(
			sectionExcerpt("safe_mdx", ["## Box", "", "<Callout>One line.</Callout>", "<Divider />"].join("\n"), "Box"),
			"## Box\n\n<Callout>One line.</Callout>\n<Divider />",
		);
	},
	8() {
		// No heading, or a heading the text does not hold: the start of the text, under the same rules.
		const text = `${sentence(20)}\n\n## Later\nMore.`;
		for (const heading of [undefined, "Missing"])
			assert.equal(sectionExcerpt("safe_mdx", text, heading), sentence(13).trimEnd(), String(heading));
		// Organization text stored as safe_nodes.
		const doc = (blocks) => JSON.stringify({ format: "everyfield-editor-v1", blocks });
		const run = (text) => [{ type: "text", text, marks: [] }];
		const items = Array.from({ length: 30 }, (_, i) => run(`Item ${i} keeps its whole line`));
		const nodes = doc([
			{ type: "heading", level: 2, children: run("Plan") },
			{ type: "paragraph", children: run(sentence(4).trimEnd()) },
			{ type: "list", ordered: false, items },
		]);
		const listCut = sectionExcerpt("safe_nodes", nodes, "Plan");
		const lines = listCut.split("\n");
		assert.deepEqual(lines.slice(0, 2), ["## Plan", sentence(4).trimEnd()]);
		assert.deepEqual(
			lines.slice(2),
			items.slice(0, lines.length - 2).map((item) => `- ${item[0].text}`),
		);
		assert.ok(listCut.length < 500);
		const prose = doc([{ type: "paragraph", children: run(sentence(20)) }]);
		assert.equal(sectionExcerpt("safe_nodes", prose), sentence(13).trimEnd());
		assert.equal(
			sectionExcerpt("safe_nodes", doc([{ type: "paragraph", children: run(words(100)) }])).endsWith("…"),
			true,
		);
	},
};
