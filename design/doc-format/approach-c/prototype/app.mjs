// Approach C prototype editor. No library: Everyfield owns the block tree, and only text leaves are contenteditable.
// Every edit goes model-first: a leaf's DOM is parsed back into inline nodes, structure changes rebuild the view.
import * as F from "../format.mjs";

const EXAMPLES = ["conflict-of-interest-policy", "commitment-card", "guest-sign-in-sheet", "budget-worksheet"];
const SAMPLE = {
	church: {
		name: "Grace Hill Church",
		legal_name: "Grace Hill Church, Inc.",
		tagline: "",
		address: "214 Oak Street, Columbus, OH 43215",
		phone: "(614) 555-0142",
		email: "hello@gracehill.example",
		web: "gracehill.example",
	},
	pastor: { name: "Ana Ruiz" },
	meeting: { date: "Thursday, November 12, 2026", number: "3" },
	today: "November 1, 2026",
	values: {},
};
const PALETTES = {
	neutral: { primary: "#181D19", onPrimary: "#FFFFFF", accent: "#026B40", onAccent: "#FFFFFF", primaryText: "#181D19" },
	brand: { primary: "#1F4E79", onPrimary: "#FFFFFF", accent: "#E8A33D", onAccent: "#181D19", primaryText: "#1F4E79" },
};
const CONTAINERS = new Set(["slot", "box", "column", "repeat"]);
const TEXT_BLOCKS = new Set(["paragraph", "heading"]);

// ------------------------------------------------------------------------------------------------ state and helpers

const state = {
	entries: new Map(), // id -> { doc, collection: "template" | "document", pristine }
	current: null,
	mode: "edit",
	brand: false,
	sel: null, // a path array into the doc, e.g. ["body", 3, "content", 0]
	tab: "inspect",
	undo: [],
	redo: [],
	seq: 0,
	lastTyped: 0,
	savedRange: null,
	checkReport: null,
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const doc = () => state.entries.get(state.current).doc;
const getAt = (root, path) => path.reduce((v, k) => v?.[k], root);
const keyOf = (path) => path.join(".");
const pathOf = (el) => el.dataset.path.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
const dollar = (path) => "$" + path.map((k) => (typeof k === "number" ? `[${k}]` : `.${k}`)).join("");
const $ = (sel, root = document) => root.querySelector(sel);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function fingerprint(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
	return h.toString(16).padStart(8, "0");
}
function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === null || v === undefined || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "style") el.style.cssText = v;
		else if (k === "text") el.textContent = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
	return el;
}
const labelOfType = {
	heading: "Heading",
	paragraph: "Paragraph",
	list: "List",
	listItem: "List item",
	quote: "Quote",
	divider: "Divider",
	pageBreak: "Page break",
	slot: "Fill-in section",
	box: "Box",
	columns: "Columns",
	column: "Column",
	table: "Table",
	row: "Row",
	cell: "Cell",
	repeat: "Repeat (n-up)",
	logo: "Logo",
	field: "Field",
	checkbox: "Checkbox",
};

// ------------------------------------------------------------------------------------------------ inline content model

const unitLen = (n) => (n.type === "text" ? n.text.length : 1);
const contentLen = (content) => content.reduce((s, n) => s + unitLen(n), 0);
const sortMarks = (marks) => [...marks].sort((a, b) => F.MARK_ORDER.indexOf(a.type) - F.MARK_ORDER.indexOf(b.type));
function normalize(content) {
	const out = [];
	for (const n of content) {
		if (n.type === "text") {
			if (!n.text) continue;
			const marks = n.marks?.length ? sortMarks(n.marks) : undefined;
			const prev = out.at(-1);
			if (prev?.type === "text" && sameJson(prev.marks, marks)) {
				prev.text += n.text;
				continue;
			}
			out.push(marks ? { type: "text", text: n.text, marks } : { type: "text", text: n.text });
		} else out.push(n);
	}
	return out;
}
function splitAt(content, cuts) {
	const out = [];
	let pos = 0;
	for (const n of content) {
		const len = unitLen(n);
		if (n.type === "text") {
			const inner = cuts.filter((c) => c > pos && c < pos + len).sort((a, b) => a - b);
			let start = 0;
			for (const c of [...inner.map((c) => c - pos), len]) {
				out.push({ ...n, text: n.text.slice(start, c) });
				start = c;
			}
		} else out.push(n);
		pos += len;
	}
	return out;
}
function sliceContent(content, start, end) {
	const out = [];
	let pos = 0;
	for (const n of splitAt(content, [start, end])) {
		const len = unitLen(n);
		if (pos >= start && pos + len <= end && len > 0) out.push(clone(n));
		pos += len;
	}
	return normalize(out);
}
/** mode: toggle | add | remove. attrs: the mark attrs for add and toggle. */
function setMark(content, start, end, type, attrs, mode) {
	const parts = splitAt(content, [start, end]);
	const inRange = [];
	let pos = 0;
	parts.forEach((n, i) => {
		const len = unitLen(n);
		if (n.type === "text" && pos >= start && pos + len <= end) inRange.push(i);
		pos += len;
	});
	const has = (n) => (n.marks ?? []).some((m) => m.type === type && (attrs === undefined || sameJson(m.attrs, attrs)));
	const removing = mode === "remove" || (mode === "toggle" && inRange.length > 0 && inRange.every((i) => has(parts[i])));
	for (const i of inRange) {
		const marks = (parts[i].marks ?? []).filter((m) => m.type !== type);
		if (!removing) marks.push(attrs ? { type, attrs } : { type });
		parts[i] = { ...parts[i], marks };
	}
	return normalize(parts);
}

// ------------------------------------------------------------------------------------------------ DOM <-> inline

const isAtom = (n) => n.nodeType === 1 && (n.hasAttribute("data-atom") || n.tagName === "BR");
function unitsOf(root) {
	const out = [];
	const walk = (n) => {
		for (const c of n.childNodes) {
			if (c.nodeType === 3) out.push({ node: c, len: c.data.length });
			else if (isAtom(c)) out.push({ node: c, len: 1 });
			else if (c.nodeType === 1) walk(c);
		}
	};
	walk(root);
	return out;
}
function offsetIn(leaf, container, offset) {
	const r = document.createRange();
	r.setStart(leaf, 0);
	r.setEnd(container, offset);
	return unitsOf(r.cloneContents()).reduce((s, u) => s + u.len, 0);
}
function caretOffsets(leaf) {
	const sel = getSelection();
	if (!sel.rangeCount) return null;
	const r = sel.getRangeAt(0);
	if (!leaf.contains(r.startContainer) || !leaf.contains(r.endContainer)) return null;
	return [offsetIn(leaf, r.startContainer, r.startOffset), offsetIn(leaf, r.endContainer, r.endOffset)];
}
function pointAt(leaf, offset) {
	let rest = offset;
	for (const u of unitsOf(leaf)) {
		if (rest <= u.len) {
			if (u.node.nodeType === 3) return [u.node, rest];
			const parent = u.node.parentNode;
			const idx = [...parent.childNodes].indexOf(u.node);
			return [parent, rest === 0 ? idx : idx + 1];
		}
		rest -= u.len;
	}
	return [leaf, leaf.childNodes.length];
}
function placeCaret(leaf, start, end = start) {
	const r = document.createRange();
	r.setStart(...pointAt(leaf, start));
	r.setEnd(...pointAt(leaf, end));
	const sel = getSelection();
	sel.removeAllRanges();
	sel.addRange(r);
}
function marksOf(el) {
	const t = el.tagName;
	const marks = [];
	if (t === "STRONG" || t === "B" || el.style?.fontWeight === "bold" || el.style?.fontWeight === "700") marks.push({ type: "bold" });
	if (t === "EM" || t === "I" || el.style?.fontStyle === "italic") marks.push({ type: "italic" });
	if (t === "U") marks.push({ type: "underline" });
	if (t === "S" || t === "STRIKE" || t === "DEL") marks.push({ type: "strike" });
	if (t === "A" && el.getAttribute("href")) marks.push({ type: "link", attrs: { href: el.getAttribute("href") } });
	if (el.dataset?.tone) marks.push({ type: "tone", attrs: { tone: el.dataset.tone } });
	if (el.dataset?.caps !== undefined) marks.push({ type: "caps" });
	return marks;
}
function parseInline(leaf) {
	const out = [];
	const walk = (node, marks) => {
		for (const c of node.childNodes) {
			if (c.nodeType === 3) {
				out.push({ type: "text", text: c.data.replace(/ /g, " "), marks: [...marks] });
			} else if (c.nodeType === 1) {
				if (c.dataset.atom === "field") {
					const attrs = { key: c.dataset.key };
					if (c.dataset.display && c.dataset.display !== "inline") attrs.display = c.dataset.display;
					if (c.dataset.width) attrs.width = Number(c.dataset.width);
					out.push({ type: "field", attrs });
				} else if (c.dataset.atom === "checkbox") {
					out.push(c.dataset.key ? { type: "checkbox", attrs: { key: c.dataset.key } } : { type: "checkbox" });
				} else if (c.tagName === "BR") out.push({ type: "hardBreak" });
				else {
					const add = marksOf(c).filter((m) => !marks.some((x) => x.type === m.type));
					walk(c, [...marks, ...add]);
				}
			}
		}
	};
	walk(leaf, []);
	if (out.at(-1)?.type === "hardBreak") out.pop(); // the browser's placeholder <br>
	return normalize(out.map((n) => (n.type === "text" && !n.marks.length ? { type: "text", text: n.text } : n)));
}

// ------------------------------------------------------------------------------------------------ rendering

const sheetHost = () => $("#sheet");
function pageDims(page) {
	const [w, hgt] = F.PAGE_SIZES[page.size];
	return page.orientation === "landscape" ? [hgt, w] : [w, hgt];
}
function renderInline(content, ctx) {
	const frag = document.createDocumentFragment();
	for (const node of content ?? []) frag.append(inlineNode(node, ctx));
	return frag;
}
function wrapMark(m, child) {
	const tag = { bold: "strong", italic: "em", underline: "u", strike: "s", link: "a" }[m.type] ?? "span";
	const el = h(tag);
	if (m.type === "link") el.setAttribute("href", m.attrs.href);
	if (m.type === "tone") el.dataset.tone = m.attrs.tone;
	if (m.type === "caps") el.dataset.caps = "";
	el.append(child);
	return el;
}
function inlineNode(node, ctx) {
	if (node.type === "text") {
		let el = document.createTextNode(node.text);
		for (const m of sortMarks(node.marks ?? []).reverse()) el = wrapMark(m, el);
		return el;
	}
	if (node.type === "hardBreak") return h("br");
	if (node.type === "checkbox") return h("span", { class: "chk", contenteditable: "false", "data-atom": "checkbox", "data-key": node.attrs?.key ?? "", title: `Checkbox ${node.attrs?.key ?? ""}` });
	const a = F.attrsOf(node);
	const def = ctx.doc.fields.find((f) => f.key === a.key);
	const label = def?.label ?? a.key;
	const value = ctx.mode === "preview" ? F.resolveField(ctx.doc, a.key, SAMPLE) : null;
	const el = h("span", {
		class: `fld fld-${a.display}${ctx.mode === "edit" ? " is-chip" : ""}${value ? " is-filled" : ""}`,
		contenteditable: "false",
		"data-atom": "field",
		"data-key": a.key,
		"data-display": a.display,
		"data-width": a.width ?? "",
		title: `Field ${label}${def?.source ? ` (from ${def.source})` : " (write-in)"}`,
	});
	if (a.display === "line") {
		if (a.width) el.style.width = `${a.width}pt`;
		el.append(h("span", { class: "fld-value" }, value ?? " "), h("span", { class: "fld-label" }, label));
	} else el.textContent = ctx.mode === "edit" ? label : (value ?? `[${label.toLowerCase()}]`);
	return el;
}
function leaf(tag, node, path, ctx, cls, placeholder) {
	const el = h(tag, { class: cls, "data-path": ctx.mirror ? null : keyOf(path), "data-leaf": "inline", "data-placeholder": placeholder });
	if (ctx.mode === "edit" && !ctx.mirror) {
		el.contentEditable = "true";
		el.spellcheck = true;
	}
	el.append(renderInline(node.content, ctx));
	if (!node.content?.length) el.classList.add("is-empty");
	return el;
}
function blockShell(tag, cls, path, ctx) {
	return h(tag, { class: cls, "data-path": ctx.mirror ? null : keyOf(path), tabindex: ctx.mode === "edit" && !ctx.mirror ? "-1" : null });
}
function renderNodes(nodes, arrPath, ctx, emptyHint) {
	const frag = document.createDocumentFragment();
	nodes.forEach((node, i) => frag.append(renderBlock(node, [...arrPath, i], ctx)));
	if (!nodes.length && ctx.mode === "edit" && !ctx.mirror && emptyHint)
		frag.append(h("button", { type: "button", class: "add-here", "data-add": keyOf(arrPath) }, emptyHint));
	return frag;
}
function renderBlock(node, path, ctx) {
	const a = F.attrsOf(node);
	switch (node.type) {
		case "heading":
			return leaf(a.level === 0 ? "h1" : `h${a.level + 1}`, node, path, ctx, `b-h b-h${a.level}`, a.level === 0 ? "Title" : "Heading");
		case "paragraph":
			return leaf("p", node, path, ctx, `b-p size-${a.size} align-${a.align}`, "Type here");
		case "list": {
			const el = blockShell(a.ordered ? "ol" : "ul", "b-list", path, ctx);
			node.content.forEach((item, i) => {
				const li = h("li", { "data-path": ctx.mirror ? null : keyOf([...path, "content", i]) });
				li.append(renderNodes(item.content, [...path, "content", i, "content"], ctx));
				el.append(li);
			});
			return el;
		}
		case "quote": {
			const el = blockShell("blockquote", "b-quote", path, ctx);
			el.append(renderNodes(node.content, [...path, "content"], ctx));
			return el;
		}
		case "divider":
			return blockShell("div", `b-div w-${a.weight} t-${a.tone}`, path, ctx);
		case "pageBreak": {
			const el = blockShell("div", "b-pb", path, ctx);
			el.append(h("span", {}, `Page break${a.sheet ? ` · sheet "${a.sheet}"` : ""}`));
			return el;
		}
		case "slot": {
			const el = blockShell("section", `b-slot${node.content?.length ? "" : " is-blank"}`, path, ctx);
			el.append(h("div", { class: "slot-label" }, a.label));
			if (!node.content?.length && (ctx.mode === "preview" || ctx.mirror))
				el.append(h("div", { class: "slot-hint" }, "Not filled in yet. Your church or its sending network adds this text."));
			el.append(renderNodes(node.content ?? [], [...path, "content"], ctx, "+ Add text to this section"));
			return el;
		}
		case "box": {
			const el = blockShell("div", `b-box fill-${a.fill} border-${a.border}`, path, ctx);
			el.style.padding = `${a.padding}pt`;
			if (a.minHeight) el.style.minHeight = `${a.minHeight}pt`;
			el.append(renderNodes(node.content ?? [], [...path, "content"], ctx, "+ Add a paragraph"));
			return el;
		}
		case "columns": {
			const el = blockShell("div", `b-cols v-${a.align}`, path, ctx);
			el.style.gridTemplateColumns = node.content.map((c) => `${F.attrsOf(c).width}fr`).join(" ");
			el.style.columnGap = `${a.gap}pt`;
			node.content.forEach((col, i) => {
				const cp = [...path, "content", i];
				const c = blockShell("div", "b-col", cp, ctx);
				c.append(renderNodes(col.content ?? [], [...cp, "content"], ctx, "+ Add a paragraph"));
				el.append(c);
			});
			return el;
		}
		case "table":
			return renderTable(node, path, ctx, a);
		case "repeat":
			return renderRepeat(node, path, ctx, a);
		case "logo": {
			const el = blockShell("div", `b-logo align-${a.align}`, path, ctx);
			el.style.height = `${a.height}pt`;
			if (state.brand) {
				el.append(
					h("span", { class: "logo-mark", style: `width:${a.height}pt;height:${a.height}pt` }),
					h("span", { class: "logo-name", style: `font-size:${Math.max(9, a.height * 0.42)}pt` }, SAMPLE.church.name),
				);
			} else el.append(h("span", { class: "logo-type", style: `font-size:${Math.max(10, a.height * 0.55)}pt` }, SAMPLE.church.name));
			return el;
		}
	}
	return h("div", { class: "b-unknown" }, `Unknown node ${node.type}`);
}
function renderTable(node, path, ctx, a) {
	const wrap = blockShell("div", "b-table-wrap", path, ctx);
	const table = h("table", { class: `b-table rules-${a.rules} size-${a.size}${a.zebra ? " zebra" : ""} hf-${a.headerFill}` });
	const total = a.columns.reduce((s, c) => s + c.width, 0);
	const cg = h("colgroup");
	for (const c of a.columns) cg.append(h("col", { style: `width:${((c.width / total) * 100).toFixed(2)}%` }));
	table.append(cg);
	const results = ctx.results;
	node.content.forEach((row, r) => {
		const tr = h("tr", { class: r < a.headerRows ? "is-head" : r % 2 === (a.headerRows % 2) ? "odd" : "even" });
		if (a.minRowHeight) tr.style.height = `${a.minRowHeight}pt`;
		let col = 0;
		row.content.forEach((cell, c) => {
			const ca = F.attrsOf(cell);
			const cp = [...path, "content", r, "content", c];
			const align = ca.align ?? a.columns[col]?.align ?? (ca.kind === "text" ? "left" : "right");
			const td = h(r < a.headerRows ? "th" : "td", { class: `fill-${ca.fill} align-${align} kind-${ca.kind}`, colspan: ca.colspan && ca.colspan > 1 ? ca.colspan : null });
			col += ca.colspan ?? 1;
			if (ca.kind === "text") td.append(leaf("div", cell, cp, ctx, "cell-text", ""));
			else if (ca.kind === "number") {
				const el = h("div", { class: "cell-num", "data-path": ctx.mirror ? null : keyOf(cp), "data-leaf": "number", "data-format": ca.format });
				if (ctx.mode === "edit" && !ctx.mirror) el.contentEditable = "true";
				el.textContent = F.formatNumber(ca.value, ca.format);
				td.append(el);
			} else {
				const res = results.get(dollar(cp));
				const el = h("div", { class: `cell-formula${res?.error ? " is-error" : ""}`, "data-path": ctx.mirror ? null : keyOf(cp), "data-leaf": "formula", "data-format": ca.format, tabindex: ctx.mirror ? null : "0", title: `= ${ca.formula}${res?.error ? `\n${res.error}` : ""}` });
				el.textContent = res?.error ? "#ERROR" : F.formatNumber(res?.value ?? 0, ca.format);
				td.append(el);
			}
			if (a.fillable && r >= a.headerRows && ca.kind === "text" && !cell.content?.length && ctx.mode === "preview")
				td.classList.add("is-fillable");
			tr.append(td);
		});
		table.append(tr);
	});
	wrap.append(table);
	return wrap;
}
function renderRepeat(node, path, ctx, a) {
	const el = blockShell("div", `b-repeat${a.cutMarks ? " cut" : ""}`, path, ctx);
	const cellH = (ctx.contentH - (a.down - 1) * a.gap) / a.down - 0.5;
	el.style.gridTemplateColumns = `repeat(${a.across}, 1fr)`;
	el.style.gridAutoRows = `${cellH}pt`;
	el.style.gap = `${a.gap}pt`;
	const copies = a.across * a.down;
	for (let i = 0; i < copies; i += 1) el.append(repeatCopy(node, path, { ...ctx, mirror: ctx.mirror || i > 0 }, a, i));
	return el;
}
function repeatCopy(node, path, ctx, a, i) {
	const copy = h("div", { class: `rep-copy${i > 0 ? " is-mirror" : ""}`, "data-copy": i, style: `padding:${a.padding}pt` });
	copy.append(renderNodes(node.content ?? [], [...path, "content"], ctx, "+ Add a paragraph to the card"));
	return copy;
}
function refreshMirrors(leafEl) {
	const rep = leafEl.closest(".b-repeat");
	if (!rep) return;
	const path = pathOf(rep);
	const node = getAt(doc(), path);
	const ctx = makeCtx();
	const a = F.attrsOf(node);
	rep.querySelectorAll(":scope > .rep-copy.is-mirror").forEach((old) => old.replaceWith(repeatCopy(node, path, { ...ctx, mirror: true }, a, Number(old.dataset.copy))));
}
function makeCtx() {
	const d = doc();
	const [, ph] = pageDims(d.page);
	const m = d.page.margins;
	return { doc: d, mode: state.mode, mirror: false, contentH: ph - m.top - m.bottom, results: F.evaluate(d) };
}
function footerText(d) {
	return (d.page.footer ?? [])
		.map((n) => (n.type === "text" ? n.text : n.type === "field" ? (F.resolveField(d, n.attrs.key, SAMPLE) ?? "") : n.type === "hardBreak" ? " " : ""))
		.join("");
}
function renderSheet() {
	const d = doc();
	const host = sheetHost();
	const [pw, ph] = pageDims(d.page);
	const m = d.page.margins;
	const pal = PALETTES[state.brand ? "brand" : "neutral"];
	const ctx = makeCtx();
	host.className = `sheet mode-${state.mode}${d.theme.numberHeadings ? " numbered" : ""}`;
	host.style.cssText = `width:${pw}pt;min-height:${ph}pt;padding:${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt;--ph:${ph}pt;--primary:${pal.primary};--on-primary:${pal.onPrimary};--accent:${pal.accent};--on-accent:${pal.onAccent};--primary-text:${pal.primaryText}`;
	host.replaceChildren();
	const body = h("div", { class: "sheet-body" });
	body.append(renderNodes(d.body, ["body"], ctx, "This document is empty. Click to add a paragraph."));
	host.append(body);
	const notices = F.noticesOf(d);
	if (d.page.footer !== undefined || notices.length) {
		const foot = h("div", { class: "sheet-foot", style: `left:${m.left}pt;right:${m.right}pt;bottom:${Math.max(6, m.bottom / 2 - 6)}pt` });
		if (d.page.footer !== undefined) foot.append(leaf("div", { content: d.page.footer }, ["page", "footer"], ctx, "foot-text", "Page footer"));
		else foot.append(h("div"));
		for (const n of notices) foot.append(h("div", { class: "notice", title: "Added at export for every formal/legal document. It is not content, so editing and wiping do not remove it." }, n));
		host.append(foot);
	}
	$("#page-style").textContent = `@page { size: ${pw}pt ${ph}pt; margin: ${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt;
  @bottom-left { content: ${JSON.stringify(footerText(d))}; font: 7.5pt "DM Sans", sans-serif; color: #5b616e; }
  @bottom-right { content: ${JSON.stringify(notices.join(" "))}; font: 700 7.5pt "DM Sans", sans-serif; color: #181d19; } }`;
	fit();
	requestAnimationFrame(markOverflow);
	if (state.sel) {
		const el = host.querySelector(`[data-path="${keyOf(state.sel)}"]`);
		if (el && !el.isContentEditable) el.classList.add("is-selected");
	}
}
function markOverflow() {
	sheetHost()
		.querySelectorAll(".rep-copy")
		.forEach((c) => c.classList.toggle("is-overflowing", c.scrollHeight > c.clientHeight + 1));
}
function fit() {
	const scroller = $("#canvas");
	const d = doc();
	const [pw] = pageDims(d.page);
	const px = (pw * 4) / 3;
	const zoom = Math.min(1, (scroller.clientWidth - 24) / px);
	$("#sheet-wrap").style.zoom = String(Math.max(0.3, zoom));
}

// ------------------------------------------------------------------------------------------------ chrome: library, doc bar, panel

function renderLibrary() {
	const list = (collection) =>
		[...state.entries.values()]
			.filter((e) => e.collection === collection)
			.map((e) =>
				h(
					"button",
					{ type: "button", class: `lib-item${e.doc.id === state.current ? " is-current" : ""}`, "data-open": e.doc.id, "aria-current": e.doc.id === state.current ? "page" : null },
					h("span", { class: "lib-title" }, e.doc.meta.title),
					h("span", { class: "lib-meta" }, collection === "template" ? `${e.doc.id} · v${e.doc.version}` : e.doc.origin ? `from ${e.doc.origin.template} v${e.doc.origin.version}` : "blank document"),
				),
			);
	$("#lib-templates").replaceChildren(...list("template"));
	const docs = list("document");
	$("#lib-documents").replaceChildren(...(docs.length ? docs : [h("p", { class: "lib-empty" }, "No documents yet. Use a template or start blank.")]));
	const pick = $("#lib-select");
	pick.replaceChildren(
		...[...state.entries.values()].map((e) => h("option", { value: e.doc.id, selected: e.doc.id === state.current }, `${e.collection === "template" ? "Template" : "Document"}: ${e.doc.meta.title}`)),
	);
}
function renderDocBar() {
	const entry = state.entries.get(state.current);
	const d = entry.doc;
	const result = F.validate(d);
	$("#doc-title").textContent = d.meta.title;
	const kind = $("#doc-kind");
	if (entry.collection === "template") kind.textContent = `Template · ${d.id} · version ${d.version}`;
	else if (d.origin) {
		const tpl = state.entries.get(d.origin.template);
		const same = tpl && JSON.stringify(tpl.doc) === tpl.pristine;
		kind.textContent = `Document · made from ${d.origin.template} v${d.origin.version} · template ${same ? "unchanged" : "edited since load"} (${fingerprint(JSON.stringify(tpl?.doc ?? null))})`;
	} else kind.textContent = "Document · blank";
	const chip = $("#doc-valid");
	chip.textContent = result.ok ? "Valid" : `${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}`;
	chip.className = `chip ${result.ok ? "chip-ok" : "chip-bad"}`;
	chip.title = result.ok ? "The document passes the format check." : result.errors.join("\n");
	$("#btn-fork").hidden = entry.collection !== "template";
	document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
	$("#btn-brand").setAttribute("aria-pressed", String(state.brand));
}
function renderPanel() {
	document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
	const body = $("#panel-body");
	body.replaceChildren(
		{ inspect: inspectPanel, page: pagePanel, fields: fieldsPanel, json: jsonPanel, check: checkPanel }[state.tab](),
	);
}
function updateToolbar() {
	const d = doc();
	const sel = state.sel;
	const node = sel ? getAt(d, sel) : null;
	const inText = !!sel && sel[0] !== "page" ? node && (TEXT_BLOCKS.has(node.type) || (node.type === "cell" && F.attrsOf(node).kind === "text")) : sel?.[0] === "page";
	const editing = state.mode === "edit";
	document.querySelectorAll("[data-needs='text']").forEach((b) => (b.disabled = !editing || !inText));
	const cell = sel ? cellPathOf(sel) : null;
	document.querySelectorAll("[data-needs='table']").forEach((b) => (b.disabled = !editing || !cell));
	$("#tb-table").hidden = !editing || !cell;
	document.querySelectorAll("[data-needs='block']").forEach((b) => (b.disabled = !editing || !sel || sel[0] !== "body"));
	document.querySelectorAll("[data-needs='edit']").forEach((b) => (b.disabled = !editing));
	$("#btn-undo").disabled = !state.undo.length;
	$("#btn-redo").disabled = !state.redo.length;
	const typeSel = $("#sel-type");
	typeSel.disabled = !editing || !node || !TEXT_BLOCKS.has(node.type) || sel[0] !== "body";
	if (node && TEXT_BLOCKS.has(node.type)) {
		const parent = getAt(d, sel.slice(0, -2));
		const list = parent?.type === "listItem" ? getAt(d, sel.slice(0, -4)) : null;
		typeSel.value = list ? (F.attrsOf(list).ordered ? "ol" : "ul") : parent?.type === "quote" ? "quote" : node.type === "heading" ? `h${F.attrsOf(node).level}` : "paragraph";
	} else typeSel.value = "";
	const fieldSel = $("#sel-field");
	fieldSel.replaceChildren(h("option", { value: "" }, "Insert field…"), ...d.fields.map((f) => h("option", { value: f.key }, f.label)));
	fieldSel.disabled = !editing || !inText;
}
function refreshChrome() {
	renderDocBar();
	renderPanel();
	updateToolbar();
}
function render() {
	renderLibrary();
	renderSheet();
	refreshChrome();
}

// ------------------------------------------------------------------------------------------------ panels

function field(label, control, hint) {
	return h("label", { class: "row" }, h("span", { class: "row-label" }, label), control, hint ? h("span", { class: "row-hint" }, hint) : null);
}
function attrControl(spec, value, onChange, opts = {}) {
	if (spec.type === "enum" || opts.choices) {
		const choices = opts.choices ?? spec.values.map((v) => [v, v]);
		const s = h("select", { onchange: (e) => onChange(e.target.value === "" ? undefined : e.target.value) });
		if (spec.optional) s.append(h("option", { value: "" }, "(default)"));
		for (const [v, l] of choices) s.append(h("option", { value: v, selected: v === value }, l));
		return s;
	}
	if (spec.type === "boolean") return h("input", { type: "checkbox", checked: !!value, onchange: (e) => onChange(e.target.checked) });
	if (spec.type === "number" || spec.type === "integer")
		return h("input", {
			type: "number",
			value: value ?? "",
			min: spec.min,
			max: spec.max,
			step: spec.type === "integer" ? 1 : "any",
			onchange: (e) => onChange(e.target.value === "" ? (spec.nullable ? null : undefined) : Number(e.target.value)),
		});
	return h("input", { type: "text", value: value ?? "", onchange: (e) => onChange(e.target.value === "" ? undefined : e.target.value) });
}
function setAttr(path, name, value) {
	mutate((d) => {
		const n = getAt(d, path);
		n.attrs = n.attrs ?? {};
		if (value === undefined) delete n.attrs[name];
		else n.attrs[name] = value;
		if (n.type === "cell" && name === "kind") {
			delete n.attrs.value;
			delete n.attrs.formula;
			if (value === "number") {
				n.attrs.value = null;
				n.content = [];
			} else if (value === "formula") {
				n.attrs.formula = "sum(above)";
				n.content = [];
			}
			if (value === "text" || value === undefined) delete n.attrs.kind;
		}
		if (n.type === "table" && name === "headerRows")
			n.content.slice(0, value ?? 1).forEach((row) => row.content.forEach((c) => {
				if (c.attrs) {
					delete c.attrs.kind;
					delete c.attrs.value;
					delete c.attrs.formula;
				}
			}));
		if (!Object.keys(n.attrs).length) delete n.attrs;
	}, path);
}
function inspectPanel() {
	const d = doc();
	const box = h("div", { class: "panel-stack" });
	if (!state.sel) {
		box.append(h("p", { class: "muted" }, "Click any block on the page to see and change its settings. Text blocks are typed in directly."));
		box.append(blockHelp());
		return box;
	}
	const sel = state.sel;
	if (sel[0] === "page") {
		box.append(h("p", { class: "muted" }, "The page footer prints at the bottom of every page. Type in it, or insert a field."));
		return box;
	}
	// Breadcrumb: every node from the body down to the selection.
	const crumbs = h("nav", { class: "crumbs", "aria-label": "Selected block and its parents" });
	for (let i = 2; i <= sel.length; i += 2) {
		const p = sel.slice(0, i);
		const n = getAt(d, p);
		if (!n?.type) continue;
		crumbs.append(h("button", { type: "button", class: `crumb${i === sel.length ? " is-current" : ""}`, onclick: () => selectPath(p) }, labelOfType[n.type] ?? n.type));
	}
	box.append(crumbs);
	const node = getAt(d, sel);
	if (!node) return box;
	const spec = F.NODES[node.type];
	box.append(h("h3", { class: "panel-h" }, labelOfType[node.type] ?? node.type), h("p", { class: "muted small" }, spec.doc));
	const a = F.attrsOf(node);
	for (const [name, s] of Object.entries(spec.attrs)) {
		if (name === "columns") {
			box.append(h("div", { class: "row-label" }, "Column widths (shares of the table width)"));
			const grid = h("div", { class: "col-widths" });
			a.columns.forEach((c, i) =>
				grid.append(
					h("input", {
						type: "number",
						min: 1,
						value: c.width,
						"aria-label": `Width of column ${i + 1}`,
						onchange: (e) => mutate((dd) => (getAt(dd, sel).attrs.columns[i].width = Math.max(1, Number(e.target.value) || 1)), sel),
					}),
				),
			);
			box.append(grid);
			continue;
		}
		if (node.type === "cell" && name === "value" && a.kind !== "number") continue;
		if (node.type === "cell" && name === "formula" && a.kind !== "formula") continue;
		const opts = {};
		if (node.type === "field" && name === "key") opts.choices = d.fields.map((f) => [f.key, f.label]);
		const control = attrControl(s, node.attrs?.[name] ?? (s.optional ? undefined : s.default), (v) => setAttr(sel, name, v), opts);
		if (name === "formula") {
			const res = F.evaluate(d).get(dollar(sel));
			box.append(field("Formula", control, res?.error ? `Error: ${res.error}` : `= ${F.formatNumber(res?.value ?? 0, a.format)} · use sum(above), sum(left), above, left, @name, + − * /`));
			continue;
		}
		box.append(field(name, control));
	}
	if (node.type === "columns")
		box.append(
			h("div", { class: "btn-row" },
				h("button", { type: "button", class: "btn", disabled: node.content.length >= 4, onclick: () => mutate((dd) => getAt(dd, sel).content.push({ type: "column", content: [{ type: "paragraph", content: [] }] }), sel) }, "Add column"),
				h("button", { type: "button", class: "btn", disabled: node.content.length <= 2, onclick: () => mutate((dd) => getAt(dd, sel).content.pop(), sel) }, "Remove last column"),
			),
		);
	return box;
}
function blockHelp() {
	return h("div", { class: "help" },
		h("h3", { class: "panel-h" }, "How the editor works"),
		h("ul", {},
			h("li", {}, "Enter splits a block. Shift+Enter adds a line break. Tab and Shift+Tab nest list items."),
			h("li", {}, "Insert adds a block after the selected block, inside the same box, column or card."),
			h("li", {}, "Click a field chip or a checkbox to change it. Click a table border to select the table."),
			h("li", {}, "A Repeat prints its content across and down the page: 4-up cards, labels, half sheets."),
		),
	);
}
function pagePanel() {
	const d = doc();
	const entry = state.entries.get(state.current);
	const box = h("div", { class: "panel-stack" });
	const set = (fn) => mutate(fn, state.sel);
	box.append(h("h3", { class: "panel-h" }, "Document"));
	box.append(field("Title", h("input", { type: "text", value: d.meta.title, onchange: (e) => set((dd) => (dd.meta.title = e.target.value || "Untitled")) })));
	const cls = attrControl({ type: "enum", values: F.CLASSES }, d.meta.class, (v) => set((dd) => (dd.meta.class = v)));
	if (entry.collection === "document" && d.origin) cls.disabled = true;
	box.append(field("Class", cls, d.origin ? "Set by the template. It decides the legal notice, so a copy cannot change it." : 'formal/legal prints "Template, not legal advice" at export.'));
	box.append(field("Number the level-1 headings", attrControl({ type: "boolean" }, d.theme.numberHeadings, (v) => set((dd) => (dd.theme.numberHeadings = v)))));
	box.append(h("h3", { class: "panel-h" }, "Page setup"));
	box.append(field("Size", attrControl({ type: "enum", values: Object.keys(F.PAGE_SIZES) }, d.page.size, (v) => set((dd) => (dd.page.size = v)))));
	box.append(field("Orientation", attrControl({ type: "enum", values: ["portrait", "landscape"] }, d.page.orientation, (v) => set((dd) => (dd.page.orientation = v)))));
	const margins = h("div", { class: "margins" });
	for (const side of ["top", "right", "bottom", "left"])
		margins.append(
			h("label", {}, h("span", { class: "row-label" }, side), h("input", { type: "number", min: 0, max: 144, value: d.page.margins[side], "data-margin": side, onchange: (e) => set((dd) => (dd.page.margins[side] = Math.min(144, Math.max(0, Number(e.target.value) || 0)))) })),
		);
	box.append(h("div", { class: "row-label" }, "Margins (points; 72 = 1 inch)"), margins);
	box.append(
		field(
			"Page footer",
			attrControl({ type: "boolean" }, d.page.footer !== undefined, (v) =>
				set((dd) => {
					if (v) dd.page.footer = [];
					else delete dd.page.footer;
				}),
			),
		),
	);
	return box;
}
function slug(label, taken) {
	const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1") || "field";
	let key = base;
	for (let i = 2; taken.has(key); i += 1) key = `${base}_${i}`;
	return key;
}
function fieldsPanel() {
	const d = doc();
	const box = h("div", { class: "panel-stack" });
	box.append(h("p", { class: "muted small" }, "A field is a named value. With a source it fills from church data in Preview and at export. Without one it prints as a write-in blank."));
	const used = new Set();
	const walk = (nodes) => (nodes ?? []).forEach((n) => (n.type === "field" ? used.add(n.attrs.key) : Array.isArray(n.content) && walk(n.content)));
	walk(d.body);
	walk(d.page.footer);
	const sources = [["", "— write-in —"], ...F.SOURCES.map((s) => [s, s])];
	d.fields.forEach((f, i) => {
		const card = h("div", { class: "field-card" });
		card.append(h("code", {}, f.key));
		card.append(field("Label", h("input", { type: "text", value: f.label, onchange: (e) => mutate((dd) => (dd.fields[i].label = e.target.value || f.key), state.sel) })));
		const src = h("select", { onchange: (e) => mutate((dd) => (dd.fields[i].source = e.target.value || null), state.sel) });
		for (const [v, l] of sources) src.append(h("option", { value: v, selected: (f.source ?? "") === v }, l));
		card.append(field("Source", src));
		card.append(field("Default", h("input", { type: "text", value: f.default ?? "", onchange: (e) => mutate((dd) => (e.target.value ? (dd.fields[i].default = e.target.value) : delete dd.fields[i].default), state.sel) })));
		card.append(h("button", { type: "button", class: "btn btn-quiet", disabled: used.has(f.key), title: used.has(f.key) ? "The document uses this field." : null, onclick: () => mutate((dd) => dd.fields.splice(i, 1), state.sel) }, "Remove field"));
		box.append(card);
	});
	const label = h("input", { type: "text", placeholder: "For example: Meeting place", "aria-label": "New field label", id: "new-field-label" });
	const src = h("select", { "aria-label": "New field source", id: "new-field-source" });
	for (const [v, l] of sources) src.append(h("option", { value: v }, l));
	box.append(
		h("h3", { class: "panel-h" }, "Add a field"),
		label,
		src,
		h("button", {
			type: "button",
			class: "btn",
			id: "btn-add-field",
			onclick: () => {
				const text = label.value.trim();
				if (!text) return label.focus();
				mutate((dd) => dd.fields.push({ key: slug(text, new Set(dd.fields.map((f) => f.key))), label: text, source: src.value || null, type: "text" }), state.sel);
			},
		}, "Add field"),
	);
	box.append(h("h3", { class: "panel-h" }, "Sample church data (Preview)"));
	for (const [path, label2] of [["church.name", "Church name"], ["church.tagline", "Tagline"], ["pastor.name", "Pastor"], ["meeting.date", "Meeting date"], ["meeting.number", "Meeting number"]]) {
		const [a, b] = path.split(".");
		box.append(field(label2, h("input", { type: "text", value: SAMPLE[a][b], onchange: (e) => ((SAMPLE[a][b] = e.target.value), render()) })));
	}
	return box;
}
function jsonPanel() {
	const d = doc();
	const result = F.validate(d);
	const text = JSON.stringify(d, null, 2);
	return h("div", { class: "panel-stack" },
		h("div", { class: `check-line ${result.ok ? "ok" : "bad"}`, id: "json-status" }, result.ok ? "PASS · this serialized document passes the format check" : `FAIL · ${result.errors.length} problem(s)`),
		result.ok ? null : h("ul", { class: "errors" }, ...result.errors.map((e) => h("li", {}, e))),
		h("div", { class: "btn-row" },
			h("button", { type: "button", class: "btn", onclick: () => navigator.clipboard?.writeText(text) }, "Copy JSON"),
			h("button", { type: "button", class: "btn", onclick: () => download(`${d.id}.json`, text) }, "Download .json"),
		),
		h("pre", { class: "json", id: "json-out" }, text),
	);
}
function download(name, text) {
	const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function runChecks() {
	const rows = [];
	for (const id of EXAMPLES) {
		const json = await (await fetch(`../examples/${id}.json`)).json();
		rows.push({ name: `examples/${id}.json (file)`, expect: "pass", result: F.validate(json) });
	}
	const broken = await (await fetch("../tests/broken/budget-worksheet-broken.json")).json();
	rows.push({ name: "tests/broken/budget-worksheet-broken.json (file)", expect: "fail", result: F.validate(broken) });
	for (const e of state.entries.values()) rows.push({ name: `${e.collection === "template" ? "Template" : "Document"} in editor: ${e.doc.meta.title} (${e.doc.id})`, expect: "pass", result: F.validate(e.doc) });
	state.checkReport = rows;
	renderPanel();
}
function checkPanel() {
	const box = h("div", { class: "panel-stack" });
	box.append(h("p", { class: "muted small" }, "The same validate() that check.mjs runs in Node. The example files must pass, and the broken copy must fail."));
	box.append(h("button", { type: "button", class: "btn", id: "btn-run-checks", onclick: runChecks }, "Run the check"));
	if (!state.checkReport) {
		runChecks();
		return box;
	}
	const list = h("ul", { class: "check-list", id: "check-list" });
	for (const r of state.checkReport) {
		const got = r.result.ok ? "pass" : "fail";
		list.append(
			h("li", { class: got === r.expect ? "as-expected" : "unexpected" },
				h("span", { class: `badge ${got}` }, got.toUpperCase()),
				h("span", {}, r.name, r.expect === "fail" ? " · expected to fail" : ""),
				r.result.ok ? null : h("ul", { class: "errors" }, ...r.result.errors.slice(0, 6).map((e) => h("li", {}, e))),
			),
		);
	}
	box.append(list);
	return box;
}

// ------------------------------------------------------------------------------------------------ mutations

function pushUndo() {
	state.undo.push({ json: JSON.stringify(doc()), sel: state.sel });
	if (state.undo.length > 200) state.undo.shift();
	state.redo = [];
}
function mutate(fn, nextSel, focus) {
	pushUndo();
	const result = fn(doc());
	if (nextSel !== undefined) state.sel = nextSel;
	if (state.sel && getAt(doc(), state.sel) === undefined) state.sel = null;
	state.lastTyped = 0;
	render();
	if (focus) focusPath(focus.path, focus.at);
	return result;
}
function restore(from, to) {
	const snap = from.pop();
	if (!snap) return;
	to.push({ json: JSON.stringify(doc()), sel: state.sel });
	state.entries.get(state.current).doc = JSON.parse(snap.json);
	state.sel = snap.sel && getAt(doc(), snap.sel) !== undefined ? snap.sel : null;
	render();
	if (state.sel) focusPath(state.sel, "end");
}
const undo = () => restore(state.undo, state.redo);
const redo = () => restore(state.redo, state.undo);

function focusPath(path, at = "end") {
	const el = sheetHost().querySelector(`[data-path="${keyOf(path)}"]`);
	if (!el) return;
	const target = el.dataset.leaf ? el : el.querySelector("[data-leaf][contenteditable='true']");
	if (target?.isContentEditable) {
		target.focus();
		const len = contentLen(parseInline(target));
		placeCaret(target, at === "end" ? len : Math.min(at, len));
		state.sel = pathOf(target);
	} else {
		state.sel = path;
		el.classList.add("is-selected");
		el.focus({ preventScroll: true });
	}
	refreshChrome();
}
function selectPath(path) {
	state.sel = path;
	sheetHost().querySelectorAll(".is-selected").forEach((e) => e.classList.remove("is-selected"));
	const el = sheetHost().querySelector(`[data-path="${keyOf(path)}"]`);
	if (el && !el.isContentEditable) el.classList.add("is-selected");
	refreshChrome();
}

/** Climb from a node to the block whose parent array is a block container (body, slot, box, column, repeat). */
function blockLevel(d, path, opts = {}) {
	let p = path;
	while (p.length > 2) {
		const owner = getAt(d, p.slice(0, -2));
		if (CONTAINERS.has(owner?.type) && !(opts.topLevel || (opts.leaveRepeat && insideRepeat(d, p)))) break;
		if (opts.listItem && owner?.type === "list") break;
		p = p.slice(0, -2);
	}
	return p;
}
function insideRepeat(d, path) {
	for (let i = 2; i < path.length; i += 2) if (getAt(d, path.slice(0, i))?.type === "repeat") return true;
	return false;
}
const P = (content = []) => ({ type: "paragraph", content });
function newNode(kind, d) {
	switch (kind) {
		case "paragraph":
			return P();
		case "title":
			return { type: "heading", attrs: { level: 0 }, content: [] };
		case "heading":
			return { type: "heading", attrs: { level: 1 }, content: [] };
		case "ul":
			return { type: "list", content: [{ type: "listItem", content: [P()] }] };
		case "ol":
			return { type: "list", attrs: { ordered: true }, content: [{ type: "listItem", content: [P()] }] };
		case "quote":
			return { type: "quote", content: [P()] };
		case "divider":
			return { type: "divider" };
		case "pageBreak":
			return { type: "pageBreak" };
		case "slot": {
			const ids = new Set();
			const walk = (nodes) => (nodes ?? []).forEach((n) => (n.type === "slot" && ids.add(n.attrs.id), Array.isArray(n.content) && walk(n.content)));
			walk(d.body);
			let n = 1;
			while (ids.has(`section-${n}`)) n += 1;
			return { type: "slot", attrs: { id: `section-${n}`, label: "Fill-in section" }, content: [] };
		}
		case "box":
			return { type: "box", attrs: { fill: "muted" }, content: [P()] };
		case "columns":
			return { type: "columns", content: [{ type: "column", content: [P()] }, { type: "column", content: [P()] }] };
		case "table":
			return {
				type: "table",
				attrs: { columns: [1, 2, 3].map((i) => ({ key: `col_${i}`, width: 1 })) },
				content: [
					{ type: "row", content: [1, 2, 3].map((i) => ({ type: "cell", content: [{ type: "text", text: `Column ${i}` }] })) },
					...[1, 2].map(() => ({ type: "row", content: [1, 2, 3].map(() => ({ type: "cell", content: [] })) })),
				],
			};
		case "repeat":
			return { type: "repeat", content: [P()] };
		case "logo":
			return { type: "logo" };
	}
	throw new Error(kind);
}
function insertBlock(kind) {
	const d = doc();
	const node = newNode(kind, d);
	let arrPath;
	let index;
	if (!state.sel || state.sel[0] !== "body") {
		arrPath = ["body"];
		index = d.body.length;
	} else {
		const at = blockLevel(d, state.sel, { topLevel: kind === "pageBreak", leaveRepeat: kind === "repeat" });
		arrPath = at.slice(0, -1);
		index = at.at(-1) + 1;
	}
	const path = [...arrPath, index];
	mutate((dd) => getAt(dd, arrPath).splice(index, 0, node), path, { path, at: 0 });
}
function addInto(arrKey) {
	const arrPath = arrKey.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
	const path = [...arrPath, 0];
	mutate((dd) => getAt(dd, arrPath).splice(0, 0, P()), path, { path, at: 0 });
}
function leafEditablesInOrder() {
	return [...sheetHost().querySelectorAll("[data-leaf='inline'][contenteditable='true']")];
}
function removeAt(d, path) {
	const arr = getAt(d, path.slice(0, -1));
	arr.splice(path.at(-1), 1);
	// An emptied list goes too.
	const ownerPath = path.slice(0, -2);
	const owner = ownerPath.length ? getAt(d, ownerPath) : null;
	if (owner?.type === "list" && owner.content.length === 0) removeAt(d, ownerPath);
	if (owner?.type === "listItem" && owner.content.length === 0) removeAt(d, ownerPath);
	if (owner?.type === "quote" && owner.content.length === 0) removeAt(d, ownerPath);
}
function deleteBlock() {
	const d = doc();
	if (!state.sel || state.sel[0] !== "body") return;
	const at = blockLevel(d, state.sel, { listItem: true });
	const leaves = leafEditablesInOrder();
	const first = sheetHost().querySelector(`[data-path="${keyOf(at)}"]`);
	const before = leaves.filter((l) => first && l.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING && !first.contains(l)).length;
	mutate((dd) => removeAt(dd, at), null);
	const after = leafEditablesInOrder();
	const target = after[Math.max(0, before - 1)];
	if (target) focusPath(pathOf(target), "end");
}
function moveBlock(dir) {
	const d = doc();
	if (!state.sel || state.sel[0] !== "body") return;
	const at = blockLevel(d, state.sel, { listItem: true });
	const arr = getAt(d, at.slice(0, -1));
	const i = at.at(-1);
	const j = i + dir;
	if (j < 0 || j >= arr.length) return;
	const rest = state.sel.slice(at.length);
	const next = [...at.slice(0, -1), j, ...rest];
	mutate((dd) => {
		const a = getAt(dd, at.slice(0, -1));
		[a[i], a[j]] = [a[j], a[i]];
	}, next, { path: next, at: "end" });
}
/** Take a paragraph out of its list item or quote, splitting the list or quote around it. Returns its new path. */
function liftOut(d, path) {
	const ownerPath = path.slice(0, -2);
	const owner = ownerPath.length >= 2 ? getAt(d, ownerPath) : null;
	if (owner?.type === "listItem") {
		const itemIdx = ownerPath.at(-1);
		const listPath = ownerPath.slice(0, -2);
		const list = getAt(d, listPath);
		const item = list.content[itemIdx];
		const j = path.at(-1);
		const para = item.content[j];
		// The item keeps what came before the paragraph; what came after it (nested lists) follows the paragraph.
		const keep = item.content.slice(0, j);
		const rest = item.content.slice(j + 1);
		const before = [...list.content.slice(0, itemIdx), ...(keep.length ? [{ ...item, content: keep }] : [])];
		const after = list.content.slice(itemIdx + 1);
		const mk = (items) => ({ type: "list", ...(list.attrs ? { attrs: clone(list.attrs) } : {}), content: items });
		const arrPath = listPath.slice(0, -1);
		const arr = getAt(d, arrPath);
		arr.splice(listPath.at(-1), 1, ...(before.length ? [mk(before)] : []), para, ...rest, ...(after.length ? [mk(after)] : []));
		const result = [...arrPath, listPath.at(-1) + (before.length ? 1 : 0)];
		const holder = arrPath.length >= 2 ? getAt(d, arrPath.slice(0, -1)) : null;
		return holder?.type === "listItem" ? liftOut(d, result) : result;
	}
	if (owner?.type === "quote") {
		const i = path.at(-1);
		const quotePath = ownerPath;
		const quote = owner;
		const before = quote.content.slice(0, i);
		const after = quote.content.slice(i + 1);
		const arr = getAt(d, quotePath.slice(0, -1));
		arr.splice(quotePath.at(-1), 1, ...(before.length ? [{ type: "quote", content: before }] : []), quote.content[i], ...(after.length ? [{ type: "quote", content: after }] : []));
		return [...quotePath.slice(0, -1), quotePath.at(-1) + (before.length ? 1 : 0)];
	}
	return path;
}
function setBlockType(target) {
	const d = doc();
	const sel = state.sel;
	const node = sel ? getAt(d, sel) : null;
	if (!node || !TEXT_BLOCKS.has(node.type) || sel[0] !== "body") return;
	const owner = getAt(d, sel.slice(0, -2));
	if (owner?.type === "listItem" && (target === "ul" || target === "ol")) {
		const listPath = sel.slice(0, -4);
		return mutate((dd) => {
			const list = getAt(dd, listPath);
			if (target === "ol") list.attrs = { ...(list.attrs ?? {}), ordered: true };
			else if (list.attrs) delete list.attrs.ordered;
			if (list.attrs && !Object.keys(list.attrs).length) delete list.attrs;
		}, sel, { path: sel, at: "end" });
	}
	let next = sel;
	mutate((dd) => {
		const p = liftOut(dd, sel);
		const arr = getAt(dd, p.slice(0, -1));
		const i = p.at(-1);
		const content = arr[i].content ?? [];
		next = p;
		if (target === "paragraph") arr[i] = { type: "paragraph", ...(arr[i].type === "paragraph" && arr[i].attrs ? { attrs: arr[i].attrs } : {}), content };
		else if (target.startsWith("h")) arr[i] = { type: "heading", attrs: { level: Number(target.slice(1)) }, content };
		else if (target === "ul" || target === "ol") {
			arr[i] = { type: "list", ...(target === "ol" ? { attrs: { ordered: true } } : {}), content: [{ type: "listItem", content: [P(content)] }] };
			next = [...p, "content", 0, "content", 0];
		} else if (target === "quote") {
			arr[i] = { type: "quote", content: [P(content)] };
			next = [...p, "content", 0];
		}
	}, null);
	state.sel = next;
	focusPath(next, "end");
}
function splitBlock(leafEl) {
	const d = doc();
	const path = pathOf(leafEl);
	if (path[0] !== "body") return;
	const node = getAt(d, path);
	if (!TEXT_BLOCKS.has(node.type)) return;
	const total = contentLen(node.content ?? []);
	const [s, e] = caretOffsets(leafEl) ?? [total, total];
	const before = sliceContent(node.content ?? [], 0, s);
	const after = sliceContent(node.content ?? [], e, total);
	const owner = getAt(d, path.slice(0, -2));
	if (owner?.type === "listItem") {
		const itemPath = path.slice(0, -2);
		const listPath = itemPath.slice(0, -2);
		const k = itemPath.at(-1);
		if (!before.length && !after.length) {
			let next;
			mutate((dd) => (next = liftOut(dd, path)), null);
			return focusPath(next, 0);
		}
		const next = [...listPath, "content", k + 1, "content", 0];
		return mutate((dd) => {
			getAt(dd, path).content = before;
			getAt(dd, listPath).content.splice(k + 1, 0, { type: "listItem", content: [P(after)] });
		}, next, { path: next, at: 0 });
	}
	const arrPath = path.slice(0, -1);
	const i = path.at(-1);
	const next = [...arrPath, i + 1];
	mutate((dd) => {
		const n = getAt(dd, path);
		n.content = before;
		const fresh = n.type === "heading" ? P(after) : { type: "paragraph", ...(n.attrs ? { attrs: clone(n.attrs) } : {}), content: after };
		getAt(dd, arrPath).splice(i + 1, 0, fresh);
	}, next, { path: next, at: 0 });
}
function joinBackward(leafEl) {
	const d = doc();
	const path = pathOf(leafEl);
	if (path[0] !== "body") return false;
	const node = getAt(d, path);
	if (!TEXT_BLOCKS.has(node.type)) return false;
	const empty = !(node.content ?? []).length;
	const owner = getAt(d, path.slice(0, -2));
	const i = path.at(-1);
	const arr = getAt(d, path.slice(0, -1));
	const prev = i > 0 ? arr[i - 1] : null;
	if (!empty && prev && TEXT_BLOCKS.has(prev.type) && owner?.type !== "listItem") {
		const at = contentLen(prev.content ?? []);
		const prevPath = [...path.slice(0, -1), i - 1];
		mutate((dd) => {
			const a = getAt(dd, path.slice(0, -1));
			a[i - 1].content = normalize([...(a[i - 1].content ?? []), ...(a[i].content ?? [])]);
			a.splice(i, 1);
		}, prevPath, { path: prevPath, at });
		return true;
	}
	if (!empty) return false;
	if (owner?.type === "listItem") {
		const itemPath = path.slice(0, -2);
		if (itemPath.at(-1) === 0 && getAt(d, itemPath.slice(0, -1)).length > 1) {
			let next;
			mutate((dd) => (next = liftOut(dd, path)), null);
			focusPath(next, 0);
			return true;
		}
	}
	const leaves = leafEditablesInOrder();
	const idx = leaves.indexOf(leafEl);
	if (idx <= 0 && d.body.length === 1 && path.length === 2) return false;
	state.sel = path;
	deleteBlock();
	return true;
}
function indentItem(outdent) {
	const d = doc();
	const sel = state.sel;
	const owner = sel ? getAt(d, sel.slice(0, -2)) : null;
	if (owner?.type !== "listItem") return false;
	const itemPath = sel.slice(0, -2);
	const listPath = itemPath.slice(0, -2);
	const k = itemPath.at(-1);
	if (!outdent) {
		if (k === 0) return true;
		let next;
		mutate((dd) => {
			const list = getAt(dd, listPath);
			const prev = list.content[k - 1];
			const [item] = list.content.splice(k, 1);
			let sub = prev.content.at(-1);
			if (sub?.type !== "list") {
				sub = { type: "list", ...(list.attrs ? { attrs: clone(list.attrs) } : {}), content: [] };
				prev.content.push(sub);
			}
			sub.content.push(item);
			next = [...listPath, "content", k - 1, "content", prev.content.length - 1, "content", sub.content.length - 1, "content", 0];
		}, null);
		focusPath(next, "end");
		return true;
	}
	const holder = listPath.length >= 4 ? getAt(d, listPath.slice(0, -2)) : null;
	if (holder?.type !== "listItem") return true;
	const parentListPath = listPath.slice(0, -4);
	const ownerIdx = listPath.at(-3);
	const next = [...parentListPath, "content", ownerIdx + 1, "content", 0];
	mutate((dd) => {
		const sub = getAt(dd, listPath);
		const [item] = sub.content.splice(k, 1);
		const holderItem = getAt(dd, listPath.slice(0, -2));
		if (!sub.content.length) holderItem.content.splice(listPath.at(-1), 1);
		getAt(dd, parentListPath).content.splice(ownerIdx + 1, 0, item);
	}, next, { path: next, at: "end" });
	return true;
}

// Inline operations on the focused leaf. They change the model, then re-render the leaf and restore the selection.
function activeLeaf() {
	const el = document.activeElement;
	if (el?.dataset?.leaf === "inline" && el.isContentEditable) return el;
	if (state.savedRange) {
		const host = sheetHost().querySelector(`[data-path="${state.savedRange.path}"]`);
		if (host?.isContentEditable) return host;
	}
	return null;
}
function leafContent(path) {
	return path[0] === "page" ? doc().page.footer : (getAt(doc(), path).content ?? []);
}
function setLeafContent(d, path, content) {
	if (path[0] === "page") d.page.footer = content;
	else getAt(d, path).content = content;
}
function rewriteLeaf(fn) {
	const el = activeLeaf();
	if (!el) return;
	const path = pathOf(el);
	const offs = document.activeElement === el ? caretOffsets(el) : state.savedRange?.offsets;
	if (!offs) return;
	const [s, e] = offs;
	const { content, caret } = fn(leafContent(path), s, e);
	mutate((d) => setLeafContent(d, path, content), path);
	const fresh = sheetHost().querySelector(`[data-path="${keyOf(path)}"]`);
	if (fresh) {
		fresh.focus();
		placeCaret(fresh, ...(caret ?? [s, e]));
	}
}
function applyMark(type, attrs, mode = "toggle") {
	rewriteLeaf((content, s, e) => (s === e ? { content } : { content: setMark(content, s, e, type, attrs, mode) }));
}
function clearMarks() {
	rewriteLeaf((content, s, e) => {
		let out = content;
		for (const t of Object.keys(F.MARKS)) out = setMark(out, s, e, t, undefined, "remove");
		return { content: out };
	});
}
function insertInline(node) {
	rewriteLeaf((content, s, e) => ({
		content: normalize([...sliceContent(content, 0, s), node, ...sliceContent(content, e, contentLen(content))]),
		caret: [s + 1, s + 1],
	}));
}
function uniqueCheckKey() {
	const keys = new Set();
	const walk = (nodes) => (nodes ?? []).forEach((n) => (n.type === "checkbox" && n.attrs?.key && keys.add(n.attrs.key), Array.isArray(n.content) && walk(n.content)));
	walk(doc().body);
	let i = 1;
	while (keys.has(`check_${i}`)) i += 1;
	return `check_${i}`;
}

// Table operations on the cell that holds the selection.
function cellPathOf(path) {
	for (let i = path.length; i >= 2; i -= 2) if (getAt(doc(), path.slice(0, i))?.type === "cell") return path.slice(0, i);
	return null;
}
function tableOp(op) {
	const d = doc();
	const cp = cellPathOf(state.sel ?? []);
	if (!cp) return;
	const tablePath = cp.slice(0, -4);
	const r = cp.at(-3);
	const c = cp.at(-1);
	const table = getAt(d, tablePath);
	const logical = table.content[r].content.slice(0, c).reduce((s, x) => s + (x.attrs?.colspan ?? 1), 0);
	const cellAtCol = (row, col) => {
		let pos = 0;
		for (let i = 0; i < row.content.length; i += 1) {
			const span = row.content[i].attrs?.colspan ?? 1;
			if (col < pos + span) return i;
			pos += span;
		}
		return row.content.length - 1;
	};
	const blankLike = (cell) => {
		const ca = cell.attrs ?? {};
		const attrs = {};
		for (const k of ["kind", "format", "fill", "align", "colspan", "formula"]) if (ca[k] !== undefined) attrs[k] = ca[k];
		if (ca.kind === "number") attrs.value = null;
		return { type: "cell", ...(Object.keys(attrs).length ? { attrs } : {}), content: [] };
	};
	let next = cp;
	mutate((dd) => {
		const t = getAt(dd, tablePath);
		const ta = F.attrsOf(t);
		if (op === "row+") {
			const at = r < ta.headerRows ? ta.headerRows : r + 1;
			const model = r < ta.headerRows ? { content: t.content[r].content.map(() => ({ type: "cell" })) } : t.content[r];
			t.content.splice(at, 0, { type: "row", content: model.content.map(blankLike) });
			next = [...tablePath, "content", at, "content", Math.min(c, t.content[at].content.length - 1)];
		} else if (op === "row-") {
			if (t.content.length - ta.headerRows <= 1 && r >= ta.headerRows) return;
			if (t.content.length <= 1) return;
			t.content.splice(r, 1);
			if (r < ta.headerRows) t.attrs.headerRows = ta.headerRows - 1;
			const nr = Math.min(r, t.content.length - 1);
			next = [...tablePath, "content", nr, "content", Math.min(c, t.content[nr].content.length - 1)];
		} else if (op === "col+") {
			const keys = new Set(ta.columns.map((x) => x.key));
			let n = ta.columns.length + 1;
			while (keys.has(`col_${n}`)) n += 1;
			const widths = ta.columns.map((x) => x.width);
			t.attrs.columns.splice(logical + 1, 0, { key: `col_${n}`, width: Math.max(1, Math.round(widths.reduce((s, w) => s + w, 0) / widths.length)) });
			t.content.forEach((row, ri) => {
				const i = cellAtCol(row, logical);
				row.content.splice(i + 1, 0, ri < ta.headerRows ? { type: "cell", content: [{ type: "text", text: "New column" }] } : { type: "cell", content: [] });
			});
			next = [...tablePath, "content", r, "content", c + 1];
		} else if (op === "col-") {
			if (ta.columns.length <= 1) return;
			t.attrs.columns.splice(logical, 1);
			t.content.forEach((row) => {
				const i = cellAtCol(row, logical);
				const cell = row.content[i];
				if ((cell.attrs?.colspan ?? 1) > 1) cell.attrs.colspan -= 1;
				else row.content.splice(i, 1);
			});
			next = [...tablePath, "content", r, "content", Math.max(0, Math.min(c, t.content[r].content.length - 1))];
		} else if (op === "head+" || op === "head-") {
			const nextRows = Math.max(0, Math.min(t.content.length - 1, ta.headerRows + (op === "head+" ? 1 : -1)));
			t.attrs.headerRows = nextRows;
			t.content.slice(0, nextRows).forEach((row) => row.content.forEach((cell) => {
				if (cell.attrs) for (const k of ["kind", "value", "formula", "name"]) delete cell.attrs[k];
			}));
		}
	}, null);
	state.sel = next;
	focusPath(next, "end");
}

// ------------------------------------------------------------------------------------------------ document lifecycle

function addEntry(d, collection) {
	state.entries.set(d.id, { doc: d, collection, pristine: JSON.stringify(d) });
}
function open(id) {
	if (!state.entries.has(id)) return;
	state.current = id;
	state.sel = null;
	state.undo = [];
	state.redo = [];
	state.checkReport = null;
	if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
	render();
	$("#canvas").scrollTop = 0;
}
function nextDocId() {
	state.seq += 1;
	return `doc-${state.seq}`;
}
function forkCurrent() {
	const entry = state.entries.get(state.current);
	if (entry.collection !== "template") return;
	const copy = F.fork(entry.doc, nextDocId());
	addEntry(copy, "document");
	open(copy.id);
	toast(`Made a copy of "${entry.doc.meta.title}". Edits change only the copy.`);
}
function newBlank() {
	const d = {
		format: F.FORMAT,
		formatVersion: F.FORMAT_VERSION,
		kind: "document",
		id: nextDocId(),
		version: 1,
		origin: null,
		meta: { title: "Untitled document", class: "operational" },
		page: { size: "letter", orientation: "portrait", margins: { top: 40, right: 40, bottom: 40, left: 40 } },
		theme: { numberHeadings: false },
		fields: [
			{ key: "church_name", label: "Church name", source: "church.name", type: "text" },
			{ key: "pastor_name", label: "Pastor name", source: "pastor.name", type: "text" },
		],
		body: [],
	};
	addEntry(d, "document");
	open(d.id);
}
function wipeCurrent() {
	mutate((d) => {
		const w = F.wipe(d);
		d.body = w.body;
		if (w.page.footer) d.page.footer = w.page.footer;
	}, null);
	toast("Deleted all content. Undo brings it back.");
}
function setMode(mode) {
	state.mode = mode;
	state.sel = null;
	render();
}
let toastTimer = 0;
function toast(text) {
	const t = $("#toast");
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ------------------------------------------------------------------------------------------------ events

let liveTimer = 0;
function scheduleLive() {
	clearTimeout(liveTimer);
	liveTimer = setTimeout(() => {
		renderDocBar();
		if (state.tab === "json" || state.tab === "inspect") renderPanel();
	}, 200);
}
function onInput(e) {
	const el = e.target.closest?.("[data-leaf]");
	if (!el || !el.dataset.path) return;
	const now = Date.now();
	if (now - state.lastTyped > 1000) pushUndo();
	state.lastTyped = now;
	const path = pathOf(el);
	const d = doc();
	if (el.dataset.leaf === "number") {
		const raw = el.textContent.replace(/[$,\s]/g, "");
		const value = raw === "" ? null : Number(raw);
		el.classList.toggle("is-invalid", raw !== "" && !Number.isFinite(value));
		if (raw === "" || Number.isFinite(value)) getAt(d, path).attrs.value = value;
	} else {
		setLeafContent(d, path, parseInline(el));
		el.classList.toggle("is-empty", !el.textContent && !el.querySelector("[data-atom]"));
	}
	const results = F.evaluate(d);
	sheetHost().querySelectorAll("[data-leaf='formula']").forEach((f) => {
		const res = results.get(dollar(pathOf(f)));
		f.textContent = res?.error ? "#ERROR" : F.formatNumber(res?.value ?? 0, f.dataset.format);
		f.classList.toggle("is-error", !!res?.error);
	});
	refreshMirrors(el);
	requestAnimationFrame(markOverflow);
	scheduleLive();
	$("#btn-undo").disabled = false;
}
function onKeydown(e) {
	const el = e.target.closest?.("[data-leaf]");
	const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
	if (mod && e.key.toLowerCase() === "z") {
		e.preventDefault();
		return e.shiftKey ? redo() : undo();
	}
	if (!el) return;
	if (el.dataset.leaf === "number") {
		if (e.key === "Enter") {
			e.preventDefault();
			el.blur();
		}
		return;
	}
	if (el.dataset.leaf !== "inline" || !el.isContentEditable) return;
	if (mod) {
		const mark = { b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()];
		if (mark) {
			e.preventDefault();
			applyMark(mark);
		}
		return;
	}
	if (e.key === "Enter" && e.shiftKey) {
		e.preventDefault();
		insertInline({ type: "hardBreak" });
	} else if (e.key === "Enter") {
		e.preventDefault();
		splitBlock(el);
	} else if (e.key === "Backspace") {
		const off = caretOffsets(el);
		if (off && off[0] === 0 && off[1] === 0 && joinBackward(el)) e.preventDefault();
	} else if (e.key === "Tab") {
		if (indentItem(e.shiftKey)) e.preventDefault();
	}
}
function onFocusIn(e) {
	const el = e.target.closest?.("[data-path]");
	if (!el || !sheetHost().contains(el)) return;
	sheetHost().querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected"));
	state.sel = pathOf(el);
	if (el.dataset.leaf === "number") {
		const v = getAt(doc(), state.sel).attrs?.value;
		el.textContent = v === null || v === undefined ? "" : String(v);
	}
	if (!el.isContentEditable) el.classList.add("is-selected");
	refreshChrome();
}
function onFocusOut(e) {
	const el = e.target.closest?.("[data-leaf='number']");
	if (!el || !el.dataset.path) return;
	const cell = getAt(doc(), pathOf(el));
	if (cell) el.textContent = F.formatNumber(cell.attrs?.value, el.dataset.format);
	el.classList.remove("is-invalid");
}
function onSheetClick(e) {
	if (state.mode !== "edit") return;
	const add = e.target.closest("[data-add]");
	if (add) return addInto(add.dataset.add);
	const atom = e.target.closest("[data-atom]");
	const leafEl = e.target.closest("[data-leaf='inline']");
	if (atom && leafEl?.dataset.path) {
		const path = pathOf(leafEl);
		const off = offsetIn(leafEl, atom.parentNode, [...atom.parentNode.childNodes].indexOf(atom));
		let pos = 0;
		let found = -1;
		leafContent(path).forEach((n, i) => {
			if (found < 0 && pos === off && n.type !== "text") found = i;
			pos += unitLen(n);
		});
		if (found >= 0 && path[0] === "body") {
			state.tab = "inspect";
			selectPath([...path, "content", found]);
		}
		return;
	}
	const target = e.target.closest("[data-path]");
	if (!target || target.isContentEditable || target.dataset.leaf === "formula") return;
	selectPath(pathOf(target));
}
function saveRange() {
	const sel = getSelection();
	if (!sel.rangeCount) return;
	const el = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.("[data-leaf='inline']");
	if (!el || !el.isContentEditable || !el.dataset.path) return;
	const offsets = caretOffsets(el);
	if (offsets) state.savedRange = { path: el.dataset.path, offsets };
}

function bind() {
	const sheet = sheetHost();
	sheet.addEventListener("input", onInput);
	sheet.addEventListener("keydown", onKeydown);
	document.addEventListener("keydown", (e) => {
		if (!sheet.contains(e.target) && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
			e.preventDefault();
			e.shiftKey ? redo() : undo();
		}
	});
	sheet.addEventListener("focusin", onFocusIn);
	sheet.addEventListener("focusout", onFocusOut);
	sheet.addEventListener("click", onSheetClick);
	sheet.addEventListener("paste", (e) => {
		if (!e.target.closest?.("[data-leaf]")) return;
		e.preventDefault();
		document.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") ?? "").replace(/\s*\n\s*/g, " "));
	});
	document.addEventListener("selectionchange", saveRange);
	// Toolbar buttons keep the text selection: they act on mousedown's saved range.
	document.querySelectorAll(".toolbar button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
	const on = (id, fn) => $(id).addEventListener("click", fn);
	on("#btn-undo", undo);
	on("#btn-redo", redo);
	document.querySelectorAll("[data-mark]").forEach((b) => b.addEventListener("click", () => applyMark(b.dataset.mark)));
	on("#btn-link", () => {
		const href = prompt("Link address (https://, mailto: or tel:)", "https://");
		if (!href) return;
		if (!/^(https?:\/\/|mailto:|tel:)/.test(href)) return toast("A link starts with https://, mailto: or tel:.");
		applyMark("link", { href }, "add");
	});
	on("#btn-caps", () => applyMark("caps"));
	on("#btn-clear", clearMarks);
	$("#sel-tone").addEventListener("change", (e) => {
		const tone = e.target.value;
		e.target.value = "";
		if (tone === "none") applyMark("tone", undefined, "remove");
		else if (tone) applyMark("tone", { tone }, "add");
	});
	$("#sel-type").addEventListener("change", (e) => e.target.value && setBlockType(e.target.value));
	$("#sel-insert").addEventListener("change", (e) => {
		const kind = e.target.value;
		e.target.value = "";
		if (kind) insertBlock(kind);
	});
	$("#sel-field").addEventListener("change", (e) => {
		const key = e.target.value;
		e.target.value = "";
		if (key) insertInline({ type: "field", attrs: { key } });
	});
	on("#btn-check", () => insertInline({ type: "checkbox", attrs: { key: uniqueCheckKey() } }));
	on("#btn-up", () => moveBlock(-1));
	on("#btn-down", () => moveBlock(1));
	on("#btn-delete", deleteBlock);
	document.querySelectorAll("[data-table]").forEach((b) => b.addEventListener("click", () => tableOp(b.dataset.table)));
	document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
	on("#btn-brand", () => {
		state.brand = !state.brand;
		render();
	});
	on("#btn-print", () => window.print());
	on("#btn-fork", forkCurrent);
	on("#btn-wipe", wipeCurrent);
	on("#btn-new", newBlank);
	document.querySelectorAll("[data-tab]").forEach((b) =>
		b.addEventListener("click", () => {
			state.tab = b.dataset.tab;
			renderPanel();
		}),
	);
	$("#library").addEventListener("click", (e) => {
		const b = e.target.closest("[data-open]");
		if (b) open(b.dataset.open);
	});
	$("#lib-select").addEventListener("change", (e) => open(e.target.value));
	let restoreMode = null;
	addEventListener("beforeprint", () => {
		if (restoreMode === null) restoreMode = state.mode;
		if (state.mode !== "preview") {
			state.mode = "preview";
			renderSheet();
		}
		$("#sheet-wrap").style.zoom = "1";
	});
	addEventListener("afterprint", () => {
		if (restoreMode !== null) state.mode = restoreMode;
		restoreMode = null;
		render();
	});
	addEventListener("resize", fit);
	addEventListener("hashchange", () => open(location.hash.slice(1)));
}

async function boot() {
	for (const id of EXAMPLES) addEntry(await (await fetch(`../examples/${id}.json`)).json(), "template");
	bind();
	open(state.entries.has(location.hash.slice(1)) ? location.hash.slice(1) : EXAMPLES[0]);
	window.efd = { state, doc, F, open, setMode }; // for scripted checks and the curious reviewer
}
boot();
