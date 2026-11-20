import { FORMAT_SCHEMA } from "./schema.ts";
import type {
	AnyNode,
	DocDocument,
	DocTemplate,
	FormatSchema,
	PageSetup,
	PageSize,
	TableNode,
	Tile,
	ValueSpec,
} from "./types.ts";

const SLUG = /^[a-z][a-z0-9-]{0,79}$/;
export const KEY = /^[a-z][a-z0-9_]{0,59}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUMERIC = new Set(["number", "money"]);

type Rec = { [key: string]: unknown };
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function pageBox(page: Pick<PageSetup, "size" | "width" | "height" | "orientation">, schema = FORMAT_SCHEMA) {
	const base =
		page.size === "custom"
			? typeof page.width === "number" && typeof page.height === "number"
				? { width: page.width, height: page.height }
				: undefined
			: schema.pageSizes[page.size];
	if (!base) return null;
	return page.orientation === "landscape" ? { width: base.height, height: base.width } : { ...base };
}

type TiledPage = Pick<PageSetup, "size" | "width" | "height" | "orientation" | "margin"> & {
	tile?: Pick<Tile, "across" | "down"> | null;
};

export function tileBox(page: TiledPage, schema = FORMAT_SCHEMA) {
	const box = pageBox(page, schema);
	if (!box) return null;
	const m = page.margin;
	const w = box.width - m.left - m.right;
	const h = box.height - m.top - m.bottom;
	if (!page.tile) return { width: w, height: h };
	return { width: w / page.tile.across, height: h / page.tile.down };
}

export type Formula =
	| { op: "num"; v: number }
	| { op: "col"; id: string }
	| { op: "neg"; a: Formula }
	| { op: "sum"; first: string; last: string }
	| { op: "+" | "-" | "*" | "/"; a: Formula; b: Formula };
type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "-" | "+" | "*" | "/" | "(" | ")" | ":" };

export function parseFormula(source: string): Formula {
	const tokens: Token[] = [];
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
		else tokens.push({ t: m[3] as "-" });
	}
	let i = 0;
	const peek = () => tokens[i];
	const take = <T extends Token["t"]>(t?: T): Extract<Token, { t: T }> => {
		const tok = tokens[i];
		if (!tok || (t && tok.t !== t)) throw new Error(`the formula "${source}" is incomplete or malformed`);
		i += 1;
		return tok as Extract<Token, { t: T }>;
	};
	const factor = (): Formula => {
		const tok = peek();
		if (!tok) throw new Error(`the formula "${source}" ends too early`);
		if (tok.t === "-") {
			take();
			return { op: "neg", a: factor() };
		}
		if (tok.t === "num") return { op: "num", v: take("num").v };
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
		if (tok.t === "id") return { op: "col", id: take("id").v };
		throw new Error(`the formula "${source}" is malformed`);
	};
	const term = (): Formula => {
		let a = factor();
		for (let tok = peek(); tok && (tok.t === "*" || tok.t === "/"); tok = peek()) {
			take();
			a = { op: tok.t, a, b: factor() };
		}
		return a;
	};
	const expr = (): Formula => {
		let a = term();
		for (let tok = peek(); tok && (tok.t === "+" || tok.t === "-"); tok = peek()) {
			take();
			a = { op: tok.t, a, b: term() };
		}
		return a;
	};
	const tree = expr();
	if (i !== tokens.length) throw new Error(`the formula "${source}" has extra text after a complete expression`);
	return tree;
}

function formulaRefs(tree: Formula, columnIds: string[]) {
	const out: string[] = [];
	const walk = (n: Formula) => {
		if (n.op === "col") out.push(n.id);
		else if (n.op === "sum") {
			const a = columnIds.indexOf(n.first);
			const b = columnIds.indexOf(n.last);
			if (a < 0) out.push(n.first);
			if (b < 0) out.push(n.last);
			if (a >= 0 && b >= 0) out.push(...columnIds.slice(Math.min(a, b), Math.max(a, b) + 1));
		} else if (n.op === "neg") walk(n.a);
		else if (n.op !== "num") {
			walk(n.a);
			walk(n.b);
		}
	};
	walk(tree);
	return out;
}

type FormulaDep = {
	column: TableNode["attrs"]["columns"][number];
	reads: string[];
	spans: [number, number][];
};

export function formulaDeps(columns: TableNode["attrs"]["columns"]): FormulaDep[] {
	const ids = columns.map((c) => c.id);
	const out: FormulaDep[] = [];
	columns.forEach((column) => {
		if (column.type !== "formula") return;
		let tree: Formula;
		try {
			tree = parseFormula(column.formula ?? "");
		} catch {
			return;
		}
		const spans: [number, number][] = [];
		const walk = (n: Formula) => {
			if (n.op === "sum") {
				const a = ids.indexOf(n.first);
				const b = ids.indexOf(n.last);
				if (a >= 0 && b >= 0) spans.push([Math.min(a, b), Math.max(a, b)]);
			} else if (n.op === "neg") walk(n.a);
			else if (n.op !== "num" && n.op !== "col") {
				walk(n.a);
				walk(n.b);
			}
		};
		walk(tree);
		out.push({ column, reads: formulaRefs(tree, ids), spans });
	});
	return out;
}

function evalTree(n: Formula, get: (id: string) => number, columnIds: string[]): number {
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
}

export function computeTable(table: TableNode): (number | null)[][] {
	const cols = table.attrs.columns;
	const ids = cols.map((c) => c.id);
	const numericCol = (c: (typeof cols)[number]) => NUMERIC.has(c.type) || c.type === "formula";
	const trees = cols.map((c) => {
		if (c.type !== "formula") return null;
		try {
			return parseFormula(c.formula ?? "");
		} catch {
			return null;
		}
	});
	const rows = table.content ?? [];
	const out: (number | null)[][] = [];
	let groupSign = 1;
	let groupSum = cols.map(() => 0);
	const groups: { sign: number; sum: number[] }[] = [];
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
			const vals: Record<string, number> = {};
			const line = cols.map((c, ci) => {
				if (c.type === "index") return index;
				if (NUMERIC.has(c.type)) {
					const v = row.content?.[ci]?.attrs?.value;
					vals[c.id] = typeof v === "number" ? v : 0;
					return typeof v === "number" ? v : null;
				}
				if (c.type === "formula") {
					const tree = trees[ci];
					const v = tree ? evalTree(tree, (id) => vals[id] ?? 0, ids) : 0;
					vals[c.id] = v;
					return v;
				}
				return null;
			});
			cols.forEach((c, ci) => {
				if (numericCol(c)) groupSum[ci] = (groupSum[ci] ?? 0) + (vals[c.id] ?? 0);
			});
			out.push(line);
			continue;
		}
		if (role === "subtotal") {
			out.push(cols.map((c, ci) => (numericCol(c) ? (groupSum[ci] ?? 0) : null)));
			continue;
		}
		const all = openGroup ? [...groups, { sign: groupSign, sum: groupSum }] : groups;
		out.push(cols.map((c, ci) => (numericCol(c) ? all.reduce((s, g) => s + g.sign * (g.sum[ci] ?? 0), 0) : null)));
	}
	return out;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRec(value)) {
		const keys = Object.keys(value)
			.filter((k) => !k.startsWith("_") && value[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

type Ctx = {
	schema: FormatSchema;
	fail: (path: string, message: string) => void;
	nodes: number;
	fields: Map<unknown, Rec>;
	writeIns: Map<string, string>;
	fieldRefs: { key: unknown; path: string; list?: boolean }[];
	ledgers: number;
	region: string | null;
	ancestors: string[];
};

const newCtx = (schema: FormatSchema, fail: Ctx["fail"]): Ctx => ({
	schema,
	fail,
	nodes: 0,
	fields: new Map(),
	writeIns: new Map(),
	fieldRefs: [],
	ledgers: 0,
	region: null,
	ancestors: [],
});

export function tableIssue(table: TableNode, schema = FORMAT_SCHEMA): string | null {
	const errors: string[] = [];
	checkTable(
		table,
		table.attrs,
		"table",
		newCtx(schema, (_path, message) => errors.push(message)),
	);
	return errors[0] ?? null;
}

export function validate(doc: unknown, schema = FORMAT_SCHEMA): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	const fail = (path: string, message: string) => errors.push(`${path}: ${message}`);
	const ctx = newCtx(schema, fail);
	if (!isRec(doc)) {
		fail("(root)", "the file is not a JSON object");
		return { ok: false, errors };
	}
	checkObject(doc, schema.envelope, "(root)", ctx, true);
	if (errors.length && (!doc.page || !doc.body)) return { ok: false, errors };

	for (const [i, f] of list(doc.fields).entries()) {
		if (!isRec(f)) continue;
		if (ctx.fields.has(f.key)) fail(`fields[${i}]`, `the field key "${String(f.key)}" is declared twice`);
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
	if (isRec(doc.data))
		for (const key of Object.keys(doc.data))
			if (!ctx.fields.has(key)) fail(`data.${key}`, `the value "${key}" has no declared field`);

	const page = doc.page;
	if (isRec(page)) {
		if (page.size === "custom" && (typeof page.width !== "number" || typeof page.height !== "number"))
			fail("page", "a custom page size needs a width and a height in points");
		if (page.size !== "custom" && (page.width !== undefined || page.height !== undefined))
			fail("page", `the page size "${String(page.size)}" sets its own width and height; remove them or use "custom"`);
		const box = isRec(page.margin) ? safeTileBox(page, page.margin, schema) : null;
		if (box && (box.width < 72 || box.height < 72))
			fail(
				"page",
				page.tile
					? `each tile is ${Math.round(box.width)} x ${Math.round(box.height)} pt; a tile needs at least 72 x 72 pt`
					: "the margins leave less than 72 pt for the content",
			);
		for (const name of ["header", "footer"] as const) {
			const region = page[name];
			if (!isRec(region)) continue;
			ctx.region = name;
			for (const [i, block] of list(region.content).entries()) {
				if (isRec(block) && block.type === "pageBreak")
					fail(`page.${name}.content[${i}]`, `a page break cannot sit in the ${name}`);
				checkNode(block, `page.${name}.content[${i}]`, ctx, ["block"]);
			}
			ctx.region = null;
		}
	}

	if (isRec(doc.body)) {
		if (doc.body.type !== "doc") fail("body", `the body is a "doc" node, not "${String(doc.body.type)}"`);
		else checkNode(doc.body, "body", ctx, ["root"]);
	}

	for (const ref of ctx.fieldRefs) {
		const field = ctx.fields.get(ref.key);
		if (!field) fail(ref.path, `the merge field "${String(ref.key)}" is not declared in "fields"`);
		else if (ref.list && field.type !== "list")
			fail(ref.path, `the table reads "${String(ref.key)}", which is a ${String(field.type)} field, not a list`);
		else if (!ref.list && field.type === "list")
			fail(ref.path, `the merge field "${String(ref.key)}" is a list; only a table can read it`);
	}
	if (Array.isArray(doc.exports) && doc.exports.includes("xlsx") && ctx.ledgers === 0)
		fail("exports", "XLSX export needs at least one ledger table (a budget) in the body");
	if (ctx.nodes > schema.limits.nodes)
		fail("body", `the document holds ${ctx.nodes} nodes; the limit is ${schema.limits.nodes}`);
	const bytes = JSON.stringify(doc).length;
	if (bytes > schema.limits.jsonBytes)
		fail("(root)", `the document is ${bytes} bytes; the limit is ${schema.limits.jsonBytes}`);
	return { ok: errors.length === 0, errors };
}

const pageSize = (value: unknown, schema: FormatSchema): value is PageSize =>
	value === "custom" || (typeof value === "string" && Object.hasOwn(schema.pageSizes, value));
const points = (value: unknown) => (typeof value === "number" ? value : undefined);

function safeTileBox(page: Rec, margin: Rec, schema: FormatSchema) {
	const { top, right, bottom, left } = margin;
	const tile = isRec(page.tile) ? page.tile : null;
	if (typeof top !== "number" || typeof right !== "number" || typeof bottom !== "number" || typeof left !== "number")
		return null;
	if (page.tile && !tile) return null;
	const across = tile?.across;
	const down = tile?.down;
	if (tile && (typeof across !== "number" || typeof down !== "number")) return null;
	if (!pageSize(page.size, schema)) return null;
	return tileBox(
		{
			size: page.size,
			width: points(page.width),
			height: points(page.height),
			orientation: page.orientation === "landscape" ? "landscape" : "portrait",
			margin: { top, right, bottom, left },
			tile: typeof across === "number" && typeof down === "number" ? { across, down } : null,
		},
		schema,
	);
}

function checkNode(node: unknown, path: string, ctx: Ctx, allowed: string[], deny: string[] = []) {
	const { schema, fail } = ctx;
	if (!isRec(node)) {
		fail(path, "a node must be an object with a type");
		return;
	}
	const spec = schema.nodes[String(node.type)];
	if (!spec || !Object.hasOwn(schema.nodes, String(node.type))) {
		fail(path, `unknown node type "${String(node.type)}"`);
		return;
	}
	const type = String(node.type);
	const where = `${path} (${type})`;
	if (type === "if" && !allowed.includes("block")) {
		fail(
			where,
			`conditional text can sit only in the body, a column or a box, not in a ${ctx.ancestors.at(-1) ?? "page"}`,
		);
		return;
	}
	if (!allowed.includes(spec.group) && !allowed.includes(type)) {
		fail(where, `a ${type} node is not allowed here; this place takes ${allowed.join(" or ")}`);
		return;
	}
	if (deny.includes(type)) {
		fail(where, `a ${type} node cannot sit inside this container`);
		return;
	}
	ctx.nodes += 1;
	const known = new Set(["type", "attrs", "content", ...(spec.text ? ["text", "marks"] : [])]);
	for (const k of Object.keys(node)) if (!known.has(k)) fail(where, `unknown key "${k}" on a ${type} node`);

	const attrs: Rec = isRec(node.attrs) ? node.attrs : {};
	if (node.attrs !== undefined && !isRec(node.attrs)) fail(where, "attrs must be an object");
	for (const k of Object.keys(attrs))
		if (!Object.hasOwn(spec.attrs, k)) fail(where, `unknown attribute "${k}" on a ${type} node`);
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
			if (node.text.length > schema.limits.textLength)
				fail(where, `the text is longer than ${schema.limits.textLength} characters`);
			if (node.text.includes("\0") || LONE_SURROGATE.test(node.text))
				fail(where, "the text holds a character that cannot print");
		}
		if (node.marks !== undefined) {
			if (!Array.isArray(node.marks)) fail(where, "marks must be a list");
			else {
				const seen = new Set<string>();
				for (const [mi, mark] of node.marks.entries()) {
					const mtype = isRec(mark) ? String(mark.type) : String(mark);
					const mspec = Object.hasOwn(schema.marks, mtype) ? schema.marks[mtype] : undefined;
					if (!mspec || !isRec(mark)) {
						fail(`${where}.marks[${mi}]`, `unknown mark "${mtype}"`);
						continue;
					}
					if (seen.has(mtype)) fail(`${where}.marks[${mi}]`, `the mark "${mtype}" is applied twice`);
					seen.add(mtype);
					checkObject(mark.attrs ?? {}, mspec.attrs, `${where}.marks[${mi}].attrs`, ctx);
				}
			}
		}
	}

	if (spec.content === null) {
		if (node.content !== undefined) fail(where, `a ${type} node holds no content`);
	} else {
		const content = node.content ?? [];
		if (!Array.isArray(content)) fail(where, "content must be a list");
		else {
			const { min = 0, max } = spec.content;
			if (content.length < min) fail(where, `a ${type} node needs at least ${min} child node${min === 1 ? "" : "s"}`);
			if (max !== undefined && content.length > max) fail(where, `a ${type} node holds at most ${max} child nodes`);
			const passDeny = type === "column" || type === "box" || type === "if";
			const childDeny = [...(spec.content.deny ?? []), ...(passDeny ? deny : [])];
			const allow = spec.content.allow;
			ctx.ancestors.push(type);
			content.forEach((child, i) => checkNode(child, `${path}.content[${i}]`, ctx, allow, childDeny));
			ctx.ancestors.pop();
		}
	}

	if (type === "field") ctx.fieldRefs.push({ key: attrs.key, path: where });
	if (type === "pageNumber" && !ctx.region) fail(where, "a page number can sit only in the page header or footer");
	if (type === "writeIn" && typeof attrs.key === "string") {
		const prior = ctx.writeIns.get(attrs.key);
		if (prior)
			fail(where, `the write-in key "${attrs.key}" is already used at ${prior}; PDF form fields need unique names`);
		else ctx.writeIns.set(attrs.key, where);
	}
	if (type === "table" && Array.isArray(attrs.columns)) checkTable(node, attrs, where, ctx);
	if (type === "if") checkCondition(node, attrs, where, ctx);
	if (ctx.ancestors.includes("if")) {
		if (type === "slot") fail(where, "a section slot cannot sit inside conditional text");
		if (type === "table" && attrs.style === "ledger")
			fail(where, "a budget table cannot sit inside conditional text; the Excel file prints no conditions");
	}
}

function checkCondition(node: Rec, attrs: Rec, where: string, ctx: Ctx) {
	const { fail } = ctx;
	if (ctx.region) fail(where, `conditional text cannot sit in the page ${ctx.region}; it prints in the body only`);
	if (ctx.ancestors.includes("if")) fail(where, "conditional text cannot hold another conditional text");
	if (list(node.content).length === 0) fail(where, "conditional text holds at least one block");
	const field = ctx.fields.get(attrs.field);
	if (typeof attrs.field === "string" && !field)
		fail(where, `the condition reads the field "${attrs.field}", which is not declared in "fields"`);
	if (attrs.test === "more-than") {
		if (field && field.type !== "number" && field.type !== "list")
			fail(
				where,
				`a more-than condition compares a number or a list; "${String(attrs.field)}" is a ${String(field.type)} field`,
			);
		if (attrs.value === undefined) fail(where, "a more-than condition needs a value: a whole number from 0");
		else if (typeof attrs.value === "number" && attrs.value < 0)
			fail(where, `the condition's value is ${attrs.value}; a more-than condition compares with a whole number from 0`);
	} else if (attrs.value !== undefined)
		fail(where, `only a more-than condition has a value; this condition tests "${String(attrs.test)}"`);
}

function checkTable(node: Rec, attrs: Rec, where: string, ctx: Ctx) {
	const { fail } = ctx;
	const cols = attrs.columns as unknown[];
	const ids = cols.map((c) => (isRec(c) ? c.id : undefined));
	const seen = new Set<unknown>();
	cols.forEach((c, ci) => {
		if (!isRec(c)) return;
		const at = `${where}.attrs.columns[${ci}]`;
		if (seen.has(c.id)) fail(at, `the column id "${String(c.id)}" is used twice`);
		seen.add(c.id);
		if (c.type === "formula") {
			if (typeof c.formula !== "string") {
				fail(at, `the formula column "${String(c.id)}" needs a formula`);
				return;
			}
			let tree: Formula;
			try {
				tree = parseFormula(c.formula);
			} catch (e) {
				fail(at, (e as Error).message);
				return;
			}
			for (const ref of formulaRefs(tree, ids as string[])) {
				const ri = ids.indexOf(ref);
				const col = cols[ri];
				if (ri < 0) fail(at, `the formula reads the column "${ref}", which this table does not have`);
				else if (ri >= ci) fail(at, `the formula reads "${ref}"; a formula reads only columns to its left`);
				else if (isRec(col) && !NUMERIC.has(String(col.type)) && col.type !== "formula")
					fail(
						at,
						`the formula reads "${ref}", a ${String(col.type)} column; it can read only number, money or formula columns`,
					);
			}
		} else if (c.formula !== undefined)
			fail(at, `only a formula column has a formula; "${String(c.id)}" is a ${String(c.type)} column`);
	});
	if (attrs.source) ctx.fieldRefs.push({ key: attrs.source, path: where, list: true });
	const ledger = attrs.style === "ledger";
	if (ledger) ctx.ledgers += 1;
	let groupOpen = false;
	list(node.content).forEach((row, ri) => {
		if (!isRec(row) || row.type !== "row") return;
		const at = `${where}.content[${ri}] (row ${ri + 1})`;
		const rowAttrs = isRec(row.attrs) ? row.attrs : {};
		const role = rowAttrs.role ?? "item";
		const cells = list(row.content);
		if (cells.length !== cols.length)
			fail(
				at,
				`the row has ${cells.length} cell${cells.length === 1 ? "" : "s"} but the table has ${cols.length} columns`,
			);
		if (role !== "item" && !ledger)
			fail(at, `a ${String(role)} row needs a ledger table; this table's style is "${String(attrs.style ?? "grid")}"`);
		if (role === "group") groupOpen = true;
		if (role === "subtotal" && !groupOpen)
			fail(at, "a subtotal row adds a category, so a group row must come before it");
		if (rowAttrs.sign !== undefined && role !== "group") fail(at, "only a group row has a sign");
		cells.forEach((cell, ci) => {
			const col = cols[ci];
			if (!isRec(col) || !isRec(cell) || cell.type !== "cell") return;
			const cat = `${at}.cell[${ci}] (column "${String(col.id)}")`;
			const cellAttrs = isRec(cell.attrs) ? cell.attrs : {};
			const value = cellAttrs.value;
			const hasText = list(cell.content).length > 0;
			if (value !== undefined && value !== null) {
				if (!NUMERIC.has(String(col.type)))
					fail(cat, `only a number or money column holds a value; this is a ${String(col.type)} column`);
				else if (role !== "item") fail(cat, `a ${String(role)} row computes its numbers; it holds no typed value`);
			}
			if (cellAttrs.checked && col.type !== "check") fail(cat, "only a check column can be checked");
			if (hasText && col.type !== "text") fail(cat, `a ${String(col.type)} cell holds no text`);
		});
	});
}

function checkValue(value: unknown, spec: ValueSpec, path: string, ctx: Ctx) {
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
			if (!(spec.values ?? []).includes(value as string))
				fail(path, `${JSON.stringify(value)} is not one of ${(spec.values ?? []).join(", ")}`);
			return;
		case "token":
			if (!schema.tokens.color.includes(value as string))
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
				if (spec.pattern && !new RegExp(spec.pattern).test(value))
					fail(path, `${JSON.stringify(value)} does not match ${spec.pattern}`);
			}
			return;
		case "slug":
			if (typeof value !== "string" || !SLUG.test(value))
				fail(path, `${JSON.stringify(value)} is not an id (lowercase letters, digits and hyphens)`);
			return;
		case "key":
			if (typeof value !== "string" || !KEY.test(value))
				fail(path, `${JSON.stringify(value)} is not a key (lowercase letters, digits and underscores)`);
			return;
		case "list":
			if (!Array.isArray(value)) fail(path, "must be a list");
			else {
				if (spec.min !== undefined && value.length < spec.min)
					fail(path, `needs at least ${spec.min} entr${spec.min === 1 ? "y" : "ies"}`);
				if (spec.max !== undefined && value.length > spec.max) fail(path, `holds at most ${spec.max} entries`);
				const of = spec.of;
				if (of) value.forEach((v, i) => checkValue(v, of, `${path}[${i}]`, ctx));
			}
			return;
		case "object":
			checkObject(value, spec.props ?? {}, path, ctx);
			return;
		case "map":
			if (!isRec(value)) fail(path, "must be an object of values by field key");
			return;
		case "page":
			checkObject(value, schema.page, path, ctx);
			return;
		case "region":
			checkObject(value, schema.region, path, ctx);
			return;
		case "blocks":
			if (!Array.isArray(value)) fail(path, "must be a list of blocks");
			return;
		case "node":
			if (!value || typeof value !== "object") fail(path, "must be a node");
			return;
	}
}

export function attrIssue(node: string, attribute: string, value: unknown): string | null {
	const spec = FORMAT_SCHEMA.nodes[node]?.attrs[attribute];
	if (!spec) return null;
	let message: string | null = null;
	const ctx = {
		schema: FORMAT_SCHEMA,
		fail: (_path: string, text: string) => {
			message ??= text;
		},
	} as Ctx;
	checkValue(value, spec, attribute, ctx);
	return message;
}

function checkObject(value: unknown, props: Record<string, ValueSpec>, path: string, ctx: Ctx, root = false) {
	const { fail } = ctx;
	if (!isRec(value)) {
		fail(path, "must be an object");
		return;
	}
	const prefix = root ? "" : `${path}.`;
	for (const k of Object.keys(value))
		if (!Object.hasOwn(props, k)) fail(root ? k : `${path}.${k}`, `unknown key "${k}"`);
	for (const [k, spec] of Object.entries(props)) {
		if (value[k] === undefined) {
			if (!spec.optional) fail(root ? k : `${path}.${k}`, "is required");
			continue;
		}
		checkValue(value[k], spec, `${prefix}${k}`, ctx);
	}
}

type AttrsOf<N> = N extends { attrs?: infer A } ? Required<NonNullable<A>> : never;

export function attrsOf<N extends AnyNode>(node: N): AttrsOf<N> {
	const spec = FORMAT_SCHEMA.nodes[node.type];
	const out: Rec = {};
	for (const [k, aspec] of Object.entries(spec?.attrs ?? {})) out[k] = aspec.default;
	return { ...out, ...("attrs" in node ? node.attrs : {}) } as AttrsOf<N>;
}

export async function templateHash(template: DocTemplate) {
	const bytes = new TextEncoder().encode(canonical(template));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function forkTemplate(
	template: DocTemplate,
	{ id, data = {} }: { id?: string; data?: Record<string, unknown> } = {},
): Promise<DocDocument> {
	if (template.kind !== "template") throw new Error("only a template can be forked");
	const copy = structuredClone(template);
	const values: Record<string, unknown> = {};
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

export function templateFromDocument(
	doc: DocDocument,
	{ id, title, description, version }: { id: string; title: string; description?: string; version: number },
): DocTemplate {
	const copy = structuredClone(doc);
	return {
		format: copy.format,
		kind: "template",
		id,
		version,
		title,
		...(description ? { description } : {}),
		class: copy.class,
		exports: copy.exports,
		fields: copy.fields,
		page: copy.page,
		body: copy.body,
	};
}
