// Approach A: the everyfield.doc/1 format module: the validator, the table math and forking. One ES module with no dependencies.
// Node runs it through validate.mjs and test.mjs; the browser prototype imports the same file.
// The schema (schema.json) says which nodes, attributes and children exist. This file adds the rules a
// content model cannot say: declared fields, table shape, formulas, unique write-in keys and page fit.

const SLUG = /^[a-z][a-z0-9-]{0,79}$/;
const KEY = /^[a-z][a-z0-9_]{0,59}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUMERIC = new Set(["number", "money"]);

/** Points of a page box, after size and orientation. */
export function pageBox(page, schema) {
	const base = page.size === "custom" ? { width: page.width, height: page.height } : schema.pageSizes[page.size];
	if (!base) return null;
	return page.orientation === "landscape" ? { width: base.height, height: base.width } : { ...base };
}

/** The size of one tile (a card) in points, or the page content box when the page is not tiled. */
export function tileBox(page, schema) {
	const box = pageBox(page, schema);
	if (!box) return null;
	const m = page.margin;
	const w = box.width - m.left - m.right;
	const h = box.height - m.top - m.bottom;
	if (!page.tile) return { width: w, height: h };
	return { width: w / page.tile.across, height: h / page.tile.down };
}

// ---------------------------------------------------------------- formulas

/** A column formula: numbers, column ids to the left, + - * / ( ) and sum(first:last). */
export function parseFormula(source) {
	const tokens = [];
	const re = /\s*(?:(\d+(?:\.\d+)?)|([a-z][a-z0-9_]*)|([-+*/():]))/y;
	let at = 0;
	while (at < source.length) {
		if (/^\s*$/.test(source.slice(at))) break;
		re.lastIndex = at;
		const m = re.exec(source);
		if (!m) throw new Error(`the formula "${source}" has an unexpected character at position ${at + 1}`);
		at = re.lastIndex;
		if (m[1] !== undefined) tokens.push({ t: "num", v: Number(m[1]) });
		else if (m[2] !== undefined) tokens.push({ t: "id", v: m[2] });
		else tokens.push({ t: m[3] });
	}
	let i = 0;
	const peek = () => tokens[i];
	const take = (t) => {
		const tok = tokens[i];
		if (!tok || (t && tok.t !== t)) throw new Error(`the formula "${source}" is incomplete or malformed`);
		i += 1;
		return tok;
	};
	const factor = () => {
		const tok = peek();
		if (!tok) throw new Error(`the formula "${source}" ends too early`);
		if (tok.t === "-") {
			take();
			return { op: "neg", a: factor() };
		}
		if (tok.t === "num") return { op: "num", v: take().v };
		if (tok.t === "(") {
			take();
			const e = expr();
			take(")");
			return e;
		}
		if (tok.t === "id" && tok.v === "sum" && tokens[i + 1]?.t === "(") {
			take();
			take("(");
			const first = take("id").v;
			take(":");
			const last = take("id").v;
			take(")");
			return { op: "sum", first, last };
		}
		if (tok.t === "id") return { op: "col", id: take().v };
		throw new Error(`the formula "${source}" is malformed`);
	};
	const term = () => {
		let a = factor();
		while (peek() && (peek().t === "*" || peek().t === "/")) a = { op: take().t, a, b: factor() };
		return a;
	};
	const expr = () => {
		let a = term();
		while (peek() && (peek().t === "+" || peek().t === "-")) a = { op: take().t, a, b: term() };
		return a;
	};
	const tree = expr();
	if (i !== tokens.length) throw new Error(`the formula "${source}" has extra text after a complete expression`);
	return tree;
}

/** Column ids a formula reads. A sum range expands to every column from first to last, in table order. */
export function formulaRefs(tree, columnIds) {
	const out = [];
	const walk = (n) => {
		if (n.op === "col") out.push(n.id);
		else if (n.op === "sum") {
			const a = columnIds.indexOf(n.first);
			const b = columnIds.indexOf(n.last);
			if (a < 0) out.push(n.first);
			if (b < 0) out.push(n.last);
			if (a >= 0 && b >= 0) out.push(...columnIds.slice(Math.min(a, b), Math.max(a, b) + 1));
		} else {
			if (n.a) walk(n.a);
			if (n.b) walk(n.b);
		}
	};
	walk(tree);
	return out;
}

function evalTree(n, get, columnIds) {
	switch (n.op) {
		case "num":
			return n.v;
		case "col":
			return get(n.id);
		case "neg":
			return -evalTree(n.a, get, columnIds);
		case "sum": {
			const a = columnIds.indexOf(n.first);
			const b = columnIds.indexOf(n.last);
			return columnIds.slice(Math.min(a, b), Math.max(a, b) + 1).reduce((s, id) => s + get(id), 0);
		}
		case "+":
			return evalTree(n.a, get, columnIds) + evalTree(n.b, get, columnIds);
		case "-":
			return evalTree(n.a, get, columnIds) - evalTree(n.b, get, columnIds);
		case "*":
			return evalTree(n.a, get, columnIds) * evalTree(n.b, get, columnIds);
		case "/": {
			const d = evalTree(n.b, get, columnIds);
			return d === 0 ? 0 : evalTree(n.a, get, columnIds) / d;
		}
	}
	return 0;
}

/**
 * The numbers a table shows. Item rows read their typed values and compute formula columns. A subtotal row adds the item
 * rows of its category (since the last group row). A total row adds every category so far, with each group's sign.
 * Returns one array per row, with a number or null for each column (null: the cell prints no number).
 */
export function computeTable(table) {
	const cols = table.attrs.columns;
	const ids = cols.map((c) => c.id);
	const numericCol = (c) => NUMERIC.has(c.type) || c.type === "formula";
	const trees = cols.map((c) => {
		if (c.type !== "formula") return null;
		try {
			return parseFormula(c.formula ?? "");
		} catch {
			return null;
		}
	});
	const rows = table.content ?? [];
	const out = [];
	let groupSign = 1;
	let groupSum = cols.map(() => 0);
	const groups = [];
	let index = 0;
	const closeGroup = () => groups.push({ sign: groupSign, sum: groupSum });
	let openGroup = false;
	for (const row of rows) {
		const role = row.attrs?.role ?? "item";
		if (role === "group") {
			if (openGroup) closeGroup();
			openGroup = true;
			groupSign = row.attrs?.sign === "subtract" ? -1 : 1;
			groupSum = cols.map(() => 0);
			out.push(cols.map(() => null));
			continue;
		}
		if (role === "item") {
			if (!openGroup) {
				openGroup = true;
				groupSign = 1;
				groupSum = cols.map(() => 0);
			}
			index += 1;
			const vals = {};
			const line = cols.map((c, ci) => {
				if (c.type === "index") return index;
				if (NUMERIC.has(c.type)) {
					const v = row.content?.[ci]?.attrs?.value;
					vals[c.id] = typeof v === "number" ? v : 0;
					return typeof v === "number" ? v : null;
				}
				if (c.type === "formula") {
					const v = trees[ci] ? evalTree(trees[ci], (id) => vals[id] ?? 0, ids) : 0;
					vals[c.id] = v;
					return v;
				}
				return null;
			});
			cols.forEach((c, ci) => {
				if (numericCol(c)) groupSum[ci] += vals[c.id] ?? 0;
			});
			out.push(line);
			continue;
		}
		if (role === "subtotal") {
			out.push(cols.map((c, ci) => (numericCol(c) ? groupSum[ci] : null)));
			continue;
		}
		// total: every group so far, the open one included, each with its sign.
		const all = openGroup ? [...groups, { sign: groupSign, sum: groupSum }] : groups;
		out.push(cols.map((c, ci) => (numericCol(c) ? all.reduce((s, g) => s + g.sign * g.sum[ci], 0) : null)));
	}
	return out;
}

// ---------------------------------------------------------------- canonical form and hash input

/** JSON with sorted keys and no editor-only keys (those that start with "_"). The template hash reads this. */
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value)
			.filter((k) => !k.startsWith("_") && value[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

// ---------------------------------------------------------------- validation

/** Validate one document or template. Returns every fault found, each as "<path>: <message>". */
export function validate(doc, schema) {
	const errors = [];
	const fail = (path, message) => errors.push(`${path}: ${message}`);
	const ctx = {
		schema,
		fail,
		nodes: 0,
		fields: new Map(),
		writeIns: new Map(),
		fieldRefs: [],
		ledgers: 0,
		region: null,
	};
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
		fail("(root)", "the file is not a JSON object");
		return { ok: false, errors };
	}
	checkObject(doc, schema.envelope, "(root)", ctx, true);
	if (errors.length && (!doc.page || !doc.body)) return { ok: false, errors };

	// Envelope rules.
	for (const [i, f] of (Array.isArray(doc.fields) ? doc.fields : []).entries()) {
		if (!f || typeof f !== "object") continue;
		if (ctx.fields.has(f.key)) fail(`fields[${i}]`, `the field key "${f.key}" is declared twice`);
		ctx.fields.set(f.key, f);
	}
	if (doc.kind === "template") {
		if (doc.data !== undefined) fail("data", "a template holds no merge values; only a document has data");
		if (doc.origin) fail("origin", "a template has no origin; only a document made from a template has one");
	}
	if (doc.kind === "document" && !("origin" in doc))
		fail("origin", "a document states its origin: the template it came from, or null for a blank document");
	if (Array.isArray(doc.exports) && new Set(doc.exports).size !== doc.exports.length)
		fail("exports", "an export format is listed twice");
	if (doc.data && typeof doc.data === "object")
		for (const key of Object.keys(doc.data))
			if (!ctx.fields.has(key)) fail(`data.${key}`, `the value "${key}" has no declared field`);

	// Page rules.
	const page = doc.page;
	if (page && typeof page === "object") {
		if (page.size === "custom" && (typeof page.width !== "number" || typeof page.height !== "number"))
			fail("page", "a custom page size needs a width and a height in points");
		if (page.size !== "custom" && (page.width !== undefined || page.height !== undefined))
			fail("page", `the page size "${page.size}" sets its own width and height; remove them or use "custom"`);
		const box = page.margin && tileBox(page, schema);
		if (box && (box.width < 72 || box.height < 72))
			fail(
				"page",
				page.tile
					? `each tile is ${Math.round(box.width)} x ${Math.round(box.height)} pt; a tile needs at least 72 x 72 pt`
					: "the margins leave less than 72 pt for the content",
			);
		for (const name of ["header", "footer"]) {
			const region = page[name];
			if (!region) continue;
			ctx.region = name;
			for (const [i, block] of (Array.isArray(region.content) ? region.content : []).entries()) {
				if (block?.type === "pageBreak") fail(`page.${name}.content[${i}]`, `a page break cannot sit in the ${name}`);
				checkNode(block, `page.${name}.content[${i}]`, ctx, ["block"]);
			}
			ctx.region = null;
		}
	}

	// Body.
	if (doc.body && typeof doc.body === "object") {
		if (doc.body.type !== "doc") fail("body", `the body is a "doc" node, not "${doc.body.type}"`);
		else checkNode(doc.body, "body", ctx, ["root"]);
	}

	for (const ref of ctx.fieldRefs) {
		const field = ctx.fields.get(ref.key);
		if (!field) fail(ref.path, `the merge field "${ref.key}" is not declared in "fields"`);
		else if (ref.list && field.type !== "list")
			fail(ref.path, `the table reads "${ref.key}", which is a ${field.type} field, not a list`);
		else if (!ref.list && field.type === "list")
			fail(ref.path, `the merge field "${ref.key}" is a list; only a table can read it`);
	}
	if (Array.isArray(doc.exports) && doc.exports.includes("xlsx") && ctx.ledgers === 0)
		fail("exports", "XLSX export needs at least one ledger table (a budget) in the body");
	if (ctx.nodes > schema.limits.nodes) fail("body", `the document holds ${ctx.nodes} nodes; the limit is ${schema.limits.nodes}`);
	const bytes = JSON.stringify(doc).length;
	if (bytes > schema.limits.jsonBytes) fail("(root)", `the document is ${bytes} bytes; the limit is ${schema.limits.jsonBytes}`);
	return { ok: errors.length === 0, errors };
}

function checkNode(node, path, ctx, allowed, deny = []) {
	const { schema, fail } = ctx;
	if (!node || typeof node !== "object" || Array.isArray(node)) {
		fail(path, "a node must be an object with a type");
		return;
	}
	const spec = schema.nodes[node.type];
	if (!spec) {
		fail(path, `unknown node type "${node.type}"`);
		return;
	}
	const where = `${path} (${node.type})`;
	if (!allowed.includes(spec.group) && !allowed.includes(node.type)) {
		fail(where, `a ${node.type} node is not allowed here; this place takes ${allowed.join(" or ")}`);
		return;
	}
	if (deny.includes(node.type)) {
		fail(where, `a ${node.type} node cannot sit inside this container`);
		return;
	}
	ctx.nodes += 1;
	const known = new Set(["type", "attrs", "content", ...(spec.text ? ["text", "marks"] : [])]);
	for (const k of Object.keys(node)) if (!known.has(k)) fail(where, `unknown key "${k}" on a ${node.type} node`);

	// Attributes: a missing attribute with a default takes it; one without a default is required.
	const attrs = node.attrs ?? {};
	if (node.attrs !== undefined && (typeof node.attrs !== "object" || Array.isArray(node.attrs)))
		fail(where, "attrs must be an object");
	for (const k of Object.keys(attrs)) if (!spec.attrs[k]) fail(where, `unknown attribute "${k}" on a ${node.type} node`);
	for (const [k, aspec] of Object.entries(spec.attrs)) {
		if (attrs[k] === undefined) {
			if (aspec.default === undefined && !aspec.optional) fail(where, `the attribute "${k}" is required`);
			continue;
		}
		checkValue(attrs[k], aspec, `${where}.attrs.${k}`, ctx);
	}

	if (spec.text) {
		if (typeof node.text !== "string" || node.text.length === 0) fail(where, "a text node needs non-empty text");
		else {
			if (node.text.length > schema.limits.textLength) fail(where, `the text is longer than ${schema.limits.textLength} characters`);
			if (node.text.includes("\0") || LONE_SURROGATE.test(node.text)) fail(where, "the text holds a character that cannot print");
		}
		if (node.marks !== undefined) {
			if (!Array.isArray(node.marks)) fail(where, "marks must be a list");
			else {
				const seen = new Set();
				for (const [mi, mark] of node.marks.entries()) {
					const mspec = schema.marks[mark?.type];
					if (!mspec) {
						fail(`${where}.marks[${mi}]`, `unknown mark "${mark?.type}"`);
						continue;
					}
					if (seen.has(mark.type)) fail(`${where}.marks[${mi}]`, `the mark "${mark.type}" is applied twice`);
					seen.add(mark.type);
					checkObject(mark.attrs ?? {}, mspec.attrs, `${where}.marks[${mi}].attrs`, ctx);
				}
			}
		}
	}

	if (spec.content === null) {
		if (node.content !== undefined) fail(where, `a ${node.type} node holds no content`);
	} else {
		const content = node.content ?? [];
		if (!Array.isArray(content)) fail(where, "content must be a list");
		else {
			const { min = 0, max } = spec.content;
			if (content.length < min) fail(where, `a ${node.type} node needs at least ${min} child node${min === 1 ? "" : "s"}`);
			if (max !== undefined && content.length > max) fail(where, `a ${node.type} node holds at most ${max} child nodes`);
			const childDeny = [...(spec.content.deny ?? []), ...(node.type === "column" || node.type === "box" ? deny : [])];
			content.forEach((child, i) => checkNode(child, `${path}.content[${i}]`, ctx, spec.content.allow, childDeny));
		}
	}

	// Node rules the content model cannot say.
	if (node.type === "field") ctx.fieldRefs.push({ key: attrs.key, path: where });
	if (node.type === "pageNumber" && !ctx.region) fail(where, "a page number can sit only in the page header or footer");
	if (node.type === "writeIn" && typeof attrs.key === "string") {
		if (ctx.writeIns.has(attrs.key))
			fail(where, `the write-in key "${attrs.key}" is already used at ${ctx.writeIns.get(attrs.key)}; PDF form fields need unique names`);
		else ctx.writeIns.set(attrs.key, where);
	}
	if (node.type === "table" && Array.isArray(attrs.columns)) checkTable(node, attrs, where, ctx);
}

function checkTable(node, attrs, where, ctx) {
	const { fail } = ctx;
	const cols = attrs.columns;
	const ids = cols.map((c) => c?.id);
	const seen = new Set();
	cols.forEach((c, ci) => {
		if (!c || typeof c !== "object") return;
		const at = `${where}.attrs.columns[${ci}]`;
		if (seen.has(c.id)) fail(at, `the column id "${c.id}" is used twice`);
		seen.add(c.id);
		if (c.type === "formula") {
			if (typeof c.formula !== "string") {
				fail(at, `the formula column "${c.id}" needs a formula`);
				return;
			}
			let tree;
			try {
				tree = parseFormula(c.formula);
			} catch (e) {
				fail(at, e.message);
				return;
			}
			for (const ref of formulaRefs(tree, ids)) {
				const ri = ids.indexOf(ref);
				if (ri < 0) fail(at, `the formula reads the column "${ref}", which this table does not have`);
				else if (ri >= ci) fail(at, `the formula reads "${ref}"; a formula reads only columns to its left`);
				else if (!NUMERIC.has(cols[ri].type) && cols[ri].type !== "formula")
					fail(at, `the formula reads "${ref}", a ${cols[ri].type} column; it can read only number, money or formula columns`);
			}
		} else if (c.formula !== undefined) fail(at, `only a formula column has a formula; "${c.id}" is a ${c.type} column`);
	});
	if (attrs.source) ctx.fieldRefs.push({ key: attrs.source, path: where, list: true });
	const ledger = attrs.style === "ledger";
	if (ledger) ctx.ledgers += 1;
	let groupOpen = false;
	(node.content ?? []).forEach((row, ri) => {
		if (!row || row.type !== "row") return;
		const at = `${where}.content[${ri}] (row ${ri + 1})`;
		const role = row.attrs?.role ?? "item";
		const cells = row.content ?? [];
		if (cells.length !== cols.length)
			fail(at, `the row has ${cells.length} cell${cells.length === 1 ? "" : "s"} but the table has ${cols.length} columns`);
		if (role !== "item" && !ledger) fail(at, `a ${role} row needs a ledger table; this table's style is "${attrs.style ?? "grid"}"`);
		if (role === "group") groupOpen = true;
		if (role === "subtotal" && !groupOpen) fail(at, "a subtotal row adds a category, so a group row must come before it");
		if (row.attrs?.sign !== undefined && role !== "group") fail(at, "only a group row has a sign");
		cells.forEach((cell, ci) => {
			const col = cols[ci];
			if (!col || !cell || cell.type !== "cell") return;
			const cat = `${at}.cell[${ci}] (column "${col.id}")`;
			const value = cell.attrs?.value;
			const hasText = (cell.content ?? []).length > 0;
			if (value !== undefined && value !== null) {
				if (!NUMERIC.has(col.type)) fail(cat, `only a number or money column holds a value; this is a ${col.type} column`);
				else if (role !== "item") fail(cat, `a ${role} row computes its numbers; it holds no typed value`);
			}
			if (cell.attrs?.checked && col.type !== "check") fail(cat, "only a check column can be checked");
			if (hasText && col.type !== "text") fail(cat, `a ${col.type} cell holds no text`);
		});
	});
}

function checkValue(value, spec, path, ctx) {
	const { fail, schema } = ctx;
	if (value === null) {
		if (!spec.nullable) fail(path, "the value cannot be null");
		return;
	}
	switch (spec.type) {
		case "any":
			return;
		case "const":
			if (value !== spec.value) fail(path, `must be "${spec.value}", not ${JSON.stringify(value)}`);
			return;
		case "enum":
			if (!spec.values.includes(value)) fail(path, `${JSON.stringify(value)} is not one of ${spec.values.join(", ")}`);
			return;
		case "token":
			if (!schema.tokens.color.includes(value))
				fail(path, `${JSON.stringify(value)} is not a theme color; use one of ${schema.tokens.color.join(", ")}`);
			return;
		case "int":
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value) || (spec.type === "int" && !Number.isInteger(value)))
				fail(path, `must be ${spec.type === "int" ? "a whole number" : "a number"}`);
			else if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))
				fail(path, `${value} is outside ${spec.min} to ${spec.max}`);
			return;
		case "bool":
			if (typeof value !== "boolean") fail(path, "must be true or false");
			return;
		case "string":
			if (typeof value !== "string") fail(path, "must be text");
			else {
				if (spec.min !== undefined && value.length < spec.min) fail(path, "cannot be empty");
				if (spec.max !== undefined && value.length > spec.max) fail(path, `is longer than ${spec.max} characters`);
				if (spec.pattern && !new RegExp(spec.pattern).test(value)) fail(path, `${JSON.stringify(value)} does not match ${spec.pattern}`);
			}
			return;
		case "slug":
			if (typeof value !== "string" || !SLUG.test(value)) fail(path, `${JSON.stringify(value)} is not an id (lowercase letters, digits and hyphens)`);
			return;
		case "key":
			if (typeof value !== "string" || !KEY.test(value)) fail(path, `${JSON.stringify(value)} is not a key (lowercase letters, digits and underscores)`);
			return;
		case "list":
			if (!Array.isArray(value)) fail(path, "must be a list");
			else {
				if (spec.min !== undefined && value.length < spec.min) fail(path, `needs at least ${spec.min} entr${spec.min === 1 ? "y" : "ies"}`);
				if (spec.max !== undefined && value.length > spec.max) fail(path, `holds at most ${spec.max} entries`);
				value.forEach((v, i) => checkValue(v, spec.of, `${path}[${i}]`, ctx));
			}
			return;
		case "object":
			checkObject(value, spec.props, path, ctx);
			return;
		case "map":
			if (typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object of values by field key");
			return;
		case "page":
			checkObject(value, schema.page, path, ctx);
			return;
		case "region":
			checkObject(value, schema.region, path, ctx);
			return;
		case "blocks":
			if (!Array.isArray(value)) fail(path, "must be a list of blocks");
			return; // the nodes are checked by the page rules, with the region set.
		case "node":
			if (!value || typeof value !== "object") fail(path, "must be a node");
			return; // the body is checked by checkNode.
	}
}

function checkObject(value, props, path, ctx, root = false) {
	const { fail } = ctx;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(path, "must be an object");
		return;
	}
	const prefix = root ? "" : `${path}.`;
	for (const k of Object.keys(value)) if (!props[k]) fail(root ? k : `${path}.${k}`, `unknown key "${k}"`);
	for (const [k, spec] of Object.entries(props)) {
		if (value[k] === undefined) {
			if (!spec.optional) fail(root ? k : `${path}.${k}`, "is required");
			continue;
		}
		checkValue(value[k], spec, `${prefix}${k}`, ctx);
	}
}

// ---------------------------------------------------------------- templates and documents

/** sha256 of a template's canonical JSON, as "sha256:<hex>". A document records it as its origin hash. */
export async function templateHash(template) {
	const bytes = new TextEncoder().encode(canonical(template));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Fork: a new document from a template. The document is a full copy of the template's page and body, so it never follows
 * later template changes. It records which template version it came from and freezes the merge values it was made with.
 */
export async function forkTemplate(template, { id, data = {} } = {}) {
	if (template.kind !== "template") throw new Error("only a template can be forked");
	const copy = structuredClone(template);
	const values = {};
	for (const field of copy.fields) if (data[field.key] !== undefined) values[field.key] = data[field.key];
	return {
		format: copy.format,
		kind: "document",
		id: id ?? `${template.id}-copy`,
		version: 1,
		title: copy.title,
		...(copy.description ? { description: copy.description } : {}),
		class: copy.class,
		exports: copy.exports,
		origin: { template: template.id, version: template.version, hash: await templateHash(template) },
		fields: copy.fields,
		data: values,
		page: copy.page,
		body: copy.body,
	};
}

/** A blank document: Letter, standard margins, the two church fields and an empty body. */
export function blankDocument(id = "untitled") {
	return {
		format: "everyfield.doc/1",
		kind: "document",
		id,
		version: 1,
		title: "Untitled document",
		class: "operational",
		exports: ["pdf", "docx"],
		origin: null,
		fields: [
			{ key: "church_name", label: "Church name", type: "text", source: "church.name", required: true, sample: "Harbor City Church" },
			{ key: "pastor_name", label: "Pastor name", type: "text", source: "church.pastor", sample: "Dana Brooks" },
		],
		data: {},
		page: {
			size: "letter",
			orientation: "portrait",
			margin: { top: 40, right: 40, bottom: 56, left: 40 },
			tile: null,
			header: null,
			footer: null,
		},
		body: { type: "doc", content: [] },
	};
}
