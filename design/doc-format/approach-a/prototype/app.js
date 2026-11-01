// Everyfield documents, approach A prototype. No library and no build step: the document JSON is the only state, the
// page view is drawn from it, and each edit writes back into it. format.js (shared with the Node validator) validates
// it, computes ledger totals and forks templates.
import { blankDocument, computeTable, forkTemplate, pageBox, tileBox, validate } from "../format.js";

const EXAMPLES = [
	{ stem: "conflict-of-interest-policy", label: "Policy: Conflict of Interest Policy" },
	{ stem: "commitment-card-sheet", label: "Cards: Commitment card, 4 per sheet" },
	{ stem: "guest-sign-in-sheet", label: "Sign-in: Guest sign-in sheet" },
	{ stem: "budget-worksheet", label: "Budget: Budget worksheet" },
];
const SAVED_PREFIX = "everyfield-approach-a:";
const TOKEN_VAR = {
	none: "transparent",
	ink: "var(--ink)",
	"muted-text": "var(--muted-text)",
	primary: "var(--primary)",
	accent: "var(--accent)",
	muted: "var(--muted)",
	border: "var(--border)",
};
const ON_FILL = { primary: "on-primary", ink: "on-primary", accent: "on-accent" };
const TYPE_LABEL = {
	paragraph: "Paragraph",
	heading: "Heading",
	bulletList: "Bulleted list",
	orderedList: "Numbered list",
	quote: "Quote",
	divider: "Divider",
	spacer: "Space",
	pageBreak: "Page break",
	columns: "Columns",
	box: "Box",
	image: "Image slot",
	writeIn: "Write-in field",
	slot: "Doctrinal slot",
	table: "Table",
};
const ATTR_LABEL = {
	align: "Alignment",
	style: "Style",
	level: "Level",
	numbered: "Numbered",
	weight: "Weight",
	color: "Color",
	size: "Size (pt)",
	gap: "Gap (pt)",
	valign: "Vertical align",
	width: "Width (pt, 0 = fill)",
	fill: "Fill",
	border: "Border",
	padding: "Padding (pt)",
	keepTogether: "Keep on one page",
	source: "Source",
	height: "Height (pt)",
	alt: "Alt text",
	label: "Label",
	key: "Key",
	kind: "Kind",
	header: "Header row",
	headerFill: "Header fill",
	zebra: "Striped rows",
	writeInRows: "Write-in rows",
	rowHeight: "Row height (pt)",
	sheet: "XLSX sheet name",
};

const $ = (s, root = document) => root.querySelector(s);
const h = (tag, props = {}, ...children) => {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "style") Object.assign(el.style, v);
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "dataset") Object.assign(el.dataset, v);
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
	return el;
};
const pt = (n) => `${n}pt`;

const state = {
	schema: null,
	templates: {},
	doc: null,
	mode: "edit",
	brand: "neutral",
	tab: "block",
	sel: null,
	selRow: null,
	insertInto: null,
	lastRange: null,
	lastEditable: null,
	lastCaret: null,
	pendingFocus: null,
};

// ------------------------------------------------------------------ node bookkeeping

let parents = new WeakMap(); // node -> { list, owner }
const ids = new WeakMap();
const byId = new Map();
let nextId = 1;
const idOf = (node) => {
	if (!ids.has(node)) ids.set(node, String(nextId++));
	const id = ids.get(node);
	byId.set(id, node);
	return id;
};
function indexDoc() {
	parents = new WeakMap();
	const walk = (list, owner) => {
		for (const n of list) {
			parents.set(n, { list, owner });
			if (Array.isArray(n.content)) walk(n.content, n);
		}
	};
	walk(state.doc.body.content, state.doc.body);
	for (const name of ["header", "footer"]) if (state.doc.page[name]) walk(state.doc.page[name].content, name);
}
const listOf = (node) => parents.get(node)?.list;
const ownerOf = (node) => parents.get(node)?.owner;

// ------------------------------------------------------------------ fields and numbers

function fieldValue(key, depth = 0) {
	const doc = state.doc;
	const field = doc.fields.find((f) => f.key === key);
	if (!field) return "";
	let v = doc.kind === "document" && doc.data?.[key] !== undefined ? doc.data[key] : field.sample;
	if ((v === undefined || v === "") && field.fallback !== undefined) v = field.fallback;
	if (typeof v !== "string") return v === undefined || v === null ? "" : String(v);
	return depth > 2 ? v : v.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k) => fieldValue(k, depth + 1));
}
const fmtNumber = (v, kind) => {
	if (v === null || v === undefined) return "";
	if (kind === "money") {
		const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
		return `${v < 0 ? "-" : ""}$${s}`;
	}
	return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
const colKind = (col) => (col.type === "formula" ? (col.format ?? "number") : col.type);

// ------------------------------------------------------------------ inline content <-> DOM

const MARK_ORDER = ["link", "bold", "italic", "underline", "tag"];
function inlineToDom(content, ctx) {
	const frag = document.createDocumentFragment();
	for (const node of content ?? []) {
		if (node.type === "text") {
			let el = document.createTextNode(node.text);
			const marks = [...(node.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type));
			for (const m of marks) {
				const wrap =
					m.type === "bold"
						? h("strong")
						: m.type === "italic"
							? h("em")
							: m.type === "underline"
								? h("u")
								: m.type === "link"
									? h("a", { href: m.attrs?.href ?? "", onclick: (e) => ctx.edit && e.preventDefault() })
									: h("span", { class: "tag" });
				wrap.append(el);
				el = wrap;
			}
			frag.append(el);
		} else if (node.type === "field") {
			const field = state.doc.fields.find((f) => f.key === node.attrs.key);
			if (ctx.preview) {
				const v = fieldValue(node.attrs.key);
				frag.append(h("span", { class: "field-fill", title: field?.label ?? node.attrs.key }, v || `[${(field?.label ?? node.attrs.key).toLowerCase()}]`));
			} else
				frag.append(
					h("span", { class: "field-chip", contenteditable: "false", dataset: { key: node.attrs.key }, title: `Merge field: ${node.attrs.key}` }, field?.label ?? node.attrs.key),
				);
		} else if (node.type === "hardBreak") frag.append(h("br"));
		else if (node.type === "pageNumber")
			frag.append(h("span", { class: "pagenum", contenteditable: "false", dataset: { format: node.attrs?.format ?? "page-of-total" } }, "Page 1 of 1"));
	}
	return frag;
}

function domToInline(root) {
	const out = [];
	const push = (node) => {
		const last = out[out.length - 1];
		if (node.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text += node.text;
		else out.push(node);
	};
	const walk = (el, marks) => {
		for (const child of el.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				const text = child.textContent.replace(/​/g, "").replace(/ /g, " ");
				if (text) push(marks.length ? { type: "text", text, marks: marks.map((m) => ({ ...m })) } : { type: "text", text });
				continue;
			}
			if (child.nodeType !== Node.ELEMENT_NODE) continue;
			if (child.classList.contains("field-chip")) {
				push({ type: "field", attrs: { key: child.dataset.key } });
				continue;
			}
			if (child.classList.contains("pagenum")) {
				push({ type: "pageNumber", attrs: { format: child.dataset.format } });
				continue;
			}
			if (child.tagName === "BR") {
				if (child !== el.lastChild) push({ type: "hardBreak" });
				continue;
			}
			const add = [];
			const tag = child.tagName;
			if (tag === "B" || tag === "STRONG" || /bold|[67]00/.test(child.style?.fontWeight ?? "")) add.push({ type: "bold" });
			if (tag === "I" || tag === "EM" || child.style?.fontStyle === "italic") add.push({ type: "italic" });
			if (tag === "U" || /underline/.test(child.style?.textDecoration ?? "")) add.push({ type: "underline" });
			if (tag === "A" && child.getAttribute("href")) add.push({ type: "link", attrs: { href: child.getAttribute("href") } });
			if (child.classList.contains("tag")) add.push({ type: "tag" });
			const next = [...marks];
			for (const m of add) if (!next.some((x) => x.type === m.type)) next.push(m);
			next.sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
			if ((tag === "DIV" || tag === "P") && out.length) push({ type: "hardBreak" });
			walk(child, next);
		}
	};
	walk(root, []);
	return out;
}

// ------------------------------------------------------------------ editable text

function editable(el, node, opts = {}) {
	const id = idOf(node);
	el.contentEditable = "true";
	el.dataset.editId = id;
	el.dataset.ph = opts.placeholder ?? "Type here";
	el.spellcheck = true;
	el.append(inlineToDom(node.content, { edit: true }));
	el.addEventListener("input", () => {
		node.content = domToInline(el);
		changed({ soft: true });
	});
	el.addEventListener("keydown", (e) => onKey(e, el, node, opts));
	el.addEventListener("paste", (e) => {
		e.preventDefault();
		const text = e.clipboardData.getData("text/plain");
		document.execCommand("insertText", false, opts.singleLine ? text.replace(/\s*\n\s*/g, " ") : text);
	});
	el.addEventListener("focusout", () => {
		if (state.mode === "edit") scheduleReflow(true);
	});
	return el;
}

function caretAtStart(el) {
	const sel = getSelection();
	if (!sel.rangeCount || !sel.isCollapsed) return false;
	const r = document.createRange();
	r.setStart(el, 0);
	r.setEnd(sel.anchorNode, sel.anchorOffset);
	return r.toString().length === 0 && !r.cloneContents().querySelector?.(".field-chip");
}

function splitAtCaret(el) {
	const sel = getSelection();
	if (!sel.rangeCount) return null;
	const r = sel.getRangeAt(0);
	r.deleteContents();
	const tail = document.createRange();
	tail.setStart(r.endContainer, r.endOffset);
	tail.setEnd(el, el.childNodes.length);
	const holder = document.createElement("div");
	holder.append(tail.extractContents());
	return { before: domToInline(el), after: domToInline(holder) };
}

function onKey(e, el, node, opts) {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
		e.preventDefault();
		save();
		return;
	}
	if (e.key === "Enter" && e.shiftKey) {
		e.preventDefault();
		document.execCommand("insertLineBreak");
		return;
	}
	if (e.key === "Enter") {
		e.preventDefault();
		if (opts.singleLine) return;
		const list = listOf(node);
		const owner = ownerOf(node);
		const split = splitAtCaret(el);
		if (!split || !list) return;
		node.content = split.before;
		if (owner?.type === "listItem") {
			const outer = listOf(owner);
			const wasEmpty = split.before.length === 0 && split.after.length === 0;
			if (wasEmpty) {
				// Enter on an empty item leaves the list.
				const listNode = ownerOf(owner);
				outer.splice(outer.indexOf(owner), 1);
				const para = { type: "paragraph", content: [] };
				const host = listOf(listNode);
				host.splice(host.indexOf(listNode) + 1, 0, para);
				if (!outer.length) host.splice(host.indexOf(listNode), 1);
				focusLater(para, "start");
			} else {
				const item = { type: "listItem", content: [{ type: "paragraph", content: split.after }] };
				outer.splice(outer.indexOf(owner) + 1, 0, item);
				focusLater(item.content[0], "start");
			}
		} else {
			const para = { type: "paragraph", content: split.after };
			if (node.type === "paragraph" && node.attrs) para.attrs = { ...node.attrs };
			list.splice(list.indexOf(node) + 1, 0, para);
			focusLater(para, "start");
		}
		changed();
		return;
	}
	if (e.key === "Backspace" && caretAtStart(el) && el.textContent.length === 0 && !el.querySelector(".field-chip")) {
		if (opts.singleLine) return;
		e.preventDefault();
		const editables = [...document.querySelectorAll("#canvas [contenteditable='true']")];
		const prev = editables[editables.indexOf(el) - 1];
		removeTextNode(node);
		if (prev?.dataset.editId) focusLater(byId.get(prev.dataset.editId), "end");
		changed();
	}
}

/** Remove a paragraph or heading; an emptied list item and an emptied list go with it. */
function removeTextNode(node) {
	const list = listOf(node);
	const owner = ownerOf(node);
	list.splice(list.indexOf(node), 1);
	if (owner?.type === "listItem" && !owner.content.length) {
		const items = listOf(owner);
		items.splice(items.indexOf(owner), 1);
		const listNode = ownerOf(owner);
		if (!items.length) listOf(listNode).splice(listOf(listNode).indexOf(listNode), 1);
	} else if (owner?.type === "quote" && !owner.content.length) listOf(owner).splice(listOf(owner).indexOf(owner), 1);
	if (state.sel === node) state.sel = null;
}

function focusLater(node, at) {
	state.pendingFocus = { node, at };
}
function applyPendingFocus() {
	const f = state.pendingFocus;
	state.pendingFocus = null;
	if (!f) return;
	const id = ids.get(f.node);
	const el = id && document.querySelector(`#canvas [data-edit-id="${id}"]`);
	if (!el) return;
	el.focus();
	const r = document.createRange();
	r.selectNodeContents(el);
	r.collapse(f.at === "start");
	getSelection().removeAllRanges();
	getSelection().addRange(r);
	const blk = el.closest(".blk[data-id]");
	if (blk) select(byId.get(blk.dataset.id), null, false);
}

/** The caret as (editable id, character offset), so a full redraw can put it back. */
function saveCaret() {
	const sel = getSelection();
	if (!sel.rangeCount) return null;
	const el = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest("[data-edit-id]");
	if (!el) return null;
	const r = document.createRange();
	r.setStart(el, 0);
	r.setEnd(sel.anchorNode, sel.anchorOffset);
	return { id: el.dataset.editId, offset: r.toString().length };
}
function restoreCaret(c) {
	if (!c) return;
	const el = document.querySelector(`#canvas [data-edit-id="${c.id}"]`);
	if (!el) return;
	el.focus();
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let left = c.offset;
	let t;
	while ((t = walker.nextNode())) {
		if (left <= t.textContent.length) {
			const r = document.createRange();
			r.setStart(t, left);
			r.collapse(true);
			getSelection().removeAllRanges();
			getSelection().addRange(r);
			return;
		}
		left -= t.textContent.length;
	}
}

// ------------------------------------------------------------------ block renderer

/** Every block sits in its own wrapper: the selection outline and the type tag never enter editable text. */
function blockShell(node, ctx, el) {
	const wrap = h("div", { class: "blk", dataset: { type: node.type } });
	if (ctx.edit) {
		wrap.dataset.id = idOf(node);
		wrap.append(h("span", { class: "blk-tag", "aria-hidden": "true" }, TYPE_LABEL[node.type] ?? node.type));
		if (state.sel === node) wrap.classList.add("selected");
	}
	wrap.append(el);
	return wrap;
}

function addHere(list, label = "Add a block here") {
	return h("button", {
		type: "button",
		class: "add-here",
		onclick: (e) => {
			e.stopPropagation();
			state.insertInto = list;
			openInsertMenu();
		},
	}, `+ ${label}`);
}

function renderChildren(list, ctx, into) {
	if (!list.length && ctx.edit) into.append(addHere(list));
	for (const child of list) into.append(renderBlock(child, ctx));
}

function textEl(tag, cls, node, ctx, placeholder) {
	const el = h(tag, { class: cls });
	if (ctx.edit) editable(el, node, { placeholder });
	else el.append(inlineToDom(node.content, ctx));
	return el;
}

function renderBlock(node, ctx) {
	const a = node.attrs ?? {};
	switch (node.type) {
		case "paragraph": {
			const el = textEl("p", `p s-${a.style ?? "body"}`, node, ctx, "Type text, or use Insert block");
			el.style.textAlign = a.align ?? "left";
			return blockShell(node, ctx, el);
		}
		case "heading": {
			const level = a.level ?? 2;
			const title = textEl(`h${level}`, `h h${level}`, node, ctx, level === 1 ? "Title" : "Heading");
			title.style.textAlign = a.align ?? "left";
			if (a.numbered) {
				ctx.headingNo.n += 1;
				const wrap = h("div", { class: "hwrap numbered" }, h("span", { class: "hnum" }, String(ctx.headingNo.n).padStart(2, "0")), title);
				return blockShell(node, ctx, wrap);
			}
			return blockShell(node, ctx, h("div", { class: "hwrap" }, title));
		}
		case "bulletList":
		case "orderedList": {
			const el = h(node.type === "bulletList" ? "ul" : "ol", { class: "list" });
			for (const item of node.content) {
				const li = h("li");
				for (const p of item.content) li.append(textEl("p", `p s-${p.attrs?.style ?? "body"}`, p, ctx, "List item"));
				el.append(li);
			}
			return blockShell(node, ctx, el);
		}
		case "quote": {
			const el = h("blockquote", { class: "quote" });
			for (const p of node.content) el.append(textEl("p", "p", p, ctx, "Quote"));
			return blockShell(node, ctx, el);
		}
		case "divider": {
			const el = h("div", { class: `divider w-${a.weight ?? "rule"}`, style: { borderColor: TOKEN_VAR[a.color ?? "ink"] } });
			return blockShell(node, ctx, el);
		}
		case "spacer":
			return blockShell(node, ctx, h("div", { class: "spacer-blk", style: { height: pt(a.size ?? 12) } }));
		case "pageBreak":
			return blockShell(node, ctx, h("div", { class: ctx.edit ? "pagebreak" : "", style: ctx.edit ? {} : { display: "none" } }));
		case "columns": {
			const widths = node.content.map((c) => `${c.attrs?.width ?? 1}fr`).join(" ");
			const el = h("div", { class: "cols", style: { gridTemplateColumns: widths, columnGap: pt(a.gap ?? 12), alignItems: { top: "start", center: "center", bottom: "end" }[a.valign ?? "top"] } });
			for (const col of node.content) {
				const c = h("div", { class: `col a-${col.attrs?.align ?? "left"}` });
				renderChildren(col.content, ctx, c);
				el.append(c);
			}
			return blockShell(node, ctx, el);
		}
		case "box": {
			const fill = a.fill ?? "none";
			const el = h("div", {
				class: `box ${ON_FILL[fill] ?? ""}`,
				style: { background: TOKEN_VAR[fill], border: (a.border ?? "border") === "none" ? "0" : `1pt solid ${TOKEN_VAR[a.border ?? "border"]}`, padding: pt(a.padding ?? 12) },
			});
			renderChildren(node.content, ctx, el);
			return blockShell(node, ctx, el);
		}
		case "image":
			return blockShell(node, ctx, renderImage(a));
		case "writeIn": {
			const el = h(
				"div",
				{ class: `writein k-${a.kind ?? "text"}`, style: { width: a.width ? pt(a.width) : "100%", maxWidth: "100%" } },
				h("div", { class: "label" }, a.label ?? "Name"),
				h("div", { class: "boxline", title: `Write-in field: ${a.key}` }),
			);
			return blockShell(node, ctx, el);
		}
		case "slot": {
			const el = h("div", { class: "slot" }, h("div", { class: "label" }, a.label ?? "Slot"));
			if (!node.content.length) {
				el.append(h("div", { class: "blank-note" }, "Not filled in yet. Your church or its sending network adds this text. It stays blank until then."));
				if (ctx.edit) el.append(addHere(node.content, "Add text to this slot"));
			} else for (const p of node.content) el.append(renderBlock(p, ctx));
			return blockShell(node, ctx, el);
		}
		case "table":
			return blockShell(node, ctx, renderTable(node, ctx));
	}
	return h("div", {}, `Unknown block ${node.type}`);
}

function renderImage(a) {
	const align = a.align ?? "left";
	const el = h("div", { class: `img-slot a-${align} ${a.source === "photo" ? "photo" : ""}`, style: { width: pt(a.width ?? 150), height: pt(a.height ?? 34), maxWidth: "100%" }, role: "img", "aria-label": a.alt || a.source });
	const name = fieldValue("church_name") || "Church name";
	if (a.source === "photo") el.append(state.brand === "church" ? "" : "Photo");
	else if (a.source === "mark") {
		el.append(h("span", { class: "church-name", style: { fontSize: pt(Math.min(a.height, a.width) * 0.5) } }, name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2)));
	} else if (state.brand === "church") {
		// The sample church logo: a mark and the name, fitted inside the slot like the PDF logo slot.
		const hgt = a.height ?? 34;
		const size = Math.min(hgt * 0.5, (((a.width ?? 150) - hgt * 0.9) / Math.max(name.length, 1)) * 1.9);
		el.append(
			h("span", { style: { width: pt(hgt * 0.7), height: pt(hgt * 0.7), borderRadius: "50%", background: "var(--accent)", flex: "none", marginRight: pt(hgt * 0.2) } }),
			h("span", { class: "church-name", style: { fontSize: pt(size.toFixed(1)) } }, name),
		);
	} else {
		const size = Math.min((a.height ?? 34) * 0.62, ((a.width ?? 150) / Math.max(name.length, 1)) * 1.9);
		el.append(h("span", { class: "church-name", style: { fontSize: pt(size.toFixed(1)) } }, name));
	}
	return el;
}

function renderTable(node, ctx) {
	const a = node.attrs;
	const cols = a.columns;
	const out = computeTable(node);
	const style = a.style ?? "grid";
	const table = h("table", { class: `tbl st-${style}` });
	const colgroup = h("colgroup");
	for (const c of cols) colgroup.append(h("col", { style: c.width ? { width: pt(c.width) } : {} }));
	table.append(colgroup);
	const fillToken = a.headerFill ?? "muted";
	const alignOf = (c) => c.align ?? (c.type === "money" || c.type === "number" || c.type === "formula" ? "right" : c.type === "check" || c.type === "index" ? "center" : "left");
	if (a.header !== false) {
		const tr = h("tr", { style: { background: TOKEN_VAR[fillToken] } });
		cols.forEach((c) => {
			const th = h("th", { class: `al-${alignOf(c)} ${ON_FILL[fillToken] ?? ""}`, scope: "col" }, c.label);
			if (ctx.edit) {
				th.contentEditable = "true";
				th.dataset.ph = "Label";
				th.addEventListener("input", () => {
					c.label = th.textContent;
					changed({ soft: true, panel: true });
				});
				th.addEventListener("keydown", (e) => e.key === "Enter" && e.preventDefault());
			}
			tr.append(th);
		});
		table.append(h("thead", {}, tr));
	}
	const body = h("tbody");
	let visual = 0;
	(node.content ?? []).forEach((row, ri) => {
		const role = row.attrs?.role ?? "item";
		const tr = h("tr", { class: `r-${role}`, dataset: { row: String(ri) }, style: a.rowHeight ? { height: pt(a.rowHeight) } : {} });
		if (a.zebra && role === "item" && visual % 2 === 1) tr.classList.add("zebra");
		if (role === "item") visual += 1;
		if (ctx.edit && state.sel === node && state.selRow === ri) tr.classList.add("row-selected");
		cols.forEach((c, ci) => {
			const cell = row.content[ci] ?? { type: "cell" };
			const td = h("td", { class: `al-${alignOf(c)}` });
			const kind = colKind(c);
			if (c.type === "text") {
				if (ctx.edit) editable(td, cell, { placeholder: role === "item" ? "" : "Label", singleLine: false });
				else td.append(inlineToDom(cell.content, ctx));
			} else if (c.type === "check") {
				const box = h("span", { class: `check ${cell.attrs?.checked ? "on" : ""}`, role: "checkbox", "aria-checked": String(!!cell.attrs?.checked), "aria-label": "Check" });
				if (role === "item") td.append(box);
				if (ctx.edit && role === "item")
					box.addEventListener("click", () => {
						cell.attrs = { ...(cell.attrs ?? {}), checked: !cell.attrs?.checked };
						if (!cell.attrs.checked) delete cell.attrs.checked;
						box.classList.toggle("on");
						changed({ soft: true });
					});
			} else if (c.type === "index") {
				if (role === "item") td.append(h("span", { class: "index" }, String(out[ri][ci] ?? "")));
			} else if ((c.type === "money" || c.type === "number") && role === "item") {
				td.classList.add("num");
				const v = cell.attrs?.value;
				const input = h("span", { class: "money-in", title: "Amount" }, v === null || v === undefined ? "" : fmtNumber(v, kind));
				if (ctx.edit) {
					input.contentEditable = "true";
					input.dataset.ph = "";
					input.inputMode = "decimal";
					input.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), input.blur()));
					input.addEventListener("input", () => {
						const raw = input.textContent.replace(/[$,\s]/g, "");
						if (raw === "") {
							cell.attrs = { ...(cell.attrs ?? {}) };
							delete cell.attrs.value;
							if (!Object.keys(cell.attrs).length) delete cell.attrs;
							input.classList.remove("bad");
						} else if (/^-?\d+(\.\d+)?$/.test(raw)) {
							cell.attrs = { ...(cell.attrs ?? {}), value: Number(raw) };
							input.classList.remove("bad");
						} else {
							input.classList.add("bad");
							return;
						}
						refreshCalc(node, table);
						changed({ soft: true });
					});
				}
				td.append(input);
			} else if (c.type === "money" || c.type === "number" || c.type === "formula") {
				td.classList.add("num");
				const show = role === "group" ? null : out[ri][ci];
				td.append(h("span", { class: "computed", dataset: { calc: `${ri},${ci}` } }, fmtNumber(show, kind)));
			}
			tr.append(td);
		});
		body.append(tr);
	});
	const items = (node.content ?? []).filter((r) => (r.attrs?.role ?? "item") === "item").length;
	for (let i = 0; i < (a.writeInRows ?? 0); i++) {
		const tr = h("tr", { class: "writein-row", title: "Write-in row", style: a.rowHeight ? { height: pt(a.rowHeight) } : {} });
		if (a.zebra && visual % 2 === 1) tr.classList.add("zebra");
		visual += 1;
		cols.forEach((c) => {
			const td = h("td", { class: `al-${alignOf(c)}` });
			if (c.type === "index") td.append(h("span", { class: "index" }, String(items + i + 1)));
			if (c.type === "check") td.append(h("span", { class: "check" }));
			tr.append(td);
		});
		body.append(tr);
	}
	table.append(body);
	if (ctx.edit && !(node.content ?? []).length && !(a.writeInRows ?? 0))
		table.append(h("caption", { style: { captionSide: "bottom", fontSize: "8pt", color: "#7b828d", textAlign: "left" } }, "No rows yet. Add rows or write-in rows in the Block panel."));
	return table;
}

function refreshCalc(node, tableEl) {
	const out = computeTable(node);
	for (const el of tableEl.querySelectorAll("[data-calc]")) {
		const [r, c] = el.dataset.calc.split(",").map(Number);
		const role = node.content[r]?.attrs?.role ?? "item";
		el.textContent = fmtNumber(role === "group" ? null : out[r][c], colKind(node.attrs.columns[c]));
	}
}

// ------------------------------------------------------------------ pages

function regionEl(name, pageNo, ctx, regionDrawn) {
	const region = state.doc.page[name];
	const el = h("div", { class: `region region-${name}` });
	if (region && (region.pages === "all" || (region.pages === "first" && pageNo === 1) || (region.pages === "rest" && pageNo > 1))) {
		const editHere = ctx.edit && !regionDrawn[name];
		regionDrawn[name] = true;
		const rctx = { ...ctx, edit: editHere };
		renderChildren(region.content, rctx, el);
	}
	if (name === "footer" && state.doc.class === "formal/legal")
		el.append(
			h(
				"div",
				{ class: "legal-notice", title: "Formal and legal documents always print this notice. Editing cannot remove it." },
				"Template, not legal advice",
				ctx.preview ? null : h("span", { class: "lock" }, "Locked"),
			),
		);
	return el;
}

function overflowing(el) {
	return el.scrollHeight > el.clientHeight + 1;
}

function makePage(n, box, compact) {
	const m = state.doc.page.margin;
	const page = h("div", { class: `page ${compact ? "compact" : ""}`, style: { width: pt(box.width), height: pt(box.height) } });
	const label = h("div", { class: "page-label" }, `Page ${n} · ${Math.round(box.width)} x ${Math.round(box.height)} pt · margins ${m.top} ${m.right} ${m.bottom} ${m.left} pt`);
	const inner = h("div", { class: "page-inner", style: { top: pt(m.top), left: pt(m.left), right: pt(m.right), bottom: pt(m.bottom) } });
	page.append(inner);
	return { el: h("div", { class: "page-wrap" }, label, page), inner, label };
}

function renderFlow(canvas, ctx) {
	const page = state.doc.page;
	const box = pageBox(page, state.schema);
	const compact = box.width < 360;
	const pages = [];
	const regionDrawn = {};
	const newPage = () => {
		const pg = makePage(pages.length + 1, box, compact);
		const header = regionEl("header", pages.length + 1, ctx, regionDrawn);
		const body = h("div", { class: "page-body flow" });
		const footer = regionEl("footer", pages.length + 1, ctx, regionDrawn);
		pg.inner.append(header, body, footer);
		canvas.append(pg.el);
		pages.push({ ...pg, body });
		return pages[pages.length - 1];
	};
	let pg = newPage();
	const blocks = state.doc.body.content;
	if (!blocks.length) {
		pg.body.append(h("div", { class: "empty-doc" }, "This document is empty.", ctx.edit ? h("div", { style: { marginTop: "8pt" } }, addHere(blocks, "Add the first block")) : null));
	}
	for (const node of blocks) {
		const el = renderBlock(node, ctx);
		pg.body.append(el);
		if (node.type === "pageBreak") {
			pg = newPage();
			continue;
		}
		if (overflowing(pg.body) && pg.body.children.length > 1) {
			el.remove();
			const prev = pg.body.lastElementChild;
			const carry = prev?.dataset.type === "heading" && pg.body.children.length > 1 ? prev : null;
			pg = newPage();
			if (carry) pg.body.append(carry);
			pg.body.append(el);
		}
	}
	pages.forEach((p, i) => {
		for (const span of p.el.querySelectorAll(".pagenum")) span.textContent = span.dataset.format === "page" ? String(i + 1) : `Page ${i + 1} of ${pages.length}`;
	});
	return pages.length;
}

function renderSheet(canvas, ctx) {
	const page = state.doc.page;
	const box = pageBox(page, state.schema);
	const tb = tileBox(page, state.schema);
	const t = page.tile;
	const pg = makePage(1, box, false);
	pg.label.textContent = `Sheet · ${Math.round(box.width)} x ${Math.round(box.height)} pt · ${t.across * t.down} tiles of ${Math.round(tb.width)} x ${Math.round(tb.height)} pt`;
	const grid = h("div", { class: "sheet-grid", style: { gridTemplateColumns: `repeat(${t.across}, ${pt(tb.width)})`, gridTemplateRows: `repeat(${t.down}, ${pt(tb.height)})` } });
	pg.inner.append(grid);
	canvas.append(pg.el);
	const compact = tb.width < 360;
	for (let i = 0; i < t.across * t.down; i++) {
		const tctx = { ...ctx, edit: ctx.edit && i === 0, headingNo: { n: 0 } };
		const tile = h("div", { class: `tile ${t.cutMarks ? "cut" : ""} ${compact ? "compact" : ""} ${ctx.edit && i > 0 ? "mirror" : ""}`, style: { padding: pt(t.padding) } });
		const regionDrawn = {};
		const body = h("div", { class: "page-body" });
		tile.append(regionEl("header", 1, tctx, regionDrawn), body, regionEl("footer", 1, tctx, regionDrawn));
		grid.append(tile);
		const blocks = state.doc.body.content;
		if (!blocks.length && i === 0) body.append(h("div", { class: "empty-doc" }, "This card is empty.", tctx.edit ? h("div", { style: { marginTop: "8pt" } }, addHere(blocks, "Add the first block")) : null));
		for (const node of blocks) body.append(renderBlock(node, tctx));
		if (i === 0 && ctx.edit && overflowing(body)) tile.append(h("div", { class: "tile-overflow" }, "Content does not fit this card"));
	}
	for (const span of pg.el.querySelectorAll(".pagenum")) span.textContent = span.dataset.format === "page" ? "1" : "Page 1 of 1";
	return 1;
}

function render() {
	if (!state.doc) return;
	indexDoc();
	byId.clear();
	const canvas = $("#canvas");
	canvas.className = `canvas ${state.mode} ${state.brand === "church" ? "brand-church" : ""}`;
	canvas.replaceChildren();
	const ctx = { edit: state.mode === "edit", preview: state.mode === "preview", headingNo: { n: 0 } };
	if (state.doc.page.tile) renderSheet(canvas, ctx);
	else renderFlow(canvas, ctx);
	fitCanvas();
	applyPendingFocus();
	renderChrome();
}

function fitCanvas() {
	const canvas = $("#canvas");
	canvas.style.zoom = "1";
	const page = canvas.querySelector(".page");
	if (!page) return;
	const avail = $(".canvas-wrap").clientWidth - 24;
	const z = Math.min(1, avail / page.offsetWidth);
	canvas.style.zoom = String(Math.max(0.3, z));
}

// ------------------------------------------------------------------ change handling

let softTimer = 0;
function changed({ soft = false, panel = false } = {}) {
	if (!soft) {
		render();
		renderPanel();
		return;
	}
	clearTimeout(softTimer);
	softTimer = setTimeout(() => {
		updateMirrors();
		renderValidity();
		if (state.tab === "json" || panel) renderPanel();
		scheduleReflow(false);
	}, 250);
}

let reflowTimer = 0;
/** A redraw after typing pauses, only when a page now overflows (or on leaving a block, always), with the caret kept. */
function scheduleReflow(always) {
	clearTimeout(reflowTimer);
	reflowTimer = setTimeout(() => {
		if (state.doc.page.tile) return;
		const over = [...document.querySelectorAll("#canvas .page-body.flow")].some(overflowing);
		if (!over && !always) return;
		if (always && document.activeElement?.closest?.("#canvas [contenteditable='true']")) return;
		const caret = saveCaret();
		render();
		restoreCaret(caret);
	}, always ? 50 : 700);
}

function updateMirrors() {
	if (!state.doc.page.tile || state.mode !== "edit") return;
	const tiles = [...document.querySelectorAll("#canvas .tile")];
	const ctx = { edit: false, preview: false, headingNo: { n: 0 } };
	tiles.slice(1).forEach((tile) => {
		const body = tile.querySelector(".page-body");
		body.replaceChildren(...state.doc.body.content.map((n) => renderBlock(n, { ...ctx, headingNo: { n: 0 } })));
		for (const name of ["header", "footer"]) {
			const old = tile.querySelector(`.region-${name}`);
			old.replaceWith(regionEl(name, 1, ctx, {}));
		}
	});
	const first = tiles[0];
	if (first) {
		first.querySelector(".tile-overflow")?.remove();
		if (state.mode !== "edit") return;
		if (overflowing(first.querySelector(".page-body"))) first.append(h("div", { class: "tile-overflow" }, "Content does not fit this card"));
	}
}

// ------------------------------------------------------------------ selection

function select(node, row = null, redraw = true) {
	state.sel = node;
	state.selRow = row;
	for (const el of document.querySelectorAll("#canvas .blk.selected")) el.classList.remove("selected");
	for (const el of document.querySelectorAll("#canvas tr.row-selected")) el.classList.remove("row-selected");
	if (node) {
		const id = ids.get(node);
		document.querySelector(`#canvas .blk[data-id="${id}"]`)?.classList.add("selected");
		if (row !== null) document.querySelector(`#canvas .blk[data-id="${id}"] tr[data-row="${row}"]`)?.classList.add("row-selected");
	}
	if (redraw || state.tab === "block") renderPanel();
	syncStyleSelect();
}

function textNodeForStyle() {
	const editId = state.lastEditable?.dataset?.editId;
	const fromCaret = editId && byId.get(editId);
	if (fromCaret && (fromCaret.type === "paragraph" || fromCaret.type === "heading")) return fromCaret;
	if (state.sel && (state.sel.type === "paragraph" || state.sel.type === "heading")) return state.sel;
	return null;
}
function syncStyleSelect() {
	const n = textNodeForStyle();
	$("#blockstyle").value = !n ? "" : n.type === "heading" ? `h:${n.attrs?.level ?? 2}` : `p:${n.attrs?.style ?? "body"}`;
}

// ------------------------------------------------------------------ block factories and insert

const p = (text = "", attrs) => ({ type: "paragraph", ...(attrs ? { attrs } : {}), content: text ? [{ type: "text", text }] : [] });
const cellOf = (col, text = "") => (col.type === "text" && text ? { type: "cell", content: [{ type: "text", text }] } : { type: "cell" });
const rowOf = (cols, role = "item", label = "", sign) => ({
	type: "row",
	...(role !== "item" ? { attrs: { role, ...(role === "group" ? { sign: sign ?? "add" } : {}) } } : {}),
	content: cols.map((c, i) => cellOf(c, i === cols.findIndex((x) => x.type === "text") ? label : "")),
});
function uniqueKey(base) {
	const used = new Set();
	const walk = (list) => list.forEach((n) => (n.type === "writeIn" && used.add(n.attrs.key), Array.isArray(n.content) && walk(n.content)));
	walk(state.doc.body.content);
	for (const r of ["header", "footer"]) if (state.doc.page[r]) walk(state.doc.page[r].content);
	let key = base;
	for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
	return key;
}

const BLOCKS = [
	{ group: "Text" },
	{ id: "paragraph", label: "Paragraph", make: () => p() },
	{ id: "h1", label: "Title", hint: "Heading 1, display type", make: () => ({ type: "heading", attrs: { level: 1 }, content: [] }) },
	{ id: "h2", label: "Section heading", hint: "Heading 2, numbered", make: () => ({ type: "heading", attrs: { level: 2, numbered: true }, content: [] }) },
	{ id: "h3", label: "Subheading", hint: "Heading 3", make: () => ({ type: "heading", attrs: { level: 3 }, content: [] }) },
	{ id: "bullets", label: "Bulleted list", make: () => ({ type: "bulletList", content: [{ type: "listItem", content: [p()] }] }) },
	{ id: "numbers", label: "Numbered list", make: () => ({ type: "orderedList", content: [{ type: "listItem", content: [p()] }] }) },
	{ id: "quote", label: "Quote", make: () => ({ type: "quote", content: [p()] }) },
	{ id: "slot", label: "Doctrinal slot", hint: "A blank the church or network fills", make: () => ({ type: "slot", attrs: { label: "Statement of faith" }, content: [] }) },
	{ group: "Layout" },
	{ id: "columns", label: "Columns", hint: "Two side-by-side columns", make: () => ({ type: "columns", attrs: { gap: 12, valign: "top" }, content: [{ type: "column", attrs: { width: 1 }, content: [] }, { type: "column", attrs: { width: 1 }, content: [] }] }) },
	{ id: "box", label: "Box", hint: "A panel with a fill or a border", make: () => ({ type: "box", attrs: { fill: "muted", border: "none", padding: 12, keepTogether: true }, content: [] }) },
	{ id: "cover", label: "Color panel", hint: "A box in the primary color, for a card cover", make: () => ({ type: "box", attrs: { fill: "primary", border: "none", padding: 12, keepTogether: true }, content: [p("", { style: "lead" })] }) },
	{ id: "divider", label: "Divider", make: () => ({ type: "divider", attrs: { weight: "rule", color: "ink" } }) },
	{ id: "bar", label: "Accent bar", hint: "A 4 pt bar in the accent color", make: () => ({ type: "divider", attrs: { weight: "bar", color: "accent" } }) },
	{ id: "spacer", label: "Space", make: () => ({ type: "spacer", attrs: { size: 12 } }) },
	{ id: "pageBreak", label: "Page break", make: () => ({ type: "pageBreak" }) },
	{ id: "logo", label: "Logo slot", hint: "The church logo, or its name when it has none", make: () => ({ type: "image", attrs: { source: "logo", width: 150, height: 34, align: "left", alt: "Church logo" } }) },
	{ id: "photo", label: "Photo slot", make: () => ({ type: "image", attrs: { source: "photo", width: 72, height: 72, align: "right", alt: "" } }) },
	{ group: "Forms and data" },
	{ id: "writeIn", label: "Write-in field", hint: "A labelled box a person fills in", make: () => ({ type: "writeIn", attrs: { label: "Name", key: uniqueKey("name"), kind: "text", width: 0 } }) },
	{ id: "signature", label: "Signature line", make: () => ({ type: "writeIn", attrs: { label: "Signature", key: uniqueKey("signature"), kind: "signature", width: 0 } }) },
	{
		id: "table",
		label: "Table",
		hint: "Header row and rows to write in",
		make: () => ({
			type: "table",
			attrs: {
				style: "grid", header: true, headerFill: "muted", zebra: false, writeInRows: 5, rowHeight: 22, source: null, sheet: null,
				columns: [1, 2, 3].map((n) => ({ id: `col_${n}`, label: `Column ${n}`, type: "text", width: 0 })),
			},
			content: [],
		}),
	},
	{
		id: "checklist",
		label: "Checklist rows",
		hint: "A checkbox and text on each row",
		make: () => {
			const columns = [
				{ id: "done", label: "", type: "check", width: 18, align: "center" },
				{ id: "item", label: "Item", type: "text", width: 0 },
			];
			return { type: "table", attrs: { style: "rows", header: false, headerFill: "none", zebra: false, writeInRows: 0, rowHeight: 0, source: null, sheet: null, columns }, content: [rowOf(columns), rowOf(columns), rowOf(columns)] };
		},
	},
	{
		id: "budget",
		label: "Budget table",
		hint: "Categories, line items and totals that add up",
		make: () => {
			const columns = [
				{ id: "item", label: "Category", type: "text", width: 0 },
				{ id: "amount", label: "Amount", type: "money", width: 110, align: "right" },
			];
			return {
				type: "table",
				attrs: { style: "ledger", header: true, headerFill: "primary", zebra: false, writeInRows: 0, rowHeight: 0, source: null, sheet: "Budget", columns },
				content: [rowOf(columns, "group", "Category", "add"), rowOf(columns, "item", "Line item"), rowOf(columns, "subtotal", "Category total"), rowOf(columns, "total", "Grand total")],
			};
		},
	},
];

function insertBlock(def) {
	const node = def.make();
	let list;
	let at;
	if (state.insertInto) {
		list = state.insertInto;
		at = list.length;
	} else if (state.sel && listOf(state.sel)) {
		const sel = state.sel;
		// Into an empty box or slot; otherwise after the selected block, in the same container.
		if ((sel.type === "box" || sel.type === "slot") && !sel.content.length) {
			list = sel.content;
			at = 0;
		} else {
			list = listOf(sel);
			at = list.indexOf(sel) + 1;
		}
	} else {
		list = state.doc.body.content;
		at = list.length;
	}
	state.insertInto = null;
	if (node.type === "pageBreak" && list !== state.doc.body.content) {
		toast("A page break goes in the page body, not inside a box, a column or the header.");
		return;
	}
	list.splice(at, 0, node);
	state.sel = node;
	state.selRow = null;
	const firstText = findText(node);
	if (firstText) focusLater(firstText, "start");
	closeInsertMenu();
	state.tab = "block";
	changed();
}
function findText(node) {
	if (node.type === "paragraph" || node.type === "heading") return node;
	if (Array.isArray(node.content) && !["table", "columns"].includes(node.type)) for (const c of node.content) {
		const t = findText(c);
		if (t) return t;
	}
	return null;
}

function openInsertMenu() {
	const menu = $("#insert-menu");
	menu.replaceChildren(
		...BLOCKS.map((b) =>
			b.group
				? h("div", { class: "group" }, b.group)
				: h("button", { type: "button", role: "menuitem", onmousedown: (e) => e.preventDefault(), onclick: () => insertBlock(b) }, b.label, b.hint ? h("span", { class: "hint" }, b.hint) : null),
		),
	);
	menu.hidden = false;
	$("#insert-btn").setAttribute("aria-expanded", "true");
	menu.querySelector("button")?.focus({ preventScroll: true });
}
function closeInsertMenu() {
	$("#insert-menu").hidden = true;
	$("#insert-btn").setAttribute("aria-expanded", "false");
}

function moveSelected(dir) {
	const node = state.sel;
	const list = node && listOf(node);
	if (!list) return;
	const i = list.indexOf(node);
	const j = i + dir;
	if (j < 0 || j >= list.length) return;
	[list[i], list[j]] = [list[j], list[i]];
	changed();
}
function deleteSelected() {
	const node = state.sel;
	const list = node && listOf(node);
	if (!list) {
		toast("Select a block first. Click it on the page.");
		return;
	}
	if (node.type === "paragraph" || node.type === "heading") removeTextNode(node);
	else list.splice(list.indexOf(node), 1);
	state.sel = null;
	state.selRow = null;
	changed();
}

// ------------------------------------------------------------------ marks and fields

function restoreRange() {
	if (state.lastEditable && !state.lastEditable.isConnected && state.lastCaret) {
		// A redraw replaced the text element: find it again by its node and put the caret back by offset.
		restoreCaret(state.lastCaret);
		const sel = getSelection();
		const el = document.querySelector(`#canvas [data-edit-id="${state.lastCaret.id}"]`);
		if (!el || !sel.rangeCount) return false;
		state.lastEditable = el;
		state.lastRange = sel.getRangeAt(0).cloneRange();
		return true;
	}
	const r = state.lastRange;
	if (!r || !state.lastEditable?.isConnected) return false;
	state.lastEditable.focus({ preventScroll: true });
	getSelection().removeAllRanges();
	getSelection().addRange(r);
	return true;
}
function syncEditable() {
	const el = state.lastEditable;
	if (el?.isConnected) el.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyMark(mark) {
	if (state.mode !== "edit") return;
	if (!restoreRange()) {
		toast("Click in some text first, then select the words to format.");
		return;
	}
	if (mark === "bold" || mark === "italic" || mark === "underline") {
		document.execCommand(mark);
		return;
	}
	if (mark === "tag") return toggleTag();
	if (mark === "link") return linkDialog();
}

function toggleTag() {
	const sel = getSelection();
	const r = sel.getRangeAt(0);
	const inTag = (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement).closest(".tag");
	if (inTag) {
		inTag.replaceWith(...inTag.childNodes);
	} else {
		if (r.collapsed) {
			toast("Select the words to put on a tag.");
			return;
		}
		const span = h("span", { class: "tag" });
		const frag = r.extractContents();
		for (const t of frag.querySelectorAll?.(".tag") ?? []) t.replaceWith(...t.childNodes);
		span.append(frag);
		r.insertNode(span);
		r.selectNodeContents(span);
		sel.removeAllRanges();
		sel.addRange(r);
	}
	syncEditable();
}

function linkDialog() {
	const saved = state.lastRange?.cloneRange();
	const anchor = saved && (saved.commonAncestorContainer.nodeType === 1 ? saved.commonAncestorContainer : saved.commonAncestorContainer.parentElement).closest("a");
	const input = h("input", { class: "control", type: "url", value: anchor?.getAttribute("href") ?? "https://", "aria-label": "Link address" });
	const err = h("p", { class: "help", style: { color: "var(--ui-danger)" } });
	const done = () => {
		const url = input.value.trim();
		if (!/^(https?:\/\/|mailto:)./.test(url)) {
			err.textContent = "Use an address that starts with https://, http:// or mailto:.";
			return;
		}
		dialog.close();
		state.lastRange = saved;
		restoreRange();
		if (saved.collapsed) document.execCommand("insertHTML", false, `<a href="${url.replace(/"/g, "&quot;")}">${url.replace(/[<&>]/g, "")}</a>`);
		else document.execCommand("createLink", false, url);
		syncEditable();
	};
	const dialog = $("#dialog");
	dialog.replaceChildren(
		h("h2", {}, "Link"),
		h("p", { class: "help" }, "The selected words link to this address."),
		input,
		err,
		h(
			"div",
			{ class: "actions" },
			anchor
				? h("button", { type: "button", class: "btn btn-danger", onclick: () => (dialog.close(), (state.lastRange = saved), restoreRange(), document.execCommand("unlink"), syncEditable()) }, "Remove link")
				: null,
			h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"),
			h("button", { type: "button", class: "btn btn-primary", onclick: done }, "Apply"),
		),
	);
	input.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), done()));
	dialog.showModal();
	input.select();
}

function insertField(key) {
	if (!restoreRange()) {
		toast("Click in some text first. The field goes where the cursor is.");
		return;
	}
	const field = state.doc.fields.find((f) => f.key === key);
	const chip = h("span", { class: "field-chip", contenteditable: "false", dataset: { key } }, field?.label ?? key);
	const r = getSelection().getRangeAt(0);
	r.deleteContents();
	r.insertNode(chip);
	const after = document.createTextNode(" ");
	chip.after(after);
	r.setStart(after, 1);
	r.collapse(true);
	getSelection().removeAllRanges();
	getSelection().addRange(r);
	syncEditable();
}

// ------------------------------------------------------------------ inspector panels

function formRow(label, control) {
	const id = `f${Math.random().toString(36).slice(2, 8)}`;
	control.id = id;
	return [h("label", { for: id }, label), control];
}
function attrControl(spec, value, onChange) {
	const v = value ?? spec.default;
	if (spec.type === "enum" || spec.type === "token") {
		const values = spec.type === "token" ? state.schema.tokens.color : spec.values;
		const s = h("select", { class: "control", onchange: () => onChange(s.value) }, ...values.map((x) => h("option", { value: x, selected: x === v }, x)));
		return s;
	}
	if (spec.type === "bool") {
		const c = h("input", { type: "checkbox", onchange: () => onChange(c.checked) });
		c.checked = !!v;
		return c;
	}
	if (spec.type === "int" || spec.type === "number") {
		const i = h("input", { class: "control", type: "number", value: v ?? "", min: spec.min, max: spec.max, step: spec.type === "int" ? 1 : "any", onchange: () => i.value !== "" && onChange(spec.type === "int" ? Math.round(Number(i.value)) : Number(i.value)) });
		return i;
	}
	const i = h("input", { class: "control", value: v ?? "", onchange: () => onChange(i.value === "" && spec.nullable ? null : i.value) });
	return i;
}

function renderPanel() {
	for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
	const panel = $("#panel");
	const scroll = panel.scrollTop;
	panel.replaceChildren(...({ block: blockPanel, page: pagePanel, fields: fieldsPanel, json: jsonPanel }[state.tab]?.() ?? []));
	panel.scrollTop = scroll;
}

function blockPanel() {
	const node = state.sel;
	if (!node || !listOf(node))
		return [
			h("h2", {}, "No block selected"),
			h("p", { class: "help" }, "Click a block on the page to change it. Use Insert block to add one after the selected block."),
			h("p", { class: "help" }, "Every part of the page is a block: text, columns, boxes, tables, write-in fields and image slots."),
		];
	const spec = state.schema.nodes[node.type];
	const out = [h("h2", {}, TYPE_LABEL[node.type] ?? node.type)];
	const owner = ownerOf(node);
	const parentBlock = owner && typeof owner === "object" && owner.type !== "doc" ? (owner.type === "column" ? ownerOf(owner) : owner) : null;
	if (parentBlock && listOf(parentBlock))
		out.push(h("div", { class: "btnrow" }, h("button", { type: "button", class: "btn btn-small", onclick: () => select(parentBlock) }, `Select the ${TYPE_LABEL[parentBlock.type]?.toLowerCase() ?? parentBlock.type} around it`)));
	const form = h("div", { class: "row-form" });
	for (const [k, aspec] of Object.entries(spec.attrs)) {
		if (k === "columns" || (node.type === "table" && k === "source")) continue;
		form.append(
			...formRow(
				ATTR_LABEL[k] ?? k,
				attrControl(aspec, node.attrs?.[k], (v) => {
					node.attrs = { ...(node.attrs ?? {}), [k]: v };
					changed();
				}),
			),
		);
	}
	if (form.childElementCount) out.push(form);
	if (node.type === "columns") out.push(...columnsEditor(node));
	if (node.type === "table") out.push(...tableEditor(node));
	return out;
}

function columnsEditor(node) {
	const count = h("select", {
		class: "control",
		onchange: () => {
			const n = Number(count.value);
			while (node.content.length < n) node.content.push({ type: "column", attrs: { width: 1 }, content: [] });
			if (node.content.length > n) {
				const dropped = node.content.slice(n).some((c) => c.content.length);
				if (dropped && !confirm("The removed columns hold blocks. Delete them?")) return renderPanel();
				node.content.length = n;
			}
			changed();
		},
	}, ...[2, 3, 4].map((n) => h("option", { value: n, selected: n === node.content.length }, String(n))));
	const form = h("div", { class: "row-form" }, ...formRow("Columns", count));
	node.content.forEach((col, i) => {
		form.append(...formRow(`Column ${i + 1} width`, attrControl(state.schema.nodes.column.attrs.width, col.attrs?.width, (v) => ((col.attrs = { ...(col.attrs ?? {}), width: v }), changed()))));
		form.append(...formRow(`Column ${i + 1} align`, attrControl(state.schema.nodes.column.attrs.align, col.attrs?.align, (v) => ((col.attrs = { ...(col.attrs ?? {}), align: v }), changed()))));
	});
	return [h("h3", {}, "Columns"), form];
}

function tableEditor(node) {
	const a = node.attrs;
	const cols = a.columns;
	const rows = node.content;
	const out = [h("h3", {}, "Table columns")];
	cols.forEach((c, ci) => {
		const set = (k, v) => {
			const before = c.type;
			if (v === undefined) delete c[k];
			else c[k] = v;
			if (k === "type") {
				if (v === "formula" && !c.formula) {
					const left = cols.slice(0, ci).filter((x) => x.type === "money" || x.type === "number" || x.type === "formula");
					c.formula = left.length ? `${left[left.length - 1].id} * 12` : "0";
					c.format = "money";
				}
				if (v !== "formula") {
					delete c.formula;
					delete c.format;
				}
				for (const r of rows) {
					const cell = r.content[ci];
					if (!cell) continue;
					if (v !== "text") delete cell.content;
					if (v !== "money" && v !== "number" && cell.attrs) delete cell.attrs.value;
					if (v !== "check" && cell.attrs) delete cell.attrs.checked;
					if (cell.attrs && !Object.keys(cell.attrs).length) delete cell.attrs;
				}
				if (before !== v) changed();
				return;
			}
			changed();
		};
		const card = h(
			"div",
			{ class: "colcard" },
			h(
				"div",
				{ class: "head" },
				`Column ${ci + 1}`,
				h("button", {
					type: "button",
					class: "btn btn-small btn-danger",
					disabled: cols.length < 2,
					onclick: () => {
						cols.splice(ci, 1);
						for (const r of rows) r.content.splice(ci, 1);
						changed();
					},
				}, "Remove"),
			),
			h("label", { class: "full" }, "Label", attrControl({ type: "string" }, c.label, (v) => set("label", v))),
			h("label", {}, "Type", attrControl(state.schema.nodes.table.attrs.columns.of.props.type, c.type, (v) => set("type", v))),
			h("label", {}, "Width (pt, 0 = fill)", attrControl({ type: "number", min: 0 }, c.width, (v) => set("width", v))),
			h("label", {}, "Id", attrControl({ type: "string" }, c.id, (v) => set("id", v))),
			h("label", {}, "Align", attrControl({ type: "enum", values: ["left", "center", "right"] }, c.align ?? "left", (v) => set("align", v))),
			c.type === "formula" ? h("label", { class: "full" }, "Formula, from the columns to the left", attrControl({ type: "string" }, c.formula, (v) => set("formula", v))) : null,
			c.type === "formula" ? h("label", {}, "Format", attrControl({ type: "enum", values: ["money", "number"] }, c.format ?? "number", (v) => set("format", v))) : null,
		);
		out.push(card);
	});
	out.push(
		h("div", { class: "btnrow" }, h("button", {
			type: "button",
			class: "btn btn-small",
			onclick: () => {
				let n = cols.length + 1;
				while (cols.some((c) => c.id === `col_${n}`)) n += 1;
				cols.push({ id: `col_${n}`, label: `Column ${n}`, type: "text", width: 0 });
				for (const r of rows) r.content.push({ type: "cell" });
				changed();
			},
		}, "Add column")),
	);

	out.push(h("h3", {}, "Rows"));
	const ri = state.selRow;
	const row = ri !== null ? rows[ri] : null;
	const role = row?.attrs?.role ?? "item";
	const insertRow = (r, at) => {
		rows.splice(at, 0, r);
		state.selRow = at;
		changed();
	};
	const afterSel = () => (ri === null ? rows.length : ri + 1);
	const btns = h("div", { class: "btnrow" });
	if (a.style === "ledger") {
		btns.append(
			h("button", {
				type: "button",
				class: "btn btn-small",
				onclick: () => {
					// A line item goes after the selected row, inside its category; never after a subtotal or a total.
					let at = afterSel();
					if (row && role !== "item" && role !== "group") at = ri;
					if (ri === null) {
						const sub = rows.findLastIndex((r) => r.attrs?.role === "subtotal");
						at = sub >= 0 ? sub : rows.length;
					}
					insertRow(rowOf(cols, "item", "Line item"), at);
				},
			}, "Add line item"),
			h("button", {
				type: "button",
				class: "btn btn-small",
				onclick: () => {
					const total = rows.findIndex((r) => r.attrs?.role === "total");
					const at = total >= 0 ? total : rows.length;
					rows.splice(at, 0, rowOf(cols, "group", "New category", "add"), rowOf(cols, "item", "Line item"), rowOf(cols, "subtotal", "Category total"));
					state.selRow = at + 1;
					changed();
				},
			}, "Add category"),
			h("button", { type: "button", class: "btn btn-small", onclick: () => insertRow(rowOf(cols, "total", "Grand total"), rows.length) }, "Add total row"),
		);
	} else btns.append(h("button", { type: "button", class: "btn btn-small", onclick: () => insertRow(rowOf(cols), afterSel()) }, "Add row"));
	out.push(btns);
	if (row) {
		const f = h("div", { class: "row-form" });
		f.append(h("span", {}, "Selected"), h("strong", {}, `Row ${ri + 1}`));
		if (a.style === "ledger") {
			f.append(...formRow("Row role", attrControl(state.schema.nodes.row.attrs.role, role, (v) => {
				row.attrs = { ...(row.attrs ?? {}), role: v };
				if (v !== "group") delete row.attrs.sign;
				else row.attrs.sign = row.attrs.sign ?? "add";
				if (v !== "item") for (const c of row.content) if (c.attrs) delete c.attrs.value;
				if (row.attrs.role === "item") delete row.attrs.role;
				if (!Object.keys(row.attrs).length) delete row.attrs;
				changed();
			})));
			if (role === "group")
				f.append(...formRow("Category sign", attrControl(state.schema.nodes.row.attrs.sign, row.attrs?.sign, (v) => ((row.attrs.sign = v), changed()))));
		}
		out.push(f);
		out.push(
			h(
				"div",
				{ class: "btnrow" },
				h("button", { type: "button", class: "btn btn-small", disabled: ri === 0, onclick: () => ([rows[ri - 1], rows[ri]] = [rows[ri], rows[ri - 1]], (state.selRow = ri - 1), changed()) }, "Move row up"),
				h("button", { type: "button", class: "btn btn-small", disabled: ri === rows.length - 1, onclick: () => ([rows[ri + 1], rows[ri]] = [rows[ri], rows[ri + 1]], (state.selRow = ri + 1), changed()) }, "Move row down"),
				h("button", { type: "button", class: "btn btn-small btn-danger", onclick: () => (rows.splice(ri, 1), (state.selRow = null), changed()) }, "Delete row"),
			),
		);
	} else out.push(h("p", { class: "help" }, "Click a row on the page to move, delete or change it."));
	return out;
}

const PRESETS = [
	{ label: "Letter document", apply: (pg) => Object.assign(pg, { size: "letter", orientation: "portrait", margin: { top: 40, right: 40, bottom: 56, left: 40 }, tile: null }) },
	{ label: "4 cards per Letter sheet", apply: (pg) => Object.assign(pg, { size: "letter", orientation: "portrait", margin: { top: 0, right: 0, bottom: 0, left: 0 }, tile: { across: 2, down: 2, padding: 14, cutMarks: true } }) },
	{ label: "Landscape sheet", apply: (pg) => Object.assign(pg, { size: "letter", orientation: "landscape", margin: { top: 36, right: 36, bottom: 36, left: 36 }, tile: null }) },
];

function pagePanel() {
	const doc = state.doc;
	const pg = doc.page;
	const S = state.schema;
	const set = (fn) => (v) => {
		fn(v);
		changed();
	};
	const box = pageBox(pg, S);
	const tb = tileBox(pg, S);
	const out = [h("h2", {}, "Page setup")];
	out.push(h("p", { class: "help" }, `${Math.round(box.width)} x ${Math.round(box.height)} pt. ${pg.tile ? `Each tile is ${Math.round(tb.width)} x ${Math.round(tb.height)} pt; the body repeats in every tile.` : `The content box is ${Math.round(tb.width)} x ${Math.round(tb.height)} pt.`}`));
	out.push(h("div", { class: "btnrow" }, ...PRESETS.map((p) => h("button", { type: "button", class: "btn btn-small", onclick: () => (p.apply(pg), delete pg.width, delete pg.height, changed()) }, p.label))));
	const f = h("div", { class: "row-form" });
	f.append(...formRow("Size", attrControl(S.page.size, pg.size, set((v) => {
		pg.size = v;
		if (v === "custom") Object.assign(pg, { width: pg.width ?? 612, height: pg.height ?? 792 });
		else (delete pg.width, delete pg.height);
	}))));
	if (pg.size === "custom") {
		f.append(...formRow("Width (pt)", attrControl(S.page.width, pg.width, set((v) => (pg.width = v)))));
		f.append(...formRow("Height (pt)", attrControl(S.page.height, pg.height, set((v) => (pg.height = v)))));
	}
	f.append(...formRow("Orientation", attrControl(S.page.orientation, pg.orientation, set((v) => (pg.orientation = v)))));
	for (const side of ["top", "right", "bottom", "left"]) f.append(...formRow(`Margin ${side} (pt)`, attrControl(S.page.margin.props[side], pg.margin[side], set((v) => (pg.margin[side] = v)))));
	out.push(f);

	out.push(h("h3", {}, "Tiles (cards, labels)"));
	const tf = h("div", { class: "row-form" });
	tf.append(...formRow("Repeat in tiles", attrControl({ type: "bool" }, !!pg.tile, set((v) => (pg.tile = v ? { across: 2, down: 2, padding: 14, cutMarks: true } : null)))));
	if (pg.tile) {
		const tp = S.page.tile.props;
		tf.append(...formRow("Across", attrControl(tp.across, pg.tile.across, set((v) => (pg.tile.across = v)))));
		tf.append(...formRow("Down", attrControl(tp.down, pg.tile.down, set((v) => (pg.tile.down = v)))));
		tf.append(...formRow("Tile padding (pt)", attrControl(tp.padding, pg.tile.padding, set((v) => (pg.tile.padding = v)))));
		tf.append(...formRow("Cut marks", attrControl(tp.cutMarks, pg.tile.cutMarks, set((v) => (pg.tile.cutMarks = v)))));
	}
	out.push(tf);

	out.push(h("h3", {}, "Header and footer"));
	const hf = h("div", { class: "row-form" });
	for (const name of ["header", "footer"]) {
		hf.append(...formRow(name === "header" ? "Header" : "Footer", attrControl({ type: "bool" }, !!pg[name], set((v) => (pg[name] = v ? { pages: "all", content: [p("", { style: "small" })] } : null)))));
		if (pg[name]) hf.append(...formRow(`${name === "header" ? "Header" : "Footer"} on`, attrControl(S.region.pages, pg[name].pages, set((v) => (pg[name].pages = v)))));
	}
	out.push(hf);
	out.push(h("p", { class: "help" }, "Click the header or footer on the first page to edit it. A page number can go only there."));
	if (pg.header || pg.footer)
		out.push(
			h("div", { class: "btnrow" }, h("button", {
				type: "button",
				class: "btn btn-small",
				onclick: () => {
					const target = pg.footer ?? pg.header;
					const para = target.content.find((n) => n.type === "paragraph") ?? (target.content.push(p("", { style: "small" })), target.content[target.content.length - 1]);
					para.content.push({ type: "pageNumber", attrs: { format: "page-of-total" } });
					changed();
				},
			}, `Add a page number to the ${pg.footer ? "footer" : "header"}`)),
		);

	out.push(h("h3", {}, "Document"));
	const df = h("div", { class: "row-form" });
	df.append(...formRow("Class", attrControl(S.envelope.class, doc.class, set((v) => (doc.class = v)))));
	for (const fmt of ["pdf", "docx", "xlsx"])
		df.append(...formRow(`Export ${fmt.toUpperCase()}`, attrControl({ type: "bool" }, doc.exports.includes(fmt), set((v) => (doc.exports = v ? [...new Set([...doc.exports, fmt])] : doc.exports.filter((x) => x !== fmt))))));
	out.push(df);
	if (doc.class === "formal/legal") out.push(h("p", { class: "help" }, "A formal or legal document always prints “Template, not legal advice” in the footer. It is not content, so no edit removes it."));
	return out;
}

function fieldsPanel() {
	const doc = state.doc;
	const isDoc = doc.kind === "document";
	const out = [
		h("h2", {}, "Merge fields"),
		h("p", { class: "help" }, isDoc ? "A document keeps the values it was made with. Change a value here; Preview shows it." : "A template declares its fields and a sample value. A document made from it fills them from the church."),
	];
	doc.fields.forEach((f, i) => {
		const card = h(
			"div",
			{ class: "colcard" },
			h("div", { class: "head" }, h("span", {}, f.label, h("span", { style: { fontWeight: 400, color: "var(--ui-muted)" } }, `  {${f.key}}`)), h("button", { type: "button", class: "btn btn-small btn-danger", onclick: () => (doc.fields.splice(i, 1), doc.data && delete doc.data[f.key], changed()) }, "Remove")),
			h("label", { class: "full" }, "Label", attrControl({ type: "string" }, f.label, (v) => ((f.label = v), changed()))),
			isDoc
				? h("label", { class: "full" }, "Value in this document", attrControl({ type: "string" }, doc.data?.[f.key] ?? "", (v) => {
						doc.data = doc.data ?? {};
						if (v === "") delete doc.data[f.key];
						else doc.data[f.key] = v;
						changed();
					}))
				: h("label", { class: "full" }, "Sample value", attrControl({ type: "string" }, typeof f.sample === "string" ? f.sample : "", (v) => ((f.sample = v), changed()))),
			h("span", { class: "full", style: { color: "var(--ui-muted)" } }, `Source: ${f.source ?? "typed by the church"}${f.fallback !== undefined ? `. Fallback: ${f.fallback || "(blank)"}` : ""}`),
		);
		out.push(card);
	});
	const label = h("input", { class: "control", placeholder: "Field label, for example Meeting place", "aria-label": "New field label" });
	out.push(
		h("h3", {}, "Add a field"),
		label,
		h("div", { class: "btnrow" }, h("button", {
			type: "button",
			class: "btn btn-small",
			onclick: () => {
				const name = label.value.trim();
				if (!name) return toast("Type a label for the field.");
				let key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1") || "field";
				for (let n = 2; doc.fields.some((f) => f.key === key); n++) key = `${key.replace(/_\d+$/, "")}_${n}`;
				doc.fields.push({ key, label: name, type: "text", source: null, sample: "" });
				changed();
			},
		}, "Add field")),
	);
	return out;
}

function jsonPanel() {
	const json = serialized();
	const result = validate(state.doc, state.schema);
	return [
		h("h2", {}, "Serialized document"),
		h("p", { class: "help" }, result.ok ? "Valid against schema.json and format.js, the same check that node validate.mjs runs." : `${result.errors.length} problem${result.errors.length === 1 ? "" : "s"} against schema.json:`),
		result.ok ? null : h("ul", { class: "problems" }, ...result.errors.map((e) => h("li", {}, e))),
		h(
			"div",
			{ class: "btnrow" },
			h("button", { type: "button", class: "btn btn-small btn-primary", onclick: download }, "Download JSON"),
			h("button", { type: "button", class: "btn btn-small", onclick: () => navigator.clipboard?.writeText(json).then(() => toast("Copied.")) }, "Copy"),
		),
		h("pre", { class: "json", tabindex: "0", "aria-label": "Document JSON" }, json),
	];
}

// ------------------------------------------------------------------ chrome, open, save, fork

const serialized = () => `${JSON.stringify(state.doc, null, "\t")}\n`;

function renderValidity() {
	const result = validate(state.doc, state.schema);
	const el = $("#validity");
	el.className = `validity ${result.ok ? "ok" : "bad"}`;
	el.textContent = result.ok ? "Valid" : `${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}`;
	el.title = result.ok ? "The document passes the format validator. Click to see the JSON." : result.errors.join("\n");
	return result;
}

function renderChrome() {
	const doc = state.doc;
	$("#kind").textContent =
		doc.kind === "template" ? `Template · ${doc.id} v${doc.version}` : doc.origin ? `Document · from ${doc.origin.template} v${doc.origin.version}` : "Document · blank";
	if (document.activeElement !== $("#title")) $("#title").value = doc.title;
	for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
	for (const b of document.querySelectorAll("[data-brand]")) b.setAttribute("aria-pressed", String(b.dataset.brand === state.brand));
	$("#preview-banner").hidden = state.mode !== "preview";
	for (const el of document.querySelectorAll(".toolbar .tb, #blockstyle, #insert-field, #insert-btn")) el.disabled = state.mode !== "edit";
	const fieldSel = $("#insert-field");
	fieldSel.replaceChildren(h("option", { value: "" }, "Insert field"), ...doc.fields.filter((f) => f.type !== "list").map((f) => h("option", { value: f.key }, f.label)));
	renderValidity();
	renderOpenList();
}

function renderOpenList() {
	const sel = $("#open");
	const saved = Object.keys(localStorage).filter((k) => k.startsWith(SAVED_PREFIX));
	sel.replaceChildren(
		h("option", { value: "" }, "Open…"),
		h("optgroup", { label: "Example templates" }, ...EXAMPLES.map((e) => h("option", { value: `example:${e.stem}` }, e.label))),
		saved.length ? h("optgroup", { label: "Saved in this browser" }, ...saved.map((k) => h("option", { value: `saved:${k}` }, k.slice(SAVED_PREFIX.length)))) : null,
	);
	sel.value = "";
}

function setDoc(doc, { mode } = {}) {
	state.doc = doc;
	state.sel = null;
	state.selRow = null;
	if (mode) state.mode = mode;
	render();
	renderPanel();
}

async function openExample(stem) {
	const doc = structuredClone(state.templates[stem]);
	setDoc(doc);
	history.replaceState(null, "", `?open=${stem}${state.mode === "preview" ? "&mode=preview" : ""}`);
}

function save() {
	const result = validate(state.doc, state.schema);
	localStorage.setItem(SAVED_PREFIX + state.doc.id, serialized());
	renderOpenList();
	toast(result.ok ? `Saved “${state.doc.title}”. It passes the validator.` : `Saved with ${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}. See the JSON tab.`);
}

function download() {
	const blob = new Blob([serialized()], { type: "application/json" });
	const a = h("a", { href: URL.createObjectURL(blob), download: `${state.doc.id}.json` });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function forkDialog() {
	const dialog = $("#dialog");
	dialog.replaceChildren(
		h("h2", {}, "New document from a template"),
		h("p", { class: "help" }, "The document is a full copy. It records the template version it came from and never changes when the template changes. You can change or delete anything in it."),
		h(
			"div",
			{ class: "choices" },
			...EXAMPLES.map((e) =>
				h("button", {
					type: "button",
					onclick: async () => {
						dialog.close();
						const t = state.templates[e.stem];
						const data = Object.fromEntries(t.fields.filter((f) => typeof f.sample === "string").map((f) => [f.key, f.sample]));
						const doc = await forkTemplate(t, { id: `${t.id}-${Date.now().toString(36)}`, data });
						setDoc(doc);
						toast(`New document from ${t.id} v${t.version}.`);
					},
				}, h("strong", {}, state.templates[e.stem].title), h("span", { class: "hint", style: { display: "block", color: "var(--ui-muted)", fontSize: "12px" } }, state.templates[e.stem].description ?? "")),
			),
		),
		h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel")),
	);
	dialog.showModal();
}

function clearDialog() {
	const dialog = $("#dialog");
	dialog.replaceChildren(
		h("h2", {}, "Delete all content?"),
		h("p", { class: "help" }, "This deletes every block, the header and the footer. The page setup and the fields stay. A formal or legal document still prints “Template, not legal advice”."),
		h(
			"div",
			{ class: "actions" },
			h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"),
			h("button", {
				type: "button",
				class: "btn btn-primary",
				style: { background: "var(--ui-danger)", borderColor: "var(--ui-danger)" },
				onclick: () => {
					dialog.close();
					state.doc.body.content = [];
					state.doc.page.header = null;
					state.doc.page.footer = null;
					state.sel = null;
					changed();
					toast("All content deleted.");
				},
			}, "Delete all content"),
		),
	);
	dialog.showModal();
}

let toastTimer = 0;
function toast(msg) {
	const t = $("#toast");
	t.textContent = msg;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ------------------------------------------------------------------ wiring

function wire() {
	$("#open").addEventListener("change", (e) => {
		const v = e.target.value;
		if (v.startsWith("example:")) openExample(v.slice(8));
		else if (v.startsWith("saved:")) setDoc(JSON.parse(localStorage.getItem(v.slice(6))));
	});
	$("#new-blank").addEventListener("click", () => {
		setDoc(blankDocument(`untitled-${Date.now().toString(36)}`), { mode: "edit" });
		state.tab = "page";
		renderPanel();
	});
	$("#new-fork").addEventListener("click", forkDialog);
	$("#clear").addEventListener("click", clearDialog);
	$("#save").addEventListener("click", save);
	$("#validity").addEventListener("click", () => ((state.tab = "json"), renderPanel()));
	$("#title").addEventListener("input", (e) => {
		state.doc.title = e.target.value;
		changed({ soft: true });
	});
	for (const b of document.querySelectorAll("[data-mode]"))
		b.addEventListener("click", () => {
			state.mode = b.dataset.mode;
			render();
		});
	for (const b of document.querySelectorAll("[data-brand]"))
		b.addEventListener("click", () => {
			state.brand = b.dataset.brand;
			render();
		});
	for (const b of document.querySelectorAll(".tabs button"))
		b.addEventListener("click", () => {
			state.tab = b.dataset.tab;
			renderPanel();
		});
	for (const b of document.querySelectorAll("[data-mark]")) {
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", () => applyMark(b.dataset.mark));
	}
	$("#insert-field").addEventListener("change", (e) => {
		if (e.target.value) insertField(e.target.value);
		e.target.value = "";
	});
	$("#blockstyle").addEventListener("change", (e) => {
		const n = textNodeForStyle();
		const v = e.target.value;
		if (!n || !v) {
			toast("Click in a paragraph or heading first.");
			syncStyleSelect();
			return;
		}
		const [kind, arg] = v.split(":");
		if (kind === "p") {
			n.type = "paragraph";
			n.attrs = { ...(n.attrs?.align ? { align: n.attrs.align } : {}), style: arg };
		} else {
			n.type = "heading";
			n.attrs = { level: Number(arg), ...(Number(arg) === 2 ? { numbered: !!n.attrs?.numbered } : {}), ...(n.attrs?.align ? { align: n.attrs.align } : {}) };
		}
		focusLater(n, "end");
		changed();
	});
	$("#insert-btn").addEventListener("click", () => {
		if ($("#insert-menu").hidden) {
			state.insertInto = null;
			openInsertMenu();
		} else closeInsertMenu();
	});
	document.addEventListener("mousedown", (e) => {
		if (!e.target.closest(".menu-wrap") && !e.target.closest(".add-here")) closeInsertMenu();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeInsertMenu();
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
			e.preventDefault();
			save();
		}
	});
	$("#move-up").addEventListener("click", () => moveSelected(-1));
	$("#move-down").addEventListener("click", () => moveSelected(1));
	$("#delete-block").addEventListener("click", deleteSelected);
	$("#canvas").addEventListener("mousedown", (e) => {
		if (state.mode !== "edit" || e.target.closest(".add-here")) return;
		const blk = e.target.closest(".blk[data-id]");
		if (!blk) return;
		const node = byId.get(blk.dataset.id);
		const tr = e.target.closest("tr[data-row]");
		const row = tr && blk.dataset.type === "table" ? Number(tr.dataset.row) : null;
		if (node !== state.sel || row !== state.selRow) {
			state.tab = "block";
			select(node, row, true);
		}
	});
	document.addEventListener("selectionchange", () => {
		const sel = getSelection();
		if (!sel.rangeCount) return;
		const node = sel.anchorNode;
		const el = node && (node.nodeType === 1 ? node : node.parentElement)?.closest?.("#canvas [contenteditable='true']");
		if (!el) return;
		state.lastRange = sel.getRangeAt(0).cloneRange();
		state.lastEditable = el;
		state.lastCaret = saveCaret();
		syncStyleSelect();
	});
	window.addEventListener("resize", fitCanvas);
}

async function boot() {
	const get = (url) => fetch(url).then((r) => {
		if (!r.ok) throw new Error(`${url}: ${r.status}`);
		return r.json();
	});
	state.schema = await get("../schema.json");
	const docs = await Promise.all(EXAMPLES.map((e) => get(`../examples/${e.stem}.json`)));
	EXAMPLES.forEach((e, i) => (state.templates[e.stem] = docs[i]));
	wire();
	const params = new URLSearchParams(location.search);
	if (params.get("mode") === "preview") state.mode = "preview";
	if (params.get("brand") === "church") state.brand = "church";
	const stem = params.get("open");
	if (stem === "blank") setDoc(blankDocument("untitled"));
	else await openExample(state.templates[stem] ? stem : EXAMPLES[0].stem);
	await document.fonts.ready;
	render();
}

boot().catch((e) => {
	document.body.prepend(h("p", { style: { color: "#a52a3f", padding: "16px" } }, `The prototype could not start: ${e.message}. Serve the approach-a folder with a static server; see README.md.`));
});
