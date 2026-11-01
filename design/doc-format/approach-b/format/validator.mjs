// The validator of the approach B format. It has two layers:
// 1. A JSON Schema check of format/schema.json. It implements the subset of draft 2020-12 that the schema uses
//    ($ref to #/$defs, type, const, enum, required, properties, additionalProperties: false, items, min/max items,
//    min/max length, pattern, minimum, maximum, oneOf).
// 2. The rules JSON Schema cannot state: unique ids, declared fields, table shape, ledger references, page fit.
// It has no dependencies, so `node tools/validate.mjs` and the prototype in a browser run the same code.
import { PAGE_PRESETS, pageBox, sheetBox, walkBlocks, inlineListsOf } from "./model.mjs";

const jsonType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeMatches = (want, v) => {
	const got = jsonType(v);
	return want === got || (want === "number" && got === "integer");
};

function resolve(schema, root) {
	if (!schema.$ref) return schema;
	const name = schema.$ref.replace(/^#\/\$defs\//, "");
	const target = root.$defs?.[name];
	if (!target) throw new Error(`The schema has no $defs entry ${schema.$ref}.`);
	return resolve(target, root);
}

/** The branches of a oneOf that can apply to a value, by JSON type and by its `type` discriminator. */
function candidates(branches, value, root) {
	return branches.filter((raw) => {
		const b = resolve(raw, root);
		if (b.type && !typeMatches(b.type, value)) return false;
		if (b.const !== undefined && b.const !== value) return false;
		const disc = b.properties?.type;
		if (disc && value && typeof value === "object" && !Array.isArray(value)) {
			if (disc.const !== undefined && disc.const !== value.type) return false;
			if (disc.enum && !disc.enum.includes(value.type)) return false;
		}
		return true;
	});
}

function check(schema, value, path, root, errors) {
	const s = resolve(schema, root);
	if (s.oneOf) {
		const passing = s.oneOf.filter((b) => {
			const e = [];
			check(b, value, path, root, e);
			return e.length === 0;
		});
		if (passing.length === 1) return;
		if (passing.length > 1) {
			errors.push(`${path}: matches more than one allowed shape.`);
			return;
		}
		const fit = candidates(s.oneOf, value, root);
		if (fit.length === 1) return check(fit[0], value, path, root, errors);
		const kind = value && typeof value === "object" && "type" in value ? ` of type "${value.type}"` : "";
		errors.push(`${path}: is not an allowed value${kind}.`);
		return;
	}
	if (s.const !== undefined && value !== s.const) errors.push(`${path}: must be ${JSON.stringify(s.const)}.`);
	if (s.enum && !s.enum.includes(value)) errors.push(`${path}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}.`);
	if (s.type && !typeMatches(s.type, value)) {
		errors.push(`${path}: must be ${s.type}, not ${jsonType(value)}.`);
		return;
	}
	if (typeof value === "string") {
		if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: is shorter than ${s.minLength}.`);
		if (s.maxLength !== undefined && value.length > s.maxLength) errors.push(`${path}: is longer than ${s.maxLength}.`);
		if (s.pattern && !new RegExp(s.pattern, "u").test(value)) errors.push(`${path}: does not match ${s.pattern}.`);
	}
	if (typeof value === "number") {
		if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: is less than ${s.minimum}.`);
		if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: is more than ${s.maximum}.`);
	}
	if (Array.isArray(value)) {
		if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: needs at least ${s.minItems} items.`);
		if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: holds more than ${s.maxItems} items.`);
		if (s.items) value.forEach((item, i) => check(s.items, item, `${path}[${i}]`, root, errors));
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const key of s.required ?? []) if (!(key in value)) errors.push(`${path}: is missing "${key}".`);
		for (const [key, v] of Object.entries(value)) {
			const prop = s.properties?.[key];
			if (prop) check(prop, v, `${path}/${key}`, root, errors);
			else if (s.additionalProperties === false) errors.push(`${path}: has an unknown property "${key}".`);
		}
	}
}

const PROSE = new Set(["heading", "paragraph", "list", "quote"]);
const TOP_LEVEL_ONLY = new Set(["ledger", "ledgerSummary", "pageBreak"]);

/** The rules the JSON Schema cannot state. Runs only on a document that passed the schema. */
function crossCheck(doc, errors) {
	const ids = new Map();
	const claim = (id, path) => {
		if (ids.has(id)) errors.push(`${path}: id "${id}" is already used at ${ids.get(id)}.`);
		else ids.set(id, path);
	};
	const declared = new Set();
	doc.fields.forEach((f, i) => {
		if (declared.has(f.key)) errors.push(`/fields[${i}]: field key "${f.key}" is declared twice.`);
		declared.add(f.key);
	});
	const needField = (key, path) => {
		if (key && !declared.has(key)) errors.push(`${path}: field "${key}" is not declared in /fields.`);
	};

	// Page setup.
	const { page } = doc;
	if (page.size === "custom" && (page.width === undefined || page.height === undefined))
		errors.push("/page: a custom size needs width and height.");
	if (page.size !== "custom" && (page.width !== undefined || page.height !== undefined))
		errors.push("/page: width and height belong only to a custom size.");
	if (page.size === "custom" ? page.width && page.height : PAGE_PRESETS[page.size]) {
		const box = pageBox(page);
		const m = page.margins;
		if (m.left + m.right >= box.width - 36 || m.top + m.bottom >= box.height - 36)
			errors.push("/page/margins: the margins leave less than half an inch for content.");
		if (page.imposition && !sheetBox(page))
			errors.push(
				`/page/imposition: ${page.imposition.across} × ${page.imposition.down} pages of this size do not fit on one ${page.imposition.sheet} sheet.`,
			);
	}
	if (doc.class === "formal/legal" && !doc.notices.includes("template-not-legal-advice"))
		errors.push('/notices: a formal/legal document carries the "template-not-legal-advice" notice.');

	// Blocks.
	const ledgers = new Map();
	const sheets = new Map();
	const summaries = [];
	walkBlocks(doc, (block, path) => {
		claim(block.id, path);
		const topLevel = /^\/body\[\d+\]$/.test(path);
		if (TOP_LEVEL_ONLY.has(block.type) && !topLevel)
			errors.push(`${path}: a ${block.type} block sits only at the top level of the body.`);
		for (const [list, at] of inlineListsOf(block, path))
			list.forEach((node, i) => {
				if (node.type === "field") needField(node.key, `${at}[${i}]`);
				if (node.type === "pageNumber" && path.startsWith("/body"))
					errors.push(`${at}[${i}]: a page number sits only in the header or the footer.`);
			});
		if (block.type === "list") block.items.forEach((item, i) => claim(item.id, `${path}.items[${i}]`));
		if (block.type === "slot")
			block.blocks.forEach((child, i) => {
				if (!PROSE.has(child.type))
					errors.push(`${path}.blocks[${i}]: a slot holds only headings, paragraphs, lists and quotes.`);
			});
		if (block.type === "fillRow") block.cells.forEach((cell, i) => needField(cell.field, `${path}.cells[${i}]`));
		if (block.type === "table") {
			const width = block.columns.length;
			if (block.repeat && block.rows.length !== 1)
				errors.push(`${path}: a repeating table has exactly one row, the row it repeats.`);
			block.rows.forEach((row, r) => {
				claim(row.id, `${path}.rows[${r}]`);
				if (row.cells.length !== width)
					errors.push(`${path}.rows[${r}]: has ${row.cells.length} cells for ${width} columns.`);
				row.cells.forEach((cell, c) => {
					const at = `${path}.rows[${r}].cells[${c}]`;
					if (cell.type === "fill") needField(cell.field, at);
					if (cell.type === "counter" && !block.repeat) errors.push(`${at}: a counter cell needs a repeating table.`);
					if (cell.type === "data" && !block.repeat?.source)
						errors.push(`${at}: a data cell needs a repeating table with a source.`);
				});
			});
		}
		if (block.type === "ledger") {
			ledgers.set(block.id, block);
			if (sheets.has(block.sheet)) errors.push(`${path}: sheet name "${block.sheet}" is already used.`);
			sheets.set(block.sheet, path);
			const n = block.periods.count;
			if (n > 1 && !block.periods.label.includes("{n}"))
				errors.push(`${path}.periods: a label for more than one period holds "{n}".`);
			if (block.total.rule === "times" && n !== 1)
				errors.push(`${path}.total: the "times" rule works on exactly one period.`);
			if (block.total.rule === "times" && block.total.factor === undefined)
				errors.push(`${path}.total: the "times" rule needs a factor.`);
			const groupIds = new Set();
			block.groups.forEach((group, g) => {
				claim(group.id, `${path}.groups[${g}]`);
				groupIds.add(group.id);
				group.lines.forEach((line, l) => {
					const at = `${path}.groups[${g}].lines[${l}]`;
					claim(line.id, at);
					if (line.amounts.length !== n) errors.push(`${at}: has ${line.amounts.length} amounts for ${n} periods.`);
				});
			});
			block.results.forEach((result, r) => {
				claim(result.id, `${path}.results[${r}]`);
				if (!result.plus.length && !result.minus.length)
					errors.push(`${path}.results[${r}]: names no group in plus or minus.`);
				for (const id of [...result.plus, ...result.minus])
					if (!groupIds.has(id)) errors.push(`${path}.results[${r}]: group "${id}" is not in this ledger.`);
			});
		}
		if (block.type === "ledgerSummary") {
			summaries.push([block, path]);
			if (sheets.has(block.sheet)) errors.push(`${path}: sheet name "${block.sheet}" is already used.`);
			sheets.set(block.sheet, path);
		}
	});
	for (const [summary, path] of summaries)
		if (!ledgers.has(summary.ledger)) errors.push(`${path}: ledger "${summary.ledger}" is not in this document.`);
}

/** All problems of a document, as "path: message" strings. An empty list means the document is valid. */
export function validateDocument(doc, schema) {
	const errors = [];
	check(schema, doc, "", schema, errors);
	if (errors.length === 0) crossCheck(doc, errors);
	return errors;
}
