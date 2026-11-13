import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement as h, Children, isValidElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compiledComponent } from "./mdx.ts";
import { diagramSummary, isDiagramInfo, parseDiagram } from "../../packages/contracts/src/wiki/diagram.ts";
import type { Diagram, DiagramNode, HierarchyNode } from "../../packages/contracts/src/wiki/diagram.ts";
import type { ObjectRow } from "./rows.ts";

const notice =
	"Scripture quotations taken from the (LSB®) Legacy Standard Bible®, Copyright © 2021 by The Lockman Foundation. Used by permission. All rights reserved. Managed in partnership with Three Sixteen Publishing Inc. LSBible.org and 316publishing.com.";
const tones: Record<string, string> = { tip: "green", insight: "blue", warning: "amber", important: "violet" };
function Callout({ type, children }: { type: string; children: ReactNode }) {
	if (type === "scripture") {
		// The restricted MDX shape is one paragraph, emphasis quote, then its attribution.
		const paragraph = Children.toArray(children).find(isValidElement<{ children: ReactNode }>);
		const parts = paragraph ? Children.toArray(paragraph.props.children) : [];
		const attribution = parts.find((p) => typeof p === "string" && p.includes("—"));
		return h(
			"blockquote",
			{},
			parts.filter((p) => p !== attribution),
			h("cite", {}, typeof attribution === "string" ? attribution.replace(/^\s*—\s*/, "") : ""),
		);
	}
	return h(
		"aside",
		{ className: "card", "data-variant": "callout", "data-tone": tones[type] },
		h(
			"div",
			{ className: "callout-label" },
			h("span", { className: "ci", "aria-hidden": true }, type.slice(0, 1).toUpperCase()),
			type[0].toUpperCase() + type.slice(1),
		),
		h("div", { className: "callout-text" }, children),
	);
}
// A ```diagram block draws as the app's figure: the title as its caption and the nodes as a list in source order
// (`<ol>`, or nested `<ul>` for a hierarchy). The parser is the app's own. Other fences stay <pre><code>.
function nodeText(node: DiagramNode) {
	return [
		h("span", { key: "l", className: "dg-label" }, node.label),
		node.detail ? h("span", { key: "d", className: "dg-detail" }, node.detail) : null,
		node.note ? h("span", { key: "n", className: "dg-note" }, node.note) : null,
	];
}
function tree(nodes: readonly HierarchyNode[]): ReactNode {
	return h(
		"ul",
		{},
		nodes.map((node, index) =>
			h(
				"li",
				{ key: index },
				h("div", { className: "dg-card" }, nodeText(node)),
				node.children.length ? tree(node.children) : null,
			),
		),
	);
}
function figure(diagram: Diagram) {
	return h(
		"figure",
		{
			className: "diagram",
			"data-diagram": diagram.type,
			"aria-label": `${diagram.title}. ${diagramSummary(diagram)}`,
		},
		h("figcaption", {}, diagram.title),
		diagram.type === "hierarchy"
			? tree(diagram.nodes)
			: h(
					"ol",
					{},
					diagram.nodes.map((node, index) =>
						h("li", { key: index }, h("div", { className: "dg-card" }, nodeText(node))),
					),
				),
		diagram.loop ? h("p", { className: "dg-loop" }, `Repeats: ${diagram.loop}`) : null,
	);
}
function Pre(props: { children?: ReactNode }) {
	const code = Children.toArray(props.children).find(isValidElement<{ "data-info"?: string; children?: ReactNode }>);
	const info = code?.props["data-info"];
	if (code && info && isDiagramInfo(info)) {
		const parsed = parseDiagram(info, Children.toArray(code.props.children).join("").replace(/\n$/, ""));
		if (parsed.ok) return figure(parsed.diagram);
	}
	return h("pre", props);
}
const diagramCss = `
.diagram{margin:24px 0;padding:20px;border:1px solid var(--ef-line);border-radius:var(--ef-radius-card);background:var(--ef-surface-2);line-height:1.4}
.diagram figcaption{font-family:var(--ef-font-title);font-size:19px;letter-spacing:-.02em;color:var(--ef-ink);margin-bottom:16px}
.prose .diagram ol,.prose .diagram ul{list-style:none;margin:0;padding:0}.prose .diagram li{margin:0;padding:0}
.diagram ol{counter-reset:dg}.diagram ol>li{counter-increment:dg;position:relative}
.dg-card{background:var(--ef-surface-raised);border-radius:10px;padding:12px 14px;box-shadow:var(--ef-shadow-raised);height:100%}
.dg-label{display:block;font-weight:500;color:var(--ef-ink)}.dg-detail{display:block;margin-top:4px;font-size:14px;color:var(--ef-text-2)}.dg-note{display:block;margin-top:6px;font-size:12px;font-weight:500;color:var(--ef-text-3)}
.diagram ol .dg-card::before{content:counter(dg);display:inline-grid;place-items:center;width:24px;height:24px;margin-bottom:6px;border-radius:50%;background:var(--ef-green-100);color:var(--ef-green-700);font-family:var(--ef-font-display);font-size:13px}
.dg-loop{margin:16px 0 0;font-size:14px;color:var(--ef-text-2)}.dg-loop::before{content:"\\21BB  ";color:var(--ef-green-700)}
.prose .diagram[data-diagram=flow] ol,.prose .diagram[data-diagram=cycle] ol{display:flex;flex-direction:column;gap:28px}
.prose .diagram[data-diagram=flow] ol>li+li::before,.prose .diagram[data-diagram=cycle] ol>li+li::before{content:"\\2193";position:absolute;top:-24px;left:50%;color:var(--ef-text-3)}
.prose .diagram[data-diagram=stages] ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.prose .diagram[data-diagram=stages] .dg-card{border-top:3px solid var(--ef-green-500)}
.prose .diagram[data-diagram=hierarchy] ul ul{margin:8px 0 0 16px;padding-left:20px;border-left:1.75px solid var(--ef-text-3)}.prose .diagram[data-diagram=hierarchy] li+li{margin-top:8px}.prose .diagram[data-diagram=hierarchy] .dg-card{display:inline-block}
.prose .diagram[data-diagram=timeline] ol{border-left:1.75px solid var(--ef-text-3);margin-left:6px;padding-left:22px}.prose .diagram[data-diagram=timeline] li+li{margin-top:16px}.prose .diagram[data-diagram=timeline] .dg-card::before{content:none}
.prose .diagram[data-diagram=timeline] li::before{content:"";position:absolute;left:-29px;top:14px;width:8px;height:8px;border-radius:50%;border:2.5px solid var(--ef-green-700);background:var(--ef-surface-2)}
@media(min-width:601px){.prose .diagram[data-diagram=flow] ol{flex-direction:row}.prose .diagram[data-diagram=flow] ol>li{flex:1}.prose .diagram[data-diagram=flow] ol>li+li::before{content:"\\2192";top:40%;left:-20px}}`;
function slice(css: string, start: string, end: string) {
	const a = css.indexOf(start),
		b = css.indexOf(end, a);
	if (a === -1 || b === -1) throw new Error(`Design CSS changed; cannot find ${start}`);
	return css.slice(a, b);
}
export async function render(row: ObjectRow, code: string, section: string, root: string, out: string) {
	const [tokens, design] = await Promise.all([
		readFile(resolve(root, "design/handoff/tokens.css"), "utf8"),
		readFile(resolve(root, "design/everyfield-ui.html"), "utf8"),
	]);
	const css =
		tokens.replace(/^@import[^;]+;/gm, "") +
		slice(design, ".prose {", ".toc {") +
		slice(design, '.card[data-variant="callout"] {', '.card[data-size="sm"]') +
		diagramCss;
	const Component = await compiledComponent(code);
	const markup = renderToStaticMarkup(
		h(
			"html",
			{ lang: "en" },
			h(
				"head",
				{},
				h("meta", { charSet: "utf-8" }),
				h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
				h("title", {}, String(row.title)),
				h(
					"style",
					{},
					css +
						`
*{box-sizing:border-box}body{margin:0;background:var(--ef-surface);font-family:var(--ef-font-body);color:var(--ef-ink)}
main{max-width:796px;margin:0 auto;padding:56px 48px}h1,h2,h3{font-family:var(--ef-font-display);font-weight:400;letter-spacing:-.02em}h3{font-family:var(--ef-font-title)}h1{font-size:42px;line-height:1.12;margin:16px 0}header{margin-bottom:32px}.meta,footer{color:var(--ef-text-3);font-size:13px}.excerpt{font-size:18px;line-height:1.6;color:var(--ef-ink-2)}.badge{display:inline-block;background:var(--ef-amber-100);color:var(--ef-amber-600);padding:4px 8px;border-radius:var(--ef-radius-xs);font-size:12px;font-weight:600}.card{margin:22px 0}.prose hr{border:0;border-top:1px solid var(--ef-line-2);margin:28px 0}.prose table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.5;margin:20px 0;overflow-wrap:anywhere}.prose th,.prose td{border:1px solid var(--ef-line-2);padding:10px 12px;text-align:left;vertical-align:top}.prose th{background:var(--ef-surface-2);color:var(--ef-ink);font-weight:600}.prose .contains-task-list{list-style:none;padding-left:0}.prose .task-list-item{position:relative;padding:4px 0;padding-inline-start:24px}.prose input[type=checkbox]{position:absolute;inset-inline-start:0;top:9px;width:16px;height:16px;margin:0;accent-color:var(--ef-green-700)}.prose pre{max-width:100%;overflow-x:auto}.prose p,.prose li{overflow-wrap:anywhere}.prose .callout-text p:last-child{margin-bottom:0}footer{line-height:1.5}footer small{font-size:11px}@media(max-width:600px){main{padding:28px 20px}h1{font-size:34px}.prose{font-size:16px}.prose h2{font-size:24px}.prose th,.prose td{padding:7px 8px;font-size:12px}}`,
				),
			),
			h(
				"body",
				{},
				h(
					"main",
					{},
					h(
						"header",
						{},
						row.status === "draft" ? h("span", { className: "badge" }, "DRAFT") : null,
						h("p", { className: "meta" }, `${section} · Phase ${row.phase} · ${row.read_time_minutes} min read`),
						h("h1", {}, String(row.title)),
						h("p", { className: "excerpt" }, String(row.excerpt)),
					),
					h("article", { className: "prose" }, h(Component, { components: { Callout, pre: Pre } })),
					h("footer", { className: "prose-foot" }, h("small", {}, notice)),
				),
			),
		),
	);
	await mkdir(out, { recursive: true });
	const file = resolve(out, String(row.slug).replaceAll("/", "--") + ".html");
	await writeFile(file, "<!doctype html>\n" + markup + "\n");
	return file;
}
