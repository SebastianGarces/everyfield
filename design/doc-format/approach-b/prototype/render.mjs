// The read-only renderer of the prototype: format data to HTML pages. It stands in for the production Forme (PDF) and
// DOCX renderers: it walks the same tree, resolves the same fields and brand roles and paginates block by block.
// One CSS pixel is one PDF point inside a page; the preview scales the whole sheet to fit its panel.
import { computeLedger, pageBox, sheetBox } from "../format/model.mjs";

export const esc = (value) =>
	String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The sample church brand kit, and the neutral Everyfield fallback when no kit is set. */
export const BRAND_KIT = {
	name: "Grace Harbor Church",
	legalName: "Grace Harbor Church, Inc.",
	tagline: "A church for the harbor district. Come as you are.",
	contact: "Grace Harbor Church  ·  (555) 014-2200  ·  hello@graceharbor.church",
	primary: "#1F4E5F",
	accent: "#C9822B",
};
const NEUTRAL = { primary: "#181D19", accent: "#026B40", tagline: "A new church plant. You are welcome here." };

export function tones(brandOn) {
	const primary = brandOn ? BRAND_KIT.primary : NEUTRAL.primary;
	const accent = brandOn ? BRAND_KIT.accent : NEUTRAL.accent;
	return { none: "transparent", primary, accent, muted: "#EDF0F4", ink: "#181D19" };
}

/** Black or white text on a fill, by WCAG relative luminance: the brand rule "a fill picks its own text color". */
export function onColor(hex) {
	if (!hex || hex === "transparent") return "inherit";
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return (1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#FFFFFF" : "#181D19");
}

/** The value a field shows: its value, or "[label]" in lower case when it is empty. Never an invented name. */
export function fieldText(doc, key) {
	const field = doc.fields.find((f) => f.key === key);
	if (!field) return `[${key}]`;
	return field.value ? field.value : `[${field.label.toLowerCase()}]`;
}

const markOpen = { bold: "<strong>", italic: "<em>", underline: "<u>" };
const markClose = { bold: "</strong>", italic: "</em>", underline: "</u>" };

/** Inline nodes to HTML. In the editor the atoms are not editable, so the caret moves over them as one unit. */
export function inlineHTML(content, doc, opts = {}) {
	const atom = opts.edit ? ' contenteditable="false"' : "";
	return (content ?? [])
		.map((node) => {
			if (node.type === "text") {
				let html = esc(node.text);
				for (const mark of [...(node.marks ?? [])].reverse()) {
					if (mark.type === "link") html = `<a href="${esc(mark.href)}">${html}</a>`;
					else html = `${markOpen[mark.type]}${html}${markClose[mark.type]}`;
				}
				return html;
			}
			if (node.type === "field") {
				const empty = !doc.fields.find((f) => f.key === node.key)?.value;
				return `<span class="i-field${empty ? " is-empty" : ""}" data-inline="field" data-key="${esc(node.key)}"${atom}>${esc(fieldText(doc, node.key))}</span>`;
			}
			if (node.type === "prompt")
				return `<span class="i-prompt" data-inline="prompt" data-text="${esc(node.text)}"${atom}>[${esc(node.text)}]</span>`;
			if (node.type === "badge")
				return `<span class="i-badge" data-inline="badge" data-text="${esc(node.text)}" data-tone="${esc(node.tone ?? "accent")}" style="background:${opts.tones?.[node.tone ?? "accent"] ?? "#026B40"};color:${onColor(opts.tones?.[node.tone ?? "accent"] ?? "#026B40")}"${atom}>${esc(node.text)}</span>`;
			if (node.type === "pageNumber")
				return `<span class="i-page" data-inline="pageNumber"${atom}>${opts.page ? `Page ${opts.page} of ${opts.pages}` : "Page 1 of 1"}</span>`;
			return "";
		})
		.join("");
}

const share = (items) => {
	const sum = items.reduce((s, i) => s + i.width, 0);
	return items.map((i) => `${((i.width / sum) * 100).toFixed(3)}%`);
};
export const money = (n) =>
	n === null || n === undefined ? "" : (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const FILL_LABEL = { checkbox: "", signature: "Sign here", date: "", text: "", number: "", email: "", phone: "" };

function fillBox(kind, value) {
	if (kind === "checkbox") return `<span class="d-check" role="img" aria-label="Check box"></span>`;
	return `<span class="d-fillbox d-fill-${kind}">${value ? esc(value) : `<span class="d-fill-hint">${FILL_LABEL[kind] ?? ""}</span>`}</span>`;
}

function brandHTML(block, doc, ctx) {
	const w = block.width;
	const h = block.height;
	const align = block.align ?? "start";
	const style = `${w ? `width:${w}px;` : ""}${h ? `height:${h}px;` : ""}`;
	const name = ctx.brandOn ? BRAND_KIT.name : fieldText(doc, "church.name");
	if (block.element === "logo") {
		if (ctx.brandOn)
			return `<div class="d-logo d-align-${align}" style="${style}" role="img" aria-label="${esc(BRAND_KIT.name)} logo"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" fill="${ctx.tones.accent}"/><path d="M8 25c4-3 8-3 12 0s8 3 12 0" stroke="#fff" stroke-width="3" fill="none"/><path d="M20 8v12M14 14h12" stroke="#fff" stroke-width="3"/></svg><span>${esc(BRAND_KIT.name)}</span></div>`;
		return `<div class="d-logo is-neutral d-align-${align}" style="${style}"><span>${esc(name)}</span></div>`;
	}
	if (block.element === "name") return `<div class="d-brand-name d-align-${align}">${esc(name)}</div>`;
	if (block.element === "tagline")
		return `<div class="d-tagline d-align-${align}">${esc(ctx.brandOn ? BRAND_KIT.tagline : NEUTRAL.tagline)}</div>`;
	if (block.element === "contact") {
		const pastor = doc.fields.find((f) => f.key === "pastor.name")?.value;
		const text = ctx.brandOn ? BRAND_KIT.contact : pastor ? `Return this card to ${pastor}.` : "";
		return `<div class="d-contact d-align-${align}">${esc(text)}</div>`;
	}
	if (block.element === "photo")
		return ctx.brandOn
			? `<div class="d-photo d-align-${align}" style="${style}" role="img" aria-label="Photo of the church"></div>`
			: `<div class="d-photo is-empty" style="${style}"></div>`;
	return "";
}

function tableHTML(block, doc, ctx) {
	const widths = share(block.columns);
	const header = block.header ?? "plain";
	const fill = ctx.tones[header] ?? "transparent";
	const head =
		header === "none"
			? ""
			: `<thead><tr>${block.columns
					.map(
						(c) =>
							`<th class="d-a-${c.align ?? "start"}" style="background:${header === "plain" ? "transparent" : fill};color:${header === "plain" ? "inherit" : onColor(fill)}">${esc(c.label)}</th>`,
					)
					.join("")}</tr></thead>`;
	const rowCount = block.repeat ? block.repeat.count : block.rows.length;
	const rows = [];
	for (let r = 0; r < rowCount; r++) {
		const row = block.repeat ? block.rows[0] : block.rows[r];
		const cells = row.cells
			.map((cell, c) => {
				const align = block.columns[c]?.align ?? "start";
				if (cell.type === "counter") return `<td class="d-a-center d-counter">${r + 1}</td>`;
				if (cell.type === "fill") return `<td class="d-a-${align} d-cell-fill">${cell.kind === "checkbox" ? fillBox("checkbox") : ""}</td>`;
				if (cell.type === "data") return `<td class="d-a-${align} d-cell-data">[${esc(cell.path)}]</td>`;
				return `<td class="d-a-${align}">${inlineHTML(cell.content, doc, ctx)}</td>`;
			})
			.join("");
		rows.push(`<tr class="${block.zebra && r % 2 ? "is-zebra" : ""}" style="${block.rowHeight ? `height:${block.rowHeight}px` : ""}">${cells}</tr>`);
	}
	const source = block.repeat?.source
		? `<div class="d-note">Rows come from ${esc(block.repeat.source)}; ${block.repeat.count} blank rows print when it is empty.</div>`
		: "";
	return `<table class="d-table d-rules-${block.rules ?? "rows"}"><colgroup>${widths.map((w) => `<col style="width:${w}">`).join("")}</colgroup>${head}<tbody>${rows.join("")}</tbody></table>${source}`;
}

export function ledgerHTML(block) {
	const sums = computeLedger(block);
	const n = block.periods.count;
	const label = (i) => block.periods.label.replace("{n}", String(i + 1));
	const heads = Array.from({ length: n }, (_, i) => `<th class="d-a-end">${esc(label(i))}</th>`).join("");
	const rows = [];
	const span = n + 2;
	for (const group of block.groups) {
		rows.push(`<tr class="d-l-section"><td colspan="${span}">${esc(group.label)}</td></tr>`);
		for (const line of group.lines) {
			const cells = Array.from({ length: n }, (_, i) => `<td class="d-l-input d-a-end">${money(line.amounts[i])}</td>`).join("");
			rows.push(`<tr><td>${esc(line.label)}</td>${cells}<td class="d-a-end d-l-sum" data-sum="${esc(line.id)}">${money(sums.lines[line.id].total)}</td></tr>`);
		}
		const g = sums.groups[group.id];
		rows.push(
			`<tr class="d-l-total"><td>${esc(group.subtotal)}</td>${g.periods.map((p) => `<td class="d-a-end">${money(p)}</td>`).join("")}<td class="d-a-end" data-sum="${esc(group.id)}">${money(g.total)}</td></tr>`,
		);
	}
	for (const result of block.results) {
		const r = sums.results[result.id];
		rows.push(
			`<tr class="d-l-total d-l-result"><td>${esc(result.label)}</td>${r.periods.map((p) => `<td class="d-a-end">${money(p)}</td>`).join("")}<td class="d-a-end" data-sum="${esc(result.id)}">${money(r.total)}</td></tr>`,
		);
	}
	return `<table class="d-ledger${n > 6 ? " is-wide" : ""}"><thead><tr><th>${esc(block.labelColumn ?? "Category")}</th>${heads}<th class="d-a-end">${esc(block.total.label)}</th></tr></thead><tbody>${rows.join("")}</tbody></table><div class="d-note">Sheet “${esc(block.sheet)}” in the XLSX export. Totals are live formulas there.</div>`;
}

function summaryHTML(block, doc) {
	let ledger = null;
	for (const b of doc.body) if (b.type === "ledger" && b.id === block.ledger) ledger = b;
	if (!ledger) return `<div class="d-note">The summary reads ledger “${esc(block.ledger)}”, which is not in this document.</div>`;
	const sums = computeLedger(ledger);
	const n = ledger.periods.count;
	const cols = block.show;
	const head = cols.map((c) => `<th class="d-a-end">${c === "total" ? esc(ledger.total.label) : "Monthly average"}</th>`).join("");
	const cell = (total) => cols.map((c) => `<td class="d-a-end">${money(c === "total" ? total : Math.round((total / n) * 100) / 100)}</td>`).join("");
	const rows = [];
	for (const group of ledger.groups) {
		rows.push(`<tr class="d-l-section"><td colspan="${cols.length + 1}">${esc(group.label)}</td></tr>`);
		for (const line of group.lines) rows.push(`<tr><td>${esc(line.label)}</td>${cell(sums.lines[line.id].total)}</tr>`);
		rows.push(`<tr class="d-l-total"><td>${esc(group.subtotal)}</td>${cell(sums.groups[group.id].total)}</tr>`);
	}
	for (const result of ledger.results)
		rows.push(`<tr class="d-l-total d-l-result"><td>${esc(result.label)}</td>${cell(sums.results[result.id].total)}</tr>`);
	return `<table class="d-ledger d-summary"><thead><tr><th>${esc(ledger.labelColumn ?? "Category")}</th>${head}</tr></thead><tbody>${rows.join("")}</tbody></table><div class="d-note">Sheet “${esc(block.sheet)}” in the XLSX export, with formulas that read “${esc(ledger.sheet)}”.</div>`;
}

/** One block to HTML. `ctx.numbers` counts numbered headings across the document. */
export function blockHTML(block, doc, ctx) {
	const inl = (content) => inlineHTML(content, doc, ctx);
	switch (block.type) {
		case "heading": {
			const number = block.numbered ? `<span class="d-num">${++ctx.numbers}.</span> ` : "";
			return `<div class="d-blk d-h d-h${block.level}">${number}${inl(block.content)}</div>`;
		}
		case "paragraph":
			return `<div class="d-blk d-p d-v-${block.variant ?? "body"} d-align-${block.align ?? "start"}">${inl(block.content) || "&nbsp;"}</div>`;
		case "quote":
			return `<blockquote class="d-blk d-quote">${inl(block.content)}</blockquote>`;
		case "list": {
			const tag = block.style === "number" ? "ol" : "ul";
			const items = block.items
				.map((item) => `<li>${block.style === "check" ? fillBox("checkbox") : ""}<span>${inl(item.content)}</span></li>`)
				.join("");
			return `<div class="d-blk"><${tag} class="d-list d-list-${block.style}">${items}</${tag}></div>`;
		}
		case "divider":
			return `<div class="d-blk d-divider d-w-${block.weight}" style="--rule:${ctx.tones[block.tone ?? "ink"] ?? "#181D19"}"></div>`;
		case "spacer":
			return `<div class="d-spacer" style="height:${block.size}px"></div>`;
		case "pageBreak":
			return `<div class="d-pagebreak"></div>`;
		case "slot": {
			const inner = block.blocks.map((b) => blockHTML(b, doc, ctx)).join("");
			return `<div class="d-blk d-slot"><div class="d-slot-label">${esc(block.label)}</div>${
				inner || `<div class="d-slot-blank">Not filled in yet. Your church or its sending network adds this text. It stays blank until then.</div>`
			}</div>`;
		}
		case "brand":
			return `<div class="d-blk">${brandHTML(block, doc, ctx)}</div>`;
		case "fillRow": {
			const widths = share(block.cells);
			const cells = block.cells
				.map((cell, i) => {
					const value = cell.field ? doc.fields.find((f) => f.key === cell.field)?.value : null;
					return `<div class="d-fill" style="flex-basis:${widths[i]}"><span class="d-fill-label">${esc(cell.label)}</span>${fillBox(cell.kind, value)}</div>`;
				})
				.join("");
			return `<div class="d-blk d-fillrow">${cells}</div>`;
		}
		case "columns": {
			const widths = share(block.columns);
			const gap = block.gap ?? 12;
			const cols = block.columns
				.map((col, i) => `<div class="d-col" style="flex-basis:calc(${widths[i]} - ${gap}px)">${col.blocks.map((b) => blockHTML(b, doc, ctx)).join("")}</div>`)
				.join("");
			return `<div class="d-blk d-columns d-valign-${block.valign ?? "top"}" style="gap:${gap}px">${cols}</div>`;
		}
		case "box": {
			const bg = ctx.tones[block.tone] ?? "transparent";
			const style = `background:${bg};color:${onColor(bg)};padding:${block.padding ?? 8}px;${block.minHeight ? `min-height:${block.minHeight}px;` : ""}${block.border ? "border:1px solid #181D19;" : ""}`;
			return `<div class="d-blk"><div class="d-box${block.tone === "none" ? "" : " is-filled"}" style="${style}">${block.blocks.map((b) => blockHTML(b, doc, ctx)).join("")}</div></div>`;
		}
		case "table":
			return `<div class="d-blk">${tableHTML(block, doc, ctx)}</div>`;
		case "ledger":
			return `<div class="d-blk">${ledgerHTML(block)}</div>`;
		case "ledgerSummary":
			return `<div class="d-blk">${summaryHTML(block, doc)}</div>`;
		default:
			return "";
	}
}

/** The page class that scales type to the page: a card or a half-letter page sets smaller type than a Letter page. */
const scaleClass = (box) => (box.width < 420 ? "is-small" : "");

/**
 * Paginates the body block by block into trim pages, then imposes them onto sheets. A block that does not fit in the
 * space left on a page moves to the next page; a page break starts a new page. Returns the sheet elements.
 */
export function renderPages(doc, ctx, measureHost) {
	const box = pageBox(doc.page);
	const m = doc.page.margins;
	const contentWidth = box.width - m.left - m.right;
	const contentHeight = box.height - m.top - m.bottom;
	const pageCtx = (extra) => ({ ...ctx, numbers: 0, ...extra });

	// Measure the header, the footer and each top-level body block at the content width.
	measureHost.innerHTML = "";
	const probe = document.createElement("div");
	probe.className = `d-page-content ${scaleClass(box)}`;
	probe.style.width = `${contentWidth}px`;
	measureHost.append(probe);
	const measure = (html) => {
		probe.innerHTML = `<div class="d-measure">${html}</div>`;
		return probe.firstElementChild.getBoundingClientRect().height;
	};
	const headerHTML = (c) => (doc.header ?? []).map((b) => blockHTML(b, doc, c)).join("");
	const legal = doc.notices.includes("template-not-legal-advice");
	const notice = legal
		? `<div class="d-notice" title="Required notice: printed on every page of a document made from a formal or legal template">Template, not legal advice</div>`
		: "";
	const footerHTML = (c) => (doc.footer ?? []).map((b) => blockHTML(b, doc, c)).join("") + notice;
	const headerH = doc.header?.length ? measure(headerHTML(pageCtx({ page: 1, pages: 1 }))) + 8 : 0;
	const footerH = doc.footer?.length || legal ? measure(footerHTML(pageCtx({ page: 1, pages: 1 }))) + 8 : 0;
	const room = contentHeight - headerH - footerH;
	const items = doc.body.map((block) => ({
		block,
		height: block.type === "pageBreak" ? 0 : measure(blockHTML(block, doc, pageCtx({}))),
	}));
	measureHost.innerHTML = "";

	const pages = [[]];
	let used = 0;
	const overflow = new Set();
	for (const item of items) {
		if (item.block.type === "pageBreak") {
			pages.push([]);
			used = 0;
			continue;
		}
		if (used + item.height > room + 0.5 && pages.at(-1).length) {
			pages.push([]);
			used = 0;
		}
		if (item.height > room + 0.5) overflow.add(pages.length - 1);
		pages.at(-1).push(item);
		used += item.height;
	}
	const total = pages.length;
	const pageHTML = (bodyHTML, i) => {
		const c = pageCtx({ page: i + 1, pages: total });
		return `<div class="d-page ${scaleClass(box)}" style="width:${box.width}px;height:${box.height}px;padding:${m.top}px ${m.right}px ${m.bottom}px ${m.left}px">
			<div class="d-page-margins" aria-hidden="true" style="inset:${m.top}px ${m.right}px ${m.bottom}px ${m.left}px"></div>
			<div class="d-page-content" style="width:${contentWidth}px;height:${contentHeight}px">
				${headerH ? `<div class="d-header">${headerHTML(c)}</div>` : ""}
				<div class="d-body" style="height:${room}px">${bodyHTML}</div>
				${footerH ? `<div class="d-footer">${footerHTML(c)}</div>` : ""}
			</div>
			${overflow.has(i) ? `<div class="d-overflow">A block on this page is taller than one page. The PDF splits it; this preview cuts it.</div>` : ""}
		</div>`;
	};
	// Numbered headings continue their count from one page to the next.
	let count = 0;
	const pageHTMLs = pages.map((list, i) => {
		const c = pageCtx({ page: i + 1, pages: total, numbers: count });
		const html = list.map((x) => blockHTML(x.block, doc, c)).join("");
		count = c.numbers;
		return pageHTML(html, i);
	});

	const sheet = sheetBox(doc.page);
	if (!doc.page.imposition) return { sheets: pageHTMLs.map((html) => ({ html, width: box.width, height: box.height })), pages: total, sheet: null };
	if (!sheet) return { sheets: [], pages: total, sheet: null, error: "These pages do not fit on the sheet. Lower the copies across or down." };
	const { across, down, cutMarks } = doc.page.imposition;
	const offX = (sheet.width - across * box.width) / 2;
	const offY = (sheet.height - down * box.height) / 2;
	const sheets = pageHTMLs.map((html) => {
		const copies = [];
		for (let y = 0; y < down; y++)
			for (let x = 0; x < across; x++)
				copies.push(`<div class="d-copy" style="left:${offX + x * box.width}px;top:${offY + y * box.height}px">${html}</div>`);
		const cuts = [];
		if (cutMarks) {
			for (let x = 0; x <= across; x++)
				cuts.push(`<div class="d-cut d-cut-v" style="left:${offX + x * box.width}px"></div>`);
			for (let y = 0; y <= down; y++)
				cuts.push(`<div class="d-cut d-cut-h" style="top:${offY + y * box.height}px"></div>`);
		}
		return {
			html: `<div class="d-sheet" style="width:${sheet.width}px;height:${sheet.height}px">${copies.join("")}${cuts.join("")}</div>`,
			width: sheet.width,
			height: sheet.height,
		};
	});
	return { sheets, pages: total, sheet };
}
