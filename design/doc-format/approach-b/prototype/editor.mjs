// The block editor of the prototype. It edits the format tree directly: each block is a DOM view with a bar of
// controls; text runs are contenteditable and parse back into inline nodes on each input. No editor library.
import { computeLedger } from "../format/model.mjs";
import { blockHTML, esc, inlineHTML, money } from "./render.mjs";

const el = (tag, attrs = {}, ...children) => {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === false) continue;
		if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (key === "class") node.className = value;
		else if (key === "html") node.innerHTML = value;
		else if (key === "value") node.value = value;
		else if (key === "checked") node.checked = value;
		else node.setAttribute(key, value === true ? "" : value);
	}
	for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
	return node;
};
export const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

// ---------- inline parsing

const sameMarks = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
const addMark = (marks, mark) => (marks.some((m) => m.type === mark.type) ? marks : [...marks, mark]);
const MARK_ORDER = ["bold", "italic", "underline", "link"];

/** A contenteditable element back to inline nodes. Adjacent text with the same marks merges into one node. */
export function parseInline(root) {
	const out = [];
	const pushText = (text, marks) => {
		text = text.replace(/ /g, " ").replace(/​/g, "");
		if (!text) return;
		const sorted = [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
		const last = out.at(-1);
		if (last?.type === "text" && sameMarks(last.marks, sorted.length ? sorted : undefined)) last.text += text;
		else out.push(sorted.length ? { type: "text", text, marks: sorted } : { type: "text", text });
	};
	const walk = (node, marks) => {
		for (const child of node.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				pushText(child.data, marks);
				continue;
			}
			if (child.nodeType !== Node.ELEMENT_NODE) continue;
			const kind = child.dataset?.inline;
			if (kind === "field") out.push({ type: "field", key: child.dataset.key });
			else if (kind === "prompt") out.push({ type: "prompt", text: child.dataset.text });
			else if (kind === "badge") out.push({ type: "badge", text: child.dataset.text, tone: child.dataset.tone });
			else if (kind === "pageNumber") out.push({ type: "pageNumber" });
			if (kind) continue;
			if (child.tagName === "BR") {
				pushText(" ", marks);
				continue;
			}
			let next = marks;
			const weight = child.style?.fontWeight;
			if (child.tagName === "B" || child.tagName === "STRONG" || weight === "bold" || Number(weight) >= 600)
				next = addMark(next, { type: "bold" });
			if (child.tagName === "I" || child.tagName === "EM" || child.style?.fontStyle === "italic")
				next = addMark(next, { type: "italic" });
			if (child.tagName === "U" || child.style?.textDecorationLine === "underline") next = addMark(next, { type: "underline" });
			if (child.tagName === "A" && /^(https?:\/\/|mailto:|tel:)/.test(child.getAttribute("href") ?? ""))
				next = addMark(next, { type: "link", href: child.getAttribute("href") });
			walk(child, next);
		}
	};
	walk(root, []);
	const tail = out.at(-1);
	if (tail?.type === "text" && !tail.marks) {
		tail.text = tail.text.replace(/\s+$/, (s) => (s.length > 1 ? " " : s));
		if (!tail.text.trim() && out.length === 1) out.pop();
	}
	return out;
}

// The text range the inline toolbar acts on. A toolbar click keeps it, because the buttons cancel mousedown.
let lastRange = null;
document.addEventListener("selectionchange", () => {
	const sel = document.getSelection();
	if (!sel.rangeCount) return;
	const range = sel.getRangeAt(0);
	const host = range.startContainer.parentElement?.closest?.("[data-editable]") ?? (range.startContainer.closest?.("[data-editable]"));
	if (host) lastRange = { range: range.cloneRange(), host };
});

/** Inserts an atom (field, prompt or badge) at the caret of the last edited text, then saves the text. */
export function insertAtom(html) {
	if (!lastRange || !document.contains(lastRange.host)) return false;
	const { range, host } = lastRange;
	const holder = document.createElement("span");
	holder.innerHTML = html;
	const atom = holder.firstElementChild;
	range.deleteContents();
	range.insertNode(atom);
	const space = document.createTextNode(" ");
	atom.after(space);
	const sel = document.getSelection();
	const after = document.createRange();
	after.setStart(space, 1);
	sel.removeAllRanges();
	sel.addRange(after);
	host.focus();
	host.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
}

/** Runs a formatting command on the last edited text. */
export function format(command, value) {
	if (!lastRange || !document.contains(lastRange.host)) return;
	const sel = document.getSelection();
	lastRange.host.focus();
	sel.removeAllRanges();
	sel.addRange(lastRange.range);
	document.execCommand(command, false, value);
	lastRange.host.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------- block factories

const textCell = () => ({ type: "text", content: [] });
export const BLOCK_MENU = [
	{ label: "Heading", make: () => ({ type: "heading", id: newId("h"), level: 2, content: [] }) },
	{ label: "Paragraph", make: () => ({ type: "paragraph", id: newId("p"), content: [] }) },
	{ label: "Bulleted list", make: () => ({ type: "list", id: newId("list"), style: "bullet", items: [{ id: newId("li"), content: [] }] }) },
	{ label: "Numbered list", make: () => ({ type: "list", id: newId("list"), style: "number", items: [{ id: newId("li"), content: [] }] }) },
	{ label: "Checklist", make: () => ({ type: "list", id: newId("list"), style: "check", items: [{ id: newId("li"), content: [] }] }) },
	{ label: "Quote", make: () => ({ type: "quote", id: newId("q"), content: [] }) },
	{ label: "Divider", make: () => ({ type: "divider", id: newId("rule"), weight: "rule", tone: "ink" }) },
	{ label: "Spacer", make: () => ({ type: "spacer", id: newId("space"), size: 12 }) },
	{ label: "Page break", topOnly: true, make: () => ({ type: "pageBreak", id: newId("break") }) },
	{ label: "Slot to fill in", make: () => ({ type: "slot", id: newId("slot"), label: "Section to fill in", blocks: [] }) },
	{ label: "Brand element", make: () => ({ type: "brand", id: newId("brand"), element: "logo", width: 150, height: 34 }) },
	{
		label: "Write-in row",
		make: () => ({
			type: "fillRow",
			id: newId("fill"),
			cells: [
				{ label: "Name", kind: "text", width: 6 },
				{ label: "Date", kind: "date", width: 6 },
			],
		}),
	},
	{
		label: "Columns",
		make: () => ({
			type: "columns",
			id: newId("cols"),
			columns: [
				{ width: 6, blocks: [] },
				{ width: 6, blocks: [] },
			],
		}),
	},
	{ label: "Box", make: () => ({ type: "box", id: newId("box"), tone: "muted", padding: 10, blocks: [] }) },
	{
		label: "Table",
		make: () => ({
			type: "table",
			id: newId("table"),
			columns: [1, 2, 3].map((n) => ({ label: `Column ${n}`, width: 4 })),
			header: "plain",
			rules: "grid",
			rows: [0, 1].map(() => ({ id: newId("row"), cells: [textCell(), textCell(), textCell()] })),
		}),
	},
	{
		label: "Repeating table",
		make: () => ({
			type: "table",
			id: newId("table"),
			columns: [
				{ label: "#", width: 1, align: "center" },
				{ label: "Name", width: 6 },
				{ label: "Email", width: 5 },
			],
			header: "accent",
			zebra: true,
			rules: "rows",
			rowHeight: 25,
			repeat: { count: 10 },
			rows: [{ id: newId("row"), cells: [{ type: "counter" }, { type: "fill", kind: "text" }, { type: "fill", kind: "email" }] }],
		}),
	},
	{
		label: "Budget ledger",
		topOnly: true,
		make: (doc) => {
			const used = new Set(doc.body.flatMap((b) => (b.sheet ? [b.sheet] : [])));
			let sheet = "Budget";
			for (let n = 2; used.has(sheet); n++) sheet = `Budget ${n}`;
			const g = (label, line) => ({ id: newId("group"), label, subtotal: `Total ${label.toLowerCase()}`, lines: [{ id: newId("line"), label: line, amounts: Array(12).fill(null) }] });
			const income = g("Income", "Tithes and offerings");
			const expenses = g("Expenses", "Rent or facility");
			return {
				type: "ledger",
				id: newId("ledger"),
				sheet,
				currency: "USD",
				labelColumn: "Category",
				periods: { count: 12, label: "Month {n}" },
				total: { label: "Year total", rule: "sum" },
				groups: [income, expenses],
				results: [{ id: newId("result"), label: "Net (income minus expenses)", plus: [income.id], minus: [expenses.id] }],
			};
		},
	},
	{
		label: "Ledger summary",
		topOnly: true,
		needs: (doc) => doc.body.some((b) => b.type === "ledger"),
		make: (doc) => {
			const ledger = doc.body.find((b) => b.type === "ledger");
			const used = new Set(doc.body.flatMap((b) => (b.sheet ? [b.sheet] : [])));
			let sheet = "Summary";
			for (let n = 2; used.has(sheet); n++) sheet = `Summary ${n}`;
			return { type: "ledgerSummary", id: newId("summary"), sheet, ledger: ledger.id, show: ["total", "average"] };
		},
	},
];

const TYPE_LABEL = {
	heading: "Heading",
	paragraph: "Paragraph",
	list: "List",
	quote: "Quote",
	divider: "Divider",
	spacer: "Spacer",
	pageBreak: "Page break",
	slot: "Slot",
	brand: "Brand",
	fillRow: "Write-in row",
	columns: "Columns",
	box: "Box",
	table: "Table",
	ledger: "Budget ledger",
	ledgerSummary: "Ledger summary",
};
const FILL_KINDS = ["text", "date", "number", "checkbox", "signature", "email", "phone"];
const KIND_LABEL = { text: "Write-in", date: "Date", number: "Number", checkbox: "Check box", signature: "Signature", email: "Email", phone: "Phone" };

// ---------- small controls

const select = (label, value, options, onChange) =>
	el(
		"label",
		{ class: "ctl" },
		el("span", {}, label),
		el(
			"select",
			{ onchange: (e) => onChange(e.target.value) },
			options.map(([v, text]) => el("option", { value: v, selected: String(v) === String(value) }, text)),
		),
	);
const number = (label, value, min, max, onChange, step = 1) =>
	el(
		"label",
		{ class: "ctl" },
		el("span", {}, label),
		el("input", { type: "number", value, min, max, step, inputmode: "decimal", onchange: (e) => onChange(Number(e.target.value)) }),
	);
const check = (label, value, onChange) =>
	el("label", { class: "ctl ctl-check" }, el("input", { type: "checkbox", checked: value, onchange: (e) => onChange(e.target.checked) }), el("span", {}, label));
const text = (label, value, onInput, attrs = {}) =>
	el("label", { class: "ctl ctl-text" }, el("span", {}, label), el("input", { type: "text", value, oninput: (e) => onInput(e.target.value), ...attrs }));
const button = (label, onClick, attrs = {}) =>
	el("button", { type: "button", class: "btn-mini", onclick: (e) => (e.stopPropagation(), onClick(e)), ...attrs }, label);
const TONES = [
	["none", "None"],
	["primary", "Primary"],
	["accent", "Accent"],
	["muted", "Muted"],
	["ink", "Ink"],
];

/**
 * Renders the editor for a document into `host`. `api.changed(structural)` reports an edit: a structural change
 * re-renders the editor; a text change only refreshes the preview, so the caret stays where it is.
 */
export function renderEditor(host, doc, api) {
	const { readOnly } = api;
	const ctx = { tones: api.tones, brandOn: api.brandOn, numbers: 0 };
	const scroll = host.scrollTop;
	host.innerHTML = "";

	const changed = (structural) => api.changed(structural);
	const editable = (content, set, opts = {}) => {
		const node = el(opts.tag ?? "div", {
			class: `ed-text ${opts.class ?? ""}`,
			"data-editable": "",
			contenteditable: readOnly ? "false" : "true",
			role: readOnly ? null : "textbox",
			"aria-label": opts.label ?? "Text",
			"data-placeholder": opts.placeholder ?? "Type here",
			html: inlineHTML(content, doc, { edit: true, tones: ctx.tones }),
		});
		if (readOnly) return node;
		node.addEventListener("input", () => {
			set(parseInline(node));
			changed(false);
		});
		node.addEventListener("paste", (e) => {
			e.preventDefault();
			document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " "));
		});
		node.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				opts.onEnter?.();
			}
			if (e.key === "Backspace" && !node.textContent && opts.onEmptyBackspace) {
				e.preventDefault();
				opts.onEmptyBackspace();
			}
			if ((e.metaKey || e.ctrlKey) && ["b", "i", "u"].includes(e.key)) {
				e.preventDefault();
				format({ b: "bold", i: "italic", u: "underline" }[e.key]);
			}
		});
		return node;
	};

	const focusLater = (id) => api.focus(id);

	/** The list a block sits in, its index and the actions that change it. */
	const actions = (list, index, topLevel) => ({
		up: index > 0 && (() => ([list[index - 1], list[index]] = [list[index], list[index - 1]], changed(true))),
		down: index < list.length - 1 && (() => ([list[index], list[index + 1]] = [list[index + 1], list[index]], changed(true))),
		remove: () => (list.splice(index, 1), changed(true)),
		insertAfter: (block) => (list.splice(index + 1, 0, block), api.select(block.id), changed(true), focusLater(block.id)),
		topLevel,
	});

	const insertMenu = (onPick, topLevel, labelText) => {
		const menu = el("div", { class: "ins-menu", role: "menu", hidden: true });
		for (const item of BLOCK_MENU) {
			if (item.topOnly && !topLevel) continue;
			if (item.needs && !item.needs(doc)) continue;
			menu.append(
				el(
					"button",
					{
						type: "button",
						role: "menuitem",
						class: "ins-item",
						onclick: (e) => {
							e.stopPropagation();
							menu.hidden = true;
							onPick(item.make(doc));
						},
					},
					item.label,
				),
			);
		}
		const toggle = el(
			"button",
			{
				type: "button",
				class: "btn-add",
				"aria-haspopup": "menu",
				onclick: (e) => {
					e.stopPropagation();
					document.querySelectorAll(".ins-menu").forEach((m) => m !== menu && (m.hidden = true));
					menu.hidden = !menu.hidden;
					toggle.setAttribute("aria-expanded", String(!menu.hidden));
				},
			},
			labelText,
		);
		return el("div", { class: "ins" }, toggle, menu);
	};

	const blockList = (list, topLevel, emptyLabel = "Add block") => {
		const wrap = el("div", { class: "ed-list" });
		list.forEach((block, i) => wrap.append(blockView(block, actions(list, i, topLevel))));
		if (!readOnly)
			wrap.append(
				insertMenu((block) => (list.push(block), api.select(block.id), changed(true), focusLater(block.id)), topLevel, `+ ${emptyLabel}`),
			);
		return wrap;
	};

	function bar(block, act, controls) {
		if (readOnly) return null;
		return el(
			"div",
			{ class: "blk-bar", role: "toolbar", "aria-label": `${TYPE_LABEL[block.type]} controls` },
			el("span", { class: "blk-type" }, TYPE_LABEL[block.type]),
			el("div", { class: "blk-ctls" }, controls),
			el(
				"div",
				{ class: "blk-acts" },
				button("↑", act.up || (() => {}), { "aria-label": "Move up", disabled: !act.up }),
				button("↓", act.down || (() => {}), { "aria-label": "Move down", disabled: !act.down }),
				button("✕", act.remove, { "aria-label": `Delete ${TYPE_LABEL[block.type].toLowerCase()}`, class: "btn-mini is-danger" }),
				insertMenu(act.insertAfter, act.topLevel, "+ Below"),
			),
		);
	}

	function blockView(block, act) {
		const wrap = el("div", {
			class: `blk blk-${block.type}${api.selected === block.id ? " is-selected" : ""}`,
			"data-id": block.id,
		});
		const select_ = (e) => {
			if (e.target.closest(".blk") !== wrap) return;
			api.select(block.id);
			document.querySelectorAll(".blk.is-selected").forEach((n) => n !== wrap && n.classList.remove("is-selected"));
			wrap.classList.add("is-selected");
		};
		wrap.addEventListener("click", select_);
		wrap.addEventListener("focusin", select_);
		const { controls, body } = views[block.type](block, act);
		const b = bar(block, act, controls ?? []);
		if (b) wrap.append(b);
		wrap.append(body);
		return wrap;
	}

	const newParagraphAfter = (act) => () => act.insertAfter({ type: "paragraph", id: newId("p"), content: [] });

	const views = {
		heading: (block, act) => ({
			controls: [
				select("Level", block.level, [[1, "Title"], [2, "Heading"], [3, "Subheading"]], (v) => ((block.level = Number(v)), changed(true))),
				check("Numbered", !!block.numbered, (v) => (v ? (block.numbered = true) : delete block.numbered, changed(true))),
			],
			body: el(
				"div",
				{ class: `d-h d-h${block.level}` },
				block.numbered ? el("span", { class: "d-num" }, `${++ctx.numbers}. `) : null,
				editable(block.content, (c) => (block.content = c), {
					label: "Heading text",
					placeholder: "Heading",
					tag: "span",
					onEnter: newParagraphAfter(act),
					onEmptyBackspace: act.remove,
				}),
			),
		}),
		paragraph: (block, act) => ({
			controls: [
				select("Style", block.variant ?? "body", [["body", "Body"], ["lead", "Lead"], ["note", "Note"], ["kicker", "Kicker"]], (v) => (v === "body" ? delete block.variant : (block.variant = v), changed(true))),
				select("Align", block.align ?? "start", [["start", "Left"], ["center", "Center"], ["end", "Right"]], (v) => (v === "start" ? delete block.align : (block.align = v), changed(true))),
			],
			body: editable(block.content, (c) => (block.content = c), {
				class: `d-p d-v-${block.variant ?? "body"} d-align-${block.align ?? "start"}`,
				label: "Paragraph text",
				placeholder: "Type text. Use the toolbar to add a field.",
				onEnter: newParagraphAfter(act),
				onEmptyBackspace: act.remove,
			}),
		}),
		quote: (block, act) => ({
			body: editable(block.content, (c) => (block.content = c), { class: "d-quote", label: "Quote text", onEnter: newParagraphAfter(act) }),
		}),
		list: (block) => {
			const tag = block.style === "number" ? "ol" : "ul";
			const items = block.items.map((item, i) =>
				el(
					"li",
					{},
					block.style === "check" ? el("span", { class: "d-check", "aria-hidden": "true" }) : null,
					editable(item.content, (c) => (item.content = c), {
						tag: "span",
						label: `List item ${i + 1}`,
						placeholder: "List item",
						onEnter: () => {
							const next = { id: newId("li"), content: [] };
							block.items.splice(i + 1, 0, next);
							changed(true);
							api.focusItem(block.id, i + 1);
						},
						onEmptyBackspace: () => {
							if (block.items.length === 1) return;
							block.items.splice(i, 1);
							changed(true);
							api.focusItem(block.id, Math.max(0, i - 1));
						},
					}),
				),
			);
			return {
				controls: [select("Style", block.style, [["bullet", "Bullets"], ["number", "Numbers"], ["check", "Check boxes"]], (v) => ((block.style = v), changed(true)))],
				body: el(tag, { class: `d-list d-list-${block.style}` }, items),
			};
		},
		divider: (block) => ({
			controls: [
				select("Weight", block.weight, [["hair", "Hairline"], ["rule", "Rule"], ["bar", "Bar"]], (v) => ((block.weight = v), changed(true))),
				select("Color", block.tone ?? "ink", TONES.slice(1), (v) => ((block.tone = v), changed(true))),
			],
			body: el("div", { html: blockHTML(block, doc, ctx) }),
		}),
		spacer: (block) => ({
			controls: [number("Height (pt)", block.size, 1, 400, (v) => ((block.size = v), changed(true)))],
			body: el("div", { class: "ed-spacer", style: `height:${block.size}px` }),
		}),
		pageBreak: () => ({ body: el("div", { class: "ed-pagebreak" }, "Page break") }),
		slot: (block) => ({
			controls: [text("Label", block.label, (v) => ((block.label = v || "Section"), changed(false)))],
			body: el("div", { class: "d-slot" }, el("div", { class: "d-slot-label" }, block.label), blockList(block.blocks, false, "Add text")),
		}),
		brand: (block) => ({
			controls: [
				select("Shows", block.element, [["logo", "Logo"], ["name", "Church name"], ["tagline", "Tagline"], ["contact", "Contact line"], ["photo", "Photo"]], (v) => ((block.element = v), changed(true))),
				...(block.element === "logo" || block.element === "photo"
					? [
							number("W", block.width ?? 150, 8, 600, (v) => ((block.width = v), changed(true))),
							number("H", block.height ?? 34, 8, 600, (v) => ((block.height = v), changed(true))),
						]
					: []),
			],
			body: el("div", { html: blockHTML(block, doc, ctx) }),
		}),
		fillRow: (block) => ({
			controls: [button("+ Box", () => (block.cells.length < 6 && block.cells.push({ label: "Label", kind: "text", width: 4 }), changed(true)))],
			body: el(
				"div",
				{ class: "d-fillrow" },
				block.cells.map((cell, i) =>
					el(
						"div",
						{ class: "d-fill", style: `flex-basis:${(cell.width / block.cells.reduce((s, c) => s + c.width, 0)) * 100}%` },
						readOnly
							? el("span", { class: "d-fill-label" }, cell.label)
							: el("input", { class: "d-fill-label ed-label", value: cell.label, "aria-label": `Box ${i + 1} label`, oninput: (e) => ((cell.label = e.target.value), changed(false)) }),
						el("span", { class: `d-fillbox d-fill-${cell.kind}` }),
						readOnly
							? null
							: el(
									"div",
									{ class: "ed-cellctl" },
									el("select", { "aria-label": `Box ${i + 1} kind`, onchange: (e) => ((cell.kind = e.target.value), changed(true)) }, FILL_KINDS.map((k) => el("option", { value: k, selected: k === cell.kind }, KIND_LABEL[k]))),
									el("input", { type: "number", min: 1, max: 12, value: cell.width, "aria-label": `Box ${i + 1} width`, onchange: (e) => ((cell.width = Math.min(12, Math.max(1, Number(e.target.value) || 1))), changed(true)) }),
									block.cells.length > 1 ? button("✕", () => (block.cells.splice(i, 1), changed(true)), { "aria-label": `Remove box ${i + 1}` }) : null,
								),
					),
				),
			),
		}),
		columns: (block) => ({
			controls: [
				select("Columns", block.columns.length, [[1, "1"], [2, "2"], [3, "3"], [4, "4"]], (v) => {
					const n = Number(v);
					while (block.columns.length < n) block.columns.push({ width: 6, blocks: [] });
					if (block.columns.length > n) {
						const extra = block.columns.splice(n).flatMap((c) => c.blocks);
						block.columns[n - 1].blocks.push(...extra);
					}
					changed(true);
				}),
				...block.columns.map((col, i) => number(`W${i + 1}`, col.width, 1, 12, (v) => ((col.width = Math.min(12, Math.max(1, v))), changed(true)))),
			],
			body: el(
				"div",
				{ class: "d-columns ed-columns" },
				block.columns.map((col) => el("div", { class: "d-col ed-col", style: `flex:${col.width} 1 0` }, blockList(col.blocks, false, "Add"))),
			),
		}),
		box: (block) => {
			const bg = ctx.tones[block.tone] ?? "transparent";
			return {
				controls: [
					select("Fill", block.tone, TONES, (v) => ((block.tone = v), changed(true))),
					number("Padding", block.padding ?? 8, 0, 72, (v) => ((block.padding = v), changed(true))),
					check("Border", !!block.border, (v) => (v ? (block.border = true) : delete block.border, changed(true))),
				],
				body: el(
					"div",
					{ class: `d-box ed-box${block.tone === "none" ? "" : " is-filled"}`, style: `background:${bg};color:${api.onColor(bg)};padding:${block.padding ?? 8}px;${block.minHeight ? `min-height:${block.minHeight}px;` : ""}${block.border ? "border:1px solid #181D19;" : ""}` },
					blockList(block.blocks, false, "Add inside"),
				),
			};
		},
		table: (block) => tableView(block),
		ledger: (block) => ledgerView(block),
		ledgerSummary: (block) => ({
			controls: [
				select("Reads", block.ledger, doc.body.filter((b) => b.type === "ledger").map((b) => [b.id, b.sheet]), (v) => ((block.ledger = v), changed(true))),
				check("Total", block.show.includes("total"), (v) => ((block.show = v ? ["total", ...block.show.filter((s) => s !== "total")] : block.show.filter((s) => s !== "total")), block.show.length || (block.show = ["average"]), changed(true))),
				check("Average", block.show.includes("average"), (v) => ((block.show = v ? [...block.show.filter((s) => s !== "average"), "average"] : block.show.filter((s) => s !== "average")), block.show.length || (block.show = ["total"]), changed(true))),
			],
			body: el("div", { class: "ed-scroll", html: blockHTML(block, doc, ctx) }),
		}),
	};

	function tableView(block) {
		const width = block.columns.length;
		const columnKind = (c) => {
			const cell = block.rows[0].cells[c];
			return cell.type === "counter" ? "counter" : cell.type === "fill" ? cell.kind : cell.type === "data" ? "data" : "content";
		};
		const setColumnKind = (c, kind) => {
			for (const row of block.rows)
				row.cells[c] = kind === "content" ? textCell() : kind === "counter" ? { type: "counter" } : { type: "fill", kind };
			changed(true);
		};
		const kinds = [["content", "Text"], ...FILL_KINDS.map((k) => [k, KIND_LABEL[k]]), ...(block.repeat ? [["counter", "Row number"]] : [])];
		const sum = block.columns.reduce((s, c) => s + c.width, 0);
		const head = el(
			"tr",
			{},
			block.columns.map((col, c) =>
				el(
					"th",
					{ style: `width:${(col.width / sum) * 100}%`, class: `d-a-${col.align ?? "start"}` },
					readOnly ? col.label : el("input", { class: "ed-label", value: col.label, "aria-label": `Column ${c + 1} heading`, oninput: (e) => ((col.label = e.target.value), changed(false)) }),
					readOnly
						? null
						: el(
								"div",
								{ class: "ed-cellctl" },
								el("select", { "aria-label": `Column ${c + 1} kind`, onchange: (e) => setColumnKind(c, e.target.value) }, kinds.map(([v, t]) => el("option", { value: v, selected: v === columnKind(c) }, t))),
								el("input", { type: "number", min: 1, max: 12, value: col.width, "aria-label": `Column ${c + 1} width`, onchange: (e) => ((col.width = Math.min(12, Math.max(1, Number(e.target.value) || 1))), changed(true)) }),
								width > 1 ? button("✕", () => (block.columns.splice(c, 1), block.rows.forEach((r) => r.cells.splice(c, 1)), changed(true)), { "aria-label": `Remove column ${c + 1}` }) : null,
							),
				),
			),
		);
		const cellView = (cell, r, c) => {
			if (cell.type === "counter") return el("td", { class: "d-a-center d-counter" }, "1");
			if (cell.type === "fill") return el("td", { class: "d-cell-fill" }, cell.kind === "checkbox" ? el("span", { class: "d-check" }) : el("span", { class: "ed-hint" }, KIND_LABEL[cell.kind]));
			if (cell.type === "data") return el("td", {}, `[${cell.path}]`);
			return el("td", { class: `d-a-${block.columns[c].align ?? "start"}` }, editable(cell.content, (v) => (cell.content = v), { tag: "div", label: `Row ${r + 1}, column ${c + 1}`, placeholder: "" }));
		};
		const rows = block.rows.map((row, r) =>
			el(
				"tr",
				{ class: block.zebra && r % 2 ? "is-zebra" : "" },
				row.cells.map((cell, c) => cellView(cell, r, c)),
				readOnly || block.repeat
					? null
					: el("td", { class: "ed-rowctl" }, block.rows.length > 1 ? button("✕", () => (block.rows.splice(r, 1), changed(true)), { "aria-label": `Delete row ${r + 1}` }) : null),
			),
		);
		const fill = ctx.tones[block.header ?? "plain"];
		const header = block.header ?? "plain";
		return {
			controls: [
				select("Header", header, [["none", "None"], ["plain", "Plain"], ["primary", "Primary"], ["accent", "Accent"], ["muted", "Muted"]], (v) => ((block.header = v), changed(true))),
				select("Lines", block.rules ?? "rows", [["none", "None"], ["rows", "Rows"], ["grid", "Grid"]], (v) => ((block.rules = v), changed(true))),
				check("Stripes", !!block.zebra, (v) => (v ? (block.zebra = true) : delete block.zebra, changed(true))),
				check("Repeat rows", !!block.repeat, (v) => {
					if (v) {
						block.repeat = { count: Math.max(block.rows.length, 10) };
						block.rows = [block.rows[0]];
					} else {
						delete block.repeat;
						block.rows[0].cells = block.rows[0].cells.map((cell) => (cell.type === "counter" || cell.type === "data" ? textCell() : cell));
					}
					changed(true);
				}),
				block.repeat ? number("Rows", block.repeat.count, 1, 200, (v) => ((block.repeat.count = Math.min(200, Math.max(1, v))), changed(true))) : null,
				button("+ Column", () => {
					if (block.columns.length >= 12) return;
					block.columns.push({ label: `Column ${block.columns.length + 1}`, width: 3 });
					block.rows.forEach((r) => r.cells.push(block.repeat ? { type: "fill", kind: "text" } : textCell()));
					changed(true);
				}),
				block.repeat ? null : button("+ Row", () => (block.rows.push({ id: newId("row"), cells: block.rows[0].cells.map((c) => (c.type === "text" ? textCell() : { ...c })) }), changed(true))),
			],
			body: el(
				"div",
				{ class: "ed-scroll" },
				el(
					"table",
					{ class: `d-table ed-table d-rules-${block.rules ?? "rows"}` },
					el("colgroup", {}, block.columns.map((col) => el("col", { style: `width:${(col.width / sum) * 100}%` })), readOnly || block.repeat ? null : el("col", { style: "width:28px" })),
					header === "none" && readOnly ? null : el("thead", { class: `ed-head-${header}`, style: header === "plain" || header === "none" ? "" : `--head:${fill};--head-text:${api.onColor(fill)}` }, head),
					el("tbody", {}, rows),
				),
				block.repeat ? el("div", { class: "ed-repeat-note" }, `This row prints ${block.repeat.count} times, numbered when a column is set to Row number.`) : null,
			),
		};
	}

	function ledgerView(block) {
		const n = block.periods.count;
		const sums = computeLedger(block);
		const label = (i) => block.periods.label.replace("{n}", String(i + 1));
		const refresh = () => {
			const next = computeLedger(block);
			const all = { ...next.lines, ...next.groups, ...next.results };
			for (const node of body.querySelectorAll("[data-sum]")) node.textContent = money(all[node.dataset.sum]?.total ?? 0);
			for (const node of body.querySelectorAll("[data-p]")) {
				const [id, i] = node.dataset.p.split(":");
				node.textContent = money(all[id]?.periods[Number(i)] ?? 0);
			}
			changed(false);
		};
		const amountInput = (line, i) =>
			el("input", {
				class: "ed-amount",
				type: "text",
				inputmode: "decimal",
				value: line.amounts[i] ?? "",
				"aria-label": `${line.label}, ${label(i)}`,
				disabled: readOnly,
				oninput: (e) => {
					const raw = e.target.value.replace(/[$,\s]/g, "");
					const v = raw === "" ? null : Number(raw);
					line.amounts[i] = Number.isFinite(v) ? v : null;
					refresh();
				},
			});
		const rows = [];
		block.groups.forEach((group, g) => {
			rows.push(
				el(
					"tr",
					{ class: "d-l-section" },
					el(
						"td",
						{ colspan: n + 3, class: "ed-group" },
						readOnly ? group.label : el("input", { class: "ed-label", value: group.label, "aria-label": `Group ${g + 1} name`, oninput: (e) => ((group.label = e.target.value || "Group"), changed(false)) }),
						readOnly ? null : button("+ Line", () => (group.lines.push({ id: newId("line"), label: "New line", amounts: Array(n).fill(null) }), changed(true)), { "aria-label": `Add line to ${group.label}` }),
						readOnly || block.groups.length < 2
							? null
							: button("✕ Group", () => {
									block.groups.splice(g, 1);
									block.results.forEach((r) => ((r.plus = r.plus.filter((x) => x !== group.id)), (r.minus = r.minus.filter((x) => x !== group.id))));
									block.results = block.results.filter((r) => r.plus.length || r.minus.length);
									changed(true);
								}),
					),
				),
			);
			group.lines.forEach((line, l) =>
				rows.push(
					el(
						"tr",
						{},
						el("td", {}, readOnly ? line.label : el("input", { class: "ed-label", value: line.label, "aria-label": `Line ${l + 1} of ${group.label}`, oninput: (e) => {
							line.label = e.target.value || "Line";
							e.target.closest("tr").querySelectorAll(".ed-amount").forEach((input, i) => input.setAttribute("aria-label", `${line.label}, ${label(i)}`));
							changed(false);
						} })),
						Array.from({ length: n }, (_, i) => el("td", { class: "d-l-input" }, amountInput(line, i))),
						el("td", { class: "d-a-end d-l-sum", "data-sum": line.id }, money(sums.lines[line.id].total)),
						el("td", { class: "ed-rowctl" }, readOnly || group.lines.length < 2 ? null : button("✕", () => (group.lines.splice(l, 1), changed(true)), { "aria-label": `Delete ${line.label}` })),
					),
				),
			);
			rows.push(
				el(
					"tr",
					{ class: "d-l-total" },
					el("td", {}, readOnly ? group.subtotal : el("input", { class: "ed-label", value: group.subtotal, "aria-label": `${group.label} total name`, oninput: (e) => ((group.subtotal = e.target.value || "Total"), changed(false)) })),
					Array.from({ length: n }, (_, i) => el("td", { class: "d-a-end", "data-p": `${group.id}:${i}` }, money(sums.groups[group.id].periods[i]))),
					el("td", { class: "d-a-end", "data-sum": group.id }, money(sums.groups[group.id].total)),
					el("td", {}),
				),
			);
		});
		block.results.forEach((result, r) =>
			rows.push(
				el(
					"tr",
					{ class: "d-l-total d-l-result" },
					el(
						"td",
						{},
						readOnly ? result.label : el("input", { class: "ed-label", value: result.label, "aria-label": `Result ${r + 1} name`, oninput: (e) => ((result.label = e.target.value || "Result"), changed(false)) }),
						readOnly
							? null
							: el(
									"div",
									{ class: "ed-result" },
									block.groups.map((group) =>
										select(group.label, result.plus.includes(group.id) ? "plus" : result.minus.includes(group.id) ? "minus" : "off", [["plus", "adds"], ["minus", "subtracts"], ["off", "—"]], (v) => {
											result.plus = result.plus.filter((x) => x !== group.id);
											result.minus = result.minus.filter((x) => x !== group.id);
											if (v === "plus") result.plus.push(group.id);
											if (v === "minus") result.minus.push(group.id);
											if (!result.plus.length && !result.minus.length) result.plus.push(group.id);
											changed(true);
										}),
									),
								),
					),
					Array.from({ length: n }, (_, i) => el("td", { class: "d-a-end", "data-p": `${result.id}:${i}` }, money(sums.results[result.id].periods[i]))),
					el("td", { class: "d-a-end", "data-sum": result.id }, money(sums.results[result.id].total)),
					el("td", { class: "ed-rowctl" }, readOnly ? null : button("✕", () => (block.results.splice(r, 1), changed(true)), { "aria-label": `Delete ${result.label}` })),
				),
			),
		);
		const body = el(
			"div",
			{ class: "ed-scroll" },
			el(
				"table",
				{ class: `d-ledger ed-ledger${n > 6 ? " is-wide" : ""}` },
				el("thead", {}, el("tr", {}, el("th", {}, block.labelColumn ?? "Category"), Array.from({ length: n }, (_, i) => el("th", { class: "d-a-end" }, label(i))), el("th", { class: "d-a-end" }, block.total.label), el("th", {}))),
				el("tbody", {}, rows),
			),
		);
		const setPeriods = (count) => {
			block.periods.count = count;
			if (count === 1) {
				block.periods.label = "Monthly";
				block.total = { label: "Annual", rule: "times", factor: 12 };
			} else {
				if (!block.periods.label.includes("{n}")) block.periods.label = "Month {n}";
				block.total = { label: "Year total", rule: "sum" };
			}
			for (const group of block.groups)
				for (const line of group.lines) line.amounts = Array.from({ length: count }, (_, i) => line.amounts[i] ?? null);
			changed(true);
		};
		return {
			controls: [
				text("Sheet", block.sheet, (v) => ((block.sheet = v.replace(/[[\]:*?/\\']/g, "").slice(0, 31) || "Budget"), changed(false)), { "aria-label": "Sheet name" }),
				select("Periods", n, [[12, "12 months"], [4, "4 quarters"], [1, "Monthly × 12"]], (v) => {
					setPeriods(Number(v));
					if (Number(v) === 4) (block.periods.label = "Quarter {n}"), changed(true);
				}),
				button("+ Group", () => {
					block.groups.push({ id: newId("group"), label: "New group", subtotal: "Total new group", lines: [{ id: newId("line"), label: "New line", amounts: Array(n).fill(null) }] });
					changed(true);
				}),
				button("+ Result", () => {
					block.results.push({ id: newId("result"), label: "Result", plus: [block.groups[0].id], minus: block.groups[1] ? [block.groups[1].id] : [] });
					changed(true);
				}),
			],
			body,
		};
	}

	const canvas = el("div", { class: "ed-canvas" });
	const part = (name, list) =>
		el("section", { class: `ed-part ed-part-${name}`, "aria-label": name[0].toUpperCase() + name.slice(1) }, el("div", { class: "ed-part-label" }, name === "body" ? "Body" : name === "header" ? "Header (every page)" : "Footer (every page)"), blockList(list, name === "body"));
	if (doc.header || !readOnly) {
		doc.header ??= [];
		if (doc.header.length || !readOnly) canvas.append(part("header", doc.header));
	}
	canvas.append(part("body", doc.body));
	if (doc.footer || !readOnly) {
		doc.footer ??= [];
		if (doc.footer.length || !readOnly) canvas.append(part("footer", doc.footer));
	}
	host.append(canvas);
	host.scrollTop = scroll;
}

export { esc };
