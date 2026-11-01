// Everyfield document format, approach C ("owned block tree").
//
// This one module is the machine-readable schema and the only code that knows the format:
//   NODES, MARKS, ENVELOPE  the spec as plain data (types, attributes, allowed children)
//   validate(doc)           structural and semantic checks; returns { ok, errors }
//   evaluate(doc)           the formula engine for typed table cells
//   fork / wipe / resolve   template copy, delete-all and merge-field fill
// It has no dependencies. The prototype imports it in the browser and check.mjs imports it in Node.

export const FORMAT = "everyfield.doc";
export const FORMAT_VERSION = 1;

/** Page sizes in PDF points (72 per inch), portrait width x height. */
export const PAGE_SIZES = {
	letter: [612, 792],
	legal: [612, 1008],
	a4: [595, 842],
	"half-letter": [396, 612],
};
export const CLASSES = ["formal/legal", "outward-facing", "operational"];
/** Where a merge field can take its value from. A field with source null is a write-in blank. */
export const SOURCES = [
	"church.name",
	"church.legal_name",
	"church.tagline",
	"church.address",
	"church.phone",
	"church.email",
	"church.web",
	"pastor.name",
	"meeting.date",
	"meeting.number",
	"today",
];
const FILLS = ["none", "muted", "primary", "accent"];
const TONES = ["muted", "primary", "accent"];
const ID = "^[a-z][a-z0-9-]*$";
const KEY = "^[a-z][a-z0-9_]*$";

const str = (o = {}) => ({ type: "string", ...o });
const num = (o = {}) => ({ type: "number", ...o });
const int = (min, max, dflt) => ({ type: "integer", min, max, default: dflt });
const bool = (dflt) => ({ type: "boolean", default: dflt });
const oneOf = (values, dflt) => ({ type: "enum", values, ...(dflt === undefined ? {} : { default: dflt }) });
const opt = (spec) => ({ ...spec, optional: true });

/** Inline marks. A text node carries a set of these; order in JSON follows MARK_ORDER. */
export const MARKS = {
	bold: { attrs: {}, doc: "Bold weight." },
	italic: { attrs: {}, doc: "Italic." },
	underline: { attrs: {}, doc: "Underline." },
	strike: { attrs: {}, doc: "Strikethrough." },
	link: { attrs: { href: str({ pattern: "^(https?://|mailto:|tel:)", maxLength: 2000 }) }, doc: "A hyperlink." },
	tone: { attrs: { tone: oneOf(TONES) }, doc: "Text color from the theme: muted, primary or accent." },
	caps: { attrs: {}, doc: "Uppercase with letter spacing (kickers, tiles)." },
};
export const MARK_ORDER = ["link", "tone", "caps", "bold", "italic", "underline", "strike"];

/**
 * Node types. `group`: inline nodes live in text runs, block nodes in block containers, part nodes only inside their
 * one parent. `content`: "inline" (text runs), "blocks" (any block), { types, min, max, first } or absent (a leaf).
 */
export const NODES = {
	text: { group: "inline", text: true, attrs: {}, doc: "A run of text with marks." },
	field: {
		group: "inline",
		attrs: {
			key: str({ pattern: KEY }),
			display: oneOf(["inline", "line"], "inline"),
			width: opt(num({ min: 24, max: 600 })),
		},
		doc: "A named value from the envelope's field list. Filled from data, or a labelled write-in blank when empty.",
	},
	checkbox: { group: "inline", attrs: { key: opt(str({ pattern: KEY })) }, doc: "A tick box. Fillable in PDF." },
	hardBreak: { group: "inline", attrs: {}, doc: "A line break inside a block." },

	heading: { group: "block", attrs: { level: int(0, 3, 1) }, content: "inline", doc: "Level 0 is the display title." },
	paragraph: {
		group: "block",
		attrs: { align: oneOf(["left", "center", "right"], "left"), size: oneOf(["small", "body", "large"], "body") },
		content: "inline",
		doc: "A paragraph of text.",
	},
	list: { group: "block", attrs: { ordered: bool(false) }, content: { types: ["listItem"], min: 1 }, doc: "A list." },
	listItem: {
		group: "part",
		attrs: {},
		content: { types: ["paragraph", "list"], min: 1, first: "paragraph" },
		doc: "One list item: a paragraph, then optional nested lists.",
	},
	quote: { group: "block", attrs: {}, content: { types: ["paragraph"], min: 1 }, doc: "A block quote." },
	divider: {
		group: "block",
		attrs: { weight: oneOf(["hairline", "thin", "thick", "bar"], "thin"), tone: oneOf(["ink", ...TONES], "ink") },
		doc: "A horizontal rule. `bar` is the 4 pt accent bar.",
	},
	pageBreak: {
		group: "block",
		topLevel: true,
		attrs: { sheet: opt(str({ minLength: 1, maxLength: 31 })) },
		doc: "Starts a new page. In XLSX it starts a new sheet with this name.",
	},
	slot: {
		group: "block",
		attrs: { id: str({ pattern: ID }), label: str({ minLength: 1, maxLength: 80 }) },
		content: "blocks",
		doc: "A labelled section someone else fills in (for example a statement of faith). Prints a blank box when empty.",
	},
	box: {
		group: "block",
		attrs: {
			fill: oneOf(FILLS, "none"),
			border: oneOf(["none", "thin", "thick"], "none"),
			padding: num({ min: 0, max: 72, default: 8 }),
			minHeight: opt(num({ min: 0, max: 1000 })),
		},
		content: "blocks",
		doc: "A filled or bordered region. Text on a fill takes the fill's contrast color.",
	},
	columns: {
		group: "block",
		attrs: { gap: num({ min: 0, max: 72, default: 12 }), align: oneOf(["top", "center", "bottom"], "top") },
		content: { types: ["column"], min: 2, max: 4 },
		doc: "Side-by-side columns.",
	},
	column: {
		group: "part",
		attrs: { width: num({ min: 1, max: 12, default: 1 }) },
		content: "blocks",
		doc: "One column. Width is a share of the row (1 = one part).",
	},
	table: {
		group: "block",
		attrs: {
			name: opt(str({ pattern: KEY })),
			columns: { type: "columns" },
			headerRows: int(0, 5, 1),
			rules: oneOf(["grid", "rows", "none"], "grid"),
			zebra: bool(false),
			headerFill: oneOf(FILLS, "muted"),
			minRowHeight: opt(num({ min: 0, max: 200 })),
			size: oneOf(["small", "body"], "body"),
			fillable: bool(false),
		},
		content: { types: ["row"], min: 1 },
		doc: "A ruled table with typed cells. `fillable`: each empty body cell becomes a PDF form field.",
	},
	row: { group: "part", attrs: {}, content: { types: ["cell"], min: 1 }, doc: "A table row." },
	cell: {
		group: "part",
		attrs: {
			kind: oneOf(["text", "number", "formula"], "text"),
			value: opt(num({ nullable: true })),
			formula: opt(str({ minLength: 1, maxLength: 500 })),
			name: opt(str({ pattern: KEY })),
			format: oneOf(["plain", "currency", "integer", "percent"], "plain"),
			fill: oneOf(FILLS, "none"),
			align: opt(oneOf(["left", "center", "right"])),
			colspan: opt(int(1, 12)),
		},
		content: "inline",
		doc: "A table cell. text: inline content. number: an input value. formula: computed from other cells.",
	},
	repeat: {
		group: "block",
		attrs: {
			across: int(1, 4, 2),
			down: int(1, 6, 2),
			gap: num({ min: 0, max: 72, default: 0 }),
			padding: num({ min: 0, max: 72, default: 18 }),
			cutMarks: bool(true),
		},
		content: "blocks",
		doc: "Prints its content across x down times on each page: n-up cards, labels, tickets, half sheets.",
	},
	logo: {
		group: "block",
		attrs: { height: num({ min: 12, max: 200, default: 34 }), align: oneOf(["left", "center", "right"], "left") },
		doc: "The church logo from the brand kit, or the church name in the display face when there is none.",
	},
};

/** The template envelope. A template and a document have the same shape; `kind` and `origin` differ. */
export const ENVELOPE = {
	format: { type: "const", value: FORMAT },
	formatVersion: { type: "const", value: FORMAT_VERSION },
	kind: oneOf(["template", "document"]),
	id: str({ pattern: ID, maxLength: 80 }),
	version: int(1, 100000),
	origin: { type: "origin", doc: "null for a template; { template, version } for a document made from one." },
	meta: { type: "object" },
	page: { type: "object" },
	theme: { type: "object" },
	fields: { type: "fields" },
	body: { type: "blocks" },
};
const META = {
	title: str({ minLength: 1, maxLength: 200 }),
	description: opt(str({ maxLength: 500 })),
	class: oneOf(CLASSES),
};
const PAGE = {
	size: oneOf(Object.keys(PAGE_SIZES)),
	orientation: oneOf(["portrait", "landscape"]),
	margins: { type: "margins" },
	footer: opt({ type: "inline" }),
};
const THEME = { numberHeadings: bool(false) };
const FIELD = {
	key: str({ pattern: KEY }),
	label: str({ minLength: 1, maxLength: 80 }),
	source: { type: "source" },
	default: opt(str({ maxLength: 200 })),
	type: oneOf(["text", "date", "number"], "text"),
};

const TEXT_MAX = 20000;
const BLOCKS_MAX = 5000;

// ---------------------------------------------------------------------------------------------------------------
// Validation

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const BAD_TEXT = /[\0]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkAttr(spec, value, at, err) {
	if (value === undefined) {
		if (!spec.optional && spec.default === undefined) err(at, "is required");
		return;
	}
	switch (spec.type) {
		case "string":
			if (typeof value !== "string") return err(at, "must be a string");
			if (spec.minLength !== undefined && value.length < spec.minLength) err(at, `must have at least ${spec.minLength} characters`);
			if (spec.maxLength !== undefined && value.length > spec.maxLength) err(at, `must have at most ${spec.maxLength} characters`);
			if (spec.pattern && !new RegExp(spec.pattern).test(value)) err(at, `must match ${spec.pattern}`);
			return;
		case "number":
			if (value === null && spec.nullable) return;
			if (typeof value !== "number" || !Number.isFinite(value)) return err(at, "must be a number");
			if (spec.min !== undefined && value < spec.min) err(at, `must be at least ${spec.min}`);
			if (spec.max !== undefined && value > spec.max) err(at, `must be at most ${spec.max}`);
			return;
		case "integer":
			if (!Number.isInteger(value)) return err(at, "must be an integer");
			if (spec.min !== undefined && value < spec.min) err(at, `must be at least ${spec.min}`);
			if (spec.max !== undefined && value > spec.max) err(at, `must be at most ${spec.max}`);
			return;
		case "boolean":
			if (typeof value !== "boolean") err(at, "must be true or false");
			return;
		case "enum":
			if (!spec.values.includes(value)) err(at, `must be one of ${spec.values.join(", ")}`);
			return;
		case "const":
			if (value !== spec.value) err(at, `must be ${JSON.stringify(spec.value)}`);
			return;
		case "margins":
			if (!isObj(value)) return err(at, "must be an object");
			for (const side of ["top", "right", "bottom", "left"]) checkAttr(num({ min: 0, max: 144 }), value[side], `${at}.${side}`, err);
			for (const k of Object.keys(value)) if (!["top", "right", "bottom", "left"].includes(k)) err(`${at}.${k}`, "is not a margin");
			return;
		case "columns":
			if (!Array.isArray(value) || value.length < 1 || value.length > 20) return err(at, "must list 1 to 20 columns");
			value.forEach((c, i) => {
				const a = `${at}[${i}]`;
				if (!isObj(c)) return err(a, "must be an object");
				checkAttr(str({ pattern: KEY }), c.key, `${a}.key`, err);
				checkAttr(num({ min: 1, max: 1000 }), c.width, `${a}.width`, err);
				checkAttr(opt(oneOf(["left", "center", "right"])), c.align, `${a}.align`, err);
				for (const k of Object.keys(c)) if (!["key", "width", "align"].includes(k)) err(`${a}.${k}`, "is not a column attribute");
			});
			if (new Set(value.map((c) => c?.key)).size !== value.length) err(at, "column keys must be unique");
			return;
		default:
			err(at, `has unknown attribute type ${spec.type}`);
	}
}

function checkAttrs(specs, attrs, at, err) {
	if (attrs !== undefined && !isObj(attrs)) return err(at, "attrs must be an object");
	const a = attrs ?? {};
	for (const [name, spec] of Object.entries(specs)) checkAttr(spec, a[name], `${at}.${name}`, err);
	for (const name of Object.keys(a)) if (!(name in specs)) err(`${at}.${name}`, "is not an attribute of this type");
}

/** The attributes of a node with defaults applied. */
export function attrsOf(node) {
	const spec = NODES[node.type];
	const out = {};
	for (const [name, s] of Object.entries(spec?.attrs ?? {})) {
		const v = node.attrs?.[name];
		out[name] = v === undefined ? s.default : v;
	}
	return out;
}

function checkInline(content, at, ctx) {
	if (!Array.isArray(content)) return ctx.err(at, "must be an array of inline nodes");
	content.forEach((node, i) => {
		const a = `${at}[${i}]`;
		if (!isObj(node)) return ctx.err(a, "must be a node");
		const spec = NODES[node.type];
		if (!spec || spec.group !== "inline") return ctx.err(a, `${JSON.stringify(node.type)} is not an inline node`);
		for (const k of Object.keys(node))
			if (!["type", "attrs", ...(spec.text ? ["text", "marks"] : [])].includes(k)) ctx.err(`${a}.${k}`, "is not allowed here");
		if (spec.text) {
			if (typeof node.text !== "string" || node.text.length === 0) ctx.err(`${a}.text`, "must be a non-empty string");
			else if (node.text.length > TEXT_MAX || BAD_TEXT.test(node.text)) ctx.err(`${a}.text`, "holds text that cannot print");
			if (node.attrs !== undefined) ctx.err(`${a}.attrs`, "text has no attrs");
			if (node.marks !== undefined) {
				if (!Array.isArray(node.marks)) return ctx.err(`${a}.marks`, "must be an array");
				const seen = new Set();
				node.marks.forEach((m, j) => {
					const ma = `${a}.marks[${j}]`;
					if (!isObj(m) || !MARKS[m.type]) return ctx.err(ma, `${JSON.stringify(m?.type)} is not a mark`);
					if (seen.has(m.type)) ctx.err(ma, `mark ${m.type} appears twice`);
					seen.add(m.type);
					checkAttrs(MARKS[m.type].attrs, m.attrs, `${ma}.attrs`, ctx.err);
				});
			}
			return;
		}
		checkAttrs(spec.attrs, node.attrs, `${a}.attrs`, ctx.err);
		if (node.type === "field" && node.attrs?.key && !ctx.fieldKeys.has(node.attrs.key))
			ctx.err(`${a}.attrs.key`, `field ${node.attrs.key} is not in the envelope's fields`);
		if (node.type === "checkbox" && node.attrs?.key) ctx.formNames.push([node.attrs.key, a]);
	});
}

function checkBlock(node, at, ctx, parent) {
	if (!isObj(node)) return ctx.err(at, "must be a node");
	const spec = NODES[node.type];
	if (!spec) return ctx.err(at, `${JSON.stringify(node.type)} is not a node type`);
	for (const k of Object.keys(node)) if (!["type", "attrs", "content"].includes(k)) ctx.err(`${at}.${k}`, "is not allowed here");
	checkAttrs(spec.attrs, node.attrs, `${at}.attrs`, ctx.err);
	if ((ctx.blocks += 1) > BLOCKS_MAX) return ctx.err(at, `a document holds at most ${BLOCKS_MAX} nodes`);
	if (spec.topLevel && parent !== "body") ctx.err(at, `${node.type} is allowed only at the top level of the body`);
	if (node.type === "repeat") {
		if (ctx.inRepeat) ctx.err(at, "a repeat cannot hold another repeat");
	}
	if (node.type === "slot" && node.attrs?.id) {
		if (ctx.slots.has(node.attrs.id)) ctx.err(`${at}.attrs.id`, `slot ${node.attrs.id} appears twice`);
		ctx.slots.add(node.attrs.id);
	}
	const content = spec.content;
	if (content === undefined) {
		if (node.content !== undefined) ctx.err(`${at}.content`, `${node.type} has no content`);
		return;
	}
	if (content === "inline") {
		if (node.type === "cell") {
			const kind = node.attrs?.kind ?? "text";
			if (kind !== "text" && (node.content?.length ?? 0) > 0) ctx.err(`${at}.content`, `a ${kind} cell holds no text`);
		}
		return checkInline(node.content ?? [], `${at}.content`, ctx);
	}
	const children = node.content ?? [];
	if (!Array.isArray(children)) return ctx.err(`${at}.content`, "must be an array");
	const types = content === "blocks" ? null : content.types;
	if (content !== "blocks") {
		if (content.min !== undefined && children.length < content.min) ctx.err(`${at}.content`, `needs at least ${content.min} ${types.join(" or ")}`);
		if (content.max !== undefined && children.length > content.max) ctx.err(`${at}.content`, `holds at most ${content.max} ${types.join(" or ")}`);
		if (content.first && children[0] && children[0].type !== content.first) ctx.err(`${at}.content[0]`, `must be a ${content.first}`);
	}
	const inner = node.type === "repeat" ? { ...ctx, inRepeat: true } : ctx;
	children.forEach((child, i) => {
		const a = `${at}.content[${i}]`;
		const childSpec = NODES[child?.type];
		if (types ? !types.includes(child?.type) : childSpec?.group !== "block")
			return ctx.err(a, `${JSON.stringify(child?.type)} is not allowed inside ${node.type}`);
		checkBlock(child, a, inner, node.type);
		ctx.blocks = inner.blocks;
	});
	if (node.type === "table") checkTable(node, at, ctx);
}

function checkTable(table, at, ctx) {
	const a = attrsOf(table);
	if (!Array.isArray(a.columns)) return;
	const width = a.columns.length;
	(table.content ?? []).forEach((row, r) => {
		if (row?.type !== "row") return;
		const span = (row.content ?? []).reduce((n, cell) => n + (cell?.attrs?.colspan ?? 1), 0);
		if (span !== width) ctx.err(`${at}.content[${r}]`, `row spans ${span} columns; the table has ${width}`);
		(row.content ?? []).forEach((cell, c) => {
			const ca = `${at}.content[${r}].content[${c}]`;
			const kind = cell?.attrs?.kind ?? "text";
			const attrs = cell?.attrs ?? {};
			if (kind === "formula" && attrs.formula === undefined) ctx.err(`${ca}.attrs.formula`, "a formula cell needs a formula");
			if (kind !== "formula" && attrs.formula !== undefined) ctx.err(`${ca}.attrs.formula`, `a ${kind} cell has no formula`);
			if (kind !== "number" && attrs.value !== undefined) ctx.err(`${ca}.attrs.value`, `a ${kind} cell has no value`);
			if (kind === "formula" && attrs.formula !== undefined) {
				try {
					parseFormula(attrs.formula);
				} catch (e) {
					ctx.err(`${ca}.attrs.formula`, e.message);
				}
			}
			if (attrs.name) {
				if (ctx.names.has(attrs.name)) ctx.err(`${ca}.attrs.name`, `cell name ${attrs.name} appears twice`);
				ctx.names.add(attrs.name);
			}
			if (r < a.headerRows && kind !== "text") ctx.err(ca, "a header cell holds text only");
		});
	});
	if (a.headerRows >= (table.content?.length ?? 0) && a.headerRows > 0) ctx.err(`${at}.attrs.headerRows`, "the table needs a body row below its header");
}

function checkRecord(specs, value, at, err) {
	if (!isObj(value)) return err(at, "must be an object");
	for (const [name, spec] of Object.entries(specs)) if (spec.type !== "inline" && spec.type !== "source") checkAttr(spec, value[name], `${at}.${name}`, err);
	for (const name of Object.keys(value)) if (!(name in specs)) err(`${at}.${name}`, "is not allowed here");
}

/** Validate an envelope. Returns { ok, errors } where each error is "path: message". */
export function validate(doc) {
	const errors = [];
	const err = (path, message) => errors.push(`${path}: ${message}`);
	if (!isObj(doc)) return { ok: false, errors: ["$: the document must be a JSON object"] };
	for (const name of Object.keys(doc)) if (!(name in ENVELOPE)) err(`$.${name}`, "is not an envelope key");
	for (const name of ["format", "formatVersion", "kind", "id", "version"]) checkAttr(ENVELOPE[name], doc[name], `$.${name}`, err);
	if (doc.format !== FORMAT || doc.formatVersion !== FORMAT_VERSION) return { ok: false, errors };

	if (doc.kind === "template" && doc.origin !== null) err("$.origin", "a template has origin null");
	if (doc.kind === "document") {
		if (doc.origin !== null && !isObj(doc.origin)) err("$.origin", "must be null or { template, version }");
		if (isObj(doc.origin)) {
			checkAttr(str({ pattern: ID }), doc.origin.template, "$.origin.template", err);
			checkAttr(int(1, 100000), doc.origin.version, "$.origin.version", err);
			for (const k of Object.keys(doc.origin)) if (!["template", "version"].includes(k)) err(`$.origin.${k}`, "is not allowed here");
		}
	}
	checkRecord(META, doc.meta, "$.meta", err);
	checkRecord(PAGE, doc.page, "$.page", err);
	checkRecord(THEME, doc.theme, "$.theme", err);

	const fieldKeys = new Set();
	if (!Array.isArray(doc.fields)) err("$.fields", "must be an array");
	else
		doc.fields.forEach((f, i) => {
			const a = `$.fields[${i}]`;
			checkRecord(FIELD, f, a, err);
			if (!isObj(f)) return;
			if (f.source !== null && !SOURCES.includes(f.source)) err(`${a}.source`, `must be null or one of ${SOURCES.join(", ")}`);
			if (fieldKeys.has(f.key)) err(`${a}.key`, `field ${f.key} appears twice`);
			fieldKeys.add(f.key);
		});

	const ctx = { err, fieldKeys, slots: new Set(), names: new Set(), formNames: [], blocks: 0, inRepeat: false };
	if (isObj(doc.page) && doc.page.footer !== undefined) checkInline(doc.page.footer, "$.page.footer", ctx);
	if (!Array.isArray(doc.body)) err("$.body", "must be an array of blocks");
	else
		doc.body.forEach((node, i) => {
			if (NODES[node?.type]?.group !== "block") return err(`$.body[${i}]`, `${JSON.stringify(node?.type)} is not a block`);
			checkBlock(node, `$.body[${i}]`, ctx, "body");
		});
	const seenForm = new Set();
	for (const [name, a] of ctx.formNames) {
		if (seenForm.has(name)) err(`${a}.attrs.key`, `checkbox ${name} appears twice`);
		seenForm.add(name);
	}
	if (errors.length === 0) {
		const json = JSON.stringify(doc);
		if (json.length > 2_000_000) err("$", "the document is larger than 2 MB");
		for (const [path, result] of evaluate(doc)) if (result.error) err(path, `formula: ${result.error}`);
	}
	return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// Formulas
//
// expr    := term (("+" | "-") term)*
// term    := unary (("*" | "/") unary)*
// unary   := "-" unary | primary
// primary := number | "@" name | "sum(above)" | "sum(left)" | "above" | "left" | "(" expr ")"
//
// sum(above) adds the number and formula cells straight above, up to the first text cell or the header.
// It is Word's =SUM(ABOVE) and an Excel SUM over the same range, so all three outputs agree.

export function parseFormula(src) {
	const tokens = [];
	const re = /\s*(?:(\d+(?:\.\d+)?)|@([a-z][a-z0-9_]*)|([a-z]+)|([-+*/(),]))/gy;
	let m;
	let pos = 0;
	while (pos < src.length) {
		re.lastIndex = pos;
		m = re.exec(src);
		if (!m) {
			if (/^\s*$/.test(src.slice(pos))) break;
			throw new Error(`cannot read "${src.slice(pos).trim()}"`);
		}
		pos = re.lastIndex;
		if (m[1] !== undefined) tokens.push({ t: "num", v: Number(m[1]) });
		else if (m[2] !== undefined) tokens.push({ t: "ref", v: m[2] });
		else if (m[3] !== undefined) tokens.push({ t: "word", v: m[3] });
		else tokens.push({ t: "op", v: m[4] });
	}
	let i = 0;
	const peek = () => tokens[i];
	const take = (v) => {
		const tok = tokens[i];
		if (!tok || tok.v !== v) throw new Error(`expected "${v}"`);
		i += 1;
	};
	const expr = () => {
		let left = term();
		while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) {
			const op = tokens[i++].v;
			left = { t: "bin", op, a: left, b: term() };
		}
		return left;
	};
	const term = () => {
		let left = unary();
		while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) {
			const op = tokens[i++].v;
			left = { t: "bin", op, a: left, b: unary() };
		}
		return left;
	};
	const unary = () => {
		if (peek()?.t === "op" && peek().v === "-") {
			i += 1;
			return { t: "neg", a: unary() };
		}
		return primary();
	};
	const primary = () => {
		const tok = tokens[i++];
		if (!tok) throw new Error("the formula ends too soon");
		if (tok.t === "num") return { t: "num", v: tok.v };
		if (tok.t === "ref") return { t: "ref", name: tok.v };
		if (tok.t === "word" && (tok.v === "above" || tok.v === "left")) return { t: "near", dir: tok.v };
		if (tok.t === "word" && tok.v === "sum") {
			take("(");
			const dir = tokens[i++];
			if (!dir || (dir.v !== "above" && dir.v !== "left")) throw new Error("sum takes above or left");
			take(")");
			return { t: "sum", dir: dir.v };
		}
		if (tok.v === "(") {
			const inner = expr();
			take(")");
			return inner;
		}
		throw new Error(`unexpected "${tok.v}"`);
	};
	if (tokens.length === 0) throw new Error("the formula is empty");
	const ast = expr();
	if (i < tokens.length) throw new Error(`unexpected "${tokens[i].v}"`);
	return ast;
}

/** Every table in the document with its path and a grid of [row][column] -> { cell, path }. */
export function tablesOf(doc) {
	const out = [];
	const walk = (nodes, at) =>
		(nodes ?? []).forEach((node, i) => {
			const path = `${at}[${i}]`;
			if (node?.type === "table") {
				const grid = (node.content ?? []).map((row, r) => {
					const cols = [];
					(row.content ?? []).forEach((cell, c) => {
						const entry = { cell, path: `${path}.content[${r}].content[${c}]` };
						for (let s = 0; s < (cell?.attrs?.colspan ?? 1); s += 1) cols.push(entry);
					});
					return cols;
				});
				out.push({ node, path, grid, headerRows: attrsOf(node).headerRows });
			} else if (Array.isArray(node?.content) && NODES[node.type]?.content !== "inline") walk(node.content, `${path}.content`);
		});
	walk(doc?.body, "$.body");
	return out;
}

/** Evaluate every formula cell. Returns Map(path -> { value } | { error }). Number cells read as value ?? 0. */
export function evaluate(doc) {
	const tables = tablesOf(doc);
	const where = new Map(); // cell path -> { table, r, c }
	const names = new Map();
	for (const table of tables)
		table.grid.forEach((cols, r) =>
			cols.forEach((entry, c) => {
				if (!where.has(entry.path)) where.set(entry.path, { table, r, c, cell: entry.cell });
				const name = entry.cell?.attrs?.name;
				if (name && !names.has(name)) names.set(name, entry.path);
			}),
		);
	const results = new Map();
	const visiting = new Set();
	const valueAt = (path) => {
		const at = where.get(path);
		const kind = at.cell?.attrs?.kind ?? "text";
		if (kind === "number") return at.cell.attrs.value ?? 0;
		if (kind === "formula") {
			const res = run(path);
			if (res.error) throw new Error(res.error === "depends on itself" ? res.error : "uses a cell with an error");
			return res.value;
		}
		throw new Error("refers to a text cell");
	};
	const run = (path) => {
		if (results.has(path)) return results.get(path);
		if (visiting.has(path)) return { error: "depends on itself" };
		visiting.add(path);
		const at = where.get(path);
		let res;
		try {
			const ast = parseFormula(at.cell.attrs.formula);
			const ev = (n) => {
				switch (n.t) {
					case "num":
						return n.v;
					case "neg":
						return -ev(n.a);
					case "bin": {
						const a = ev(n.a);
						const b = ev(n.b);
						if (n.op === "/" && b === 0) throw new Error("divides by zero");
						return n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : a / b;
					}
					case "ref": {
						const target = names.get(n.name);
						if (!target) throw new Error(`no cell is named ${n.name}`);
						return valueAt(target);
					}
					case "near": {
						const r = n.dir === "above" ? at.r - 1 : at.r;
						const c = n.dir === "left" ? at.c - 1 : at.c;
						const entry = at.table.grid[r]?.[c];
						if (!entry || r < at.table.headerRows || entry.path === path) throw new Error(`there is no cell ${n.dir}`);
						return valueAt(entry.path);
					}
					case "sum": {
						let total = 0;
						for (let step = 1; ; step += 1) {
							const r = n.dir === "above" ? at.r - step : at.r;
							const c = n.dir === "left" ? at.c - step : at.c;
							if (r < at.table.headerRows || c < 0) break;
							const entry = at.table.grid[r]?.[c];
							if (!entry || entry.path === path) break;
							if ((entry.cell?.attrs?.kind ?? "text") === "text") break;
							total += valueAt(entry.path);
						}
						return total;
					}
				}
				throw new Error("unknown formula part");
			};
			res = { value: ev(ast) };
		} catch (e) {
			res = { error: e.message };
		}
		visiting.delete(path);
		results.set(path, res);
		return res;
	};
	for (const [path, at] of where) if ((at.cell?.attrs?.kind ?? "text") === "formula") run(path);
	return results;
}

/** How a number cell or a formula result prints. */
export function formatNumber(value, format) {
	if (value === null || value === undefined) return "";
	if (format === "currency")
		return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
	if (format === "integer") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
	if (format === "percent") return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);
	return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------------------------------------------------------
// Fork, wipe and fill

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A document made from a template: a full copy. It never follows later template changes. */
export function fork(template, id) {
	if (template.kind !== "template") throw new Error("only a template can be forked into a document");
	return { ...clone(template), kind: "document", id, version: 1, origin: { template: template.id, version: template.version } };
}

/** Delete all content. The envelope (title, class, page setup, field list) stays; nothing in the body is locked. */
export function wipe(doc) {
	const next = clone(doc);
	next.body = [];
	if (next.page.footer) next.page.footer = [];
	return next;
}

/** The value a field prints with, or null when it prints as a blank. */
export function resolveField(doc, key, data) {
	const field = doc.fields.find((f) => f.key === key);
	if (!field) return null;
	const fromSource = field.source ? field.source.split(".").reduce((v, part) => v?.[part], data) : undefined;
	const filled = data?.values?.[key] ?? fromSource;
	return filled ? String(filled) : (field.default ?? null);
}

/** Rule DOC-019, derived and never stored: a formal/legal document prints the notice at export. */
export const noticesOf = (doc) => (doc.meta?.class === "formal/legal" ? ["Template, not legal advice"] : []);

/** Block node types the document uses, for the one-format-for-all coverage table. */
export function typesUsed(doc) {
	const seen = new Set();
	const walk = (nodes) =>
		(nodes ?? []).forEach((n) => {
			if (!n?.type) return;
			seen.add(n.type);
			for (const m of n.marks ?? []) seen.add(`mark:${m.type}`);
			if (Array.isArray(n.content)) walk(n.content);
		});
	walk(doc.body);
	walk(doc.page?.footer);
	return seen;
}
