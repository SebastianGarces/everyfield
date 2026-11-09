// "Compare with the current template" (Approach A, "Versioning and forking"): a two-way, block-level compare of a
// document with the template it was forked from, and the document that accepting some of the differences makes.
// Pure: the caller supplies the template, the origin to record and the merge values of any field the document lacks.
import { FORMAT_SCHEMA } from "./schema.ts";
import type { BlockNode, DocDocument, DocTemplate, FieldDecl, Origin, PageSetup, Region } from "./types.ts";

/** "In template only", "In your document only" or "Changed". */
export type DifferenceKind = "template-only" | "document-only" | "changed";
/** The page setup without its header and footer, which are listed on their own. */
export type PageLayout = Omit<PageSetup, "header" | "footer">;

/** One difference, numbered in reading order. `document` is null for "In template only", `template` for the reverse. */
export type DocDifference = { id: number } & DifferenceOf;
type DifferenceOf =
	| { part: "title"; kind: "changed"; document: string; template: string }
	| { part: "page"; kind: "changed"; document: PageLayout; template: PageLayout }
	| { part: "header" | "footer"; kind: DifferenceKind; document: Region | null; template: Region | null }
	| { part: "body"; kind: DifferenceKind; document: BlockNode | null; template: BlockNode | null };

type Rec = { [key: string]: unknown };
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The comparable form of a value: attributes filled with the schema's defaults and limited to the declared ones,
 * no empty `attrs` or `content`, adjacent text runs with the same marks joined, keys sorted. The editor writes every
 * default and a template leaves them out; both mean the same block, so both have the same form.
 */
function normal(value: unknown): unknown {
	if (Array.isArray(value)) return joinText(value.map(normal));
	if (!isRec(value)) return value;
	const spec = typeof value.type === "string" ? FORMAT_SCHEMA.nodes[value.type] : undefined;
	const out: Rec = {};
	for (const key of Object.keys(value).sort()) {
		if (value[key] === undefined) continue;
		if (key === "attrs" && spec) {
			const attrs: Rec = {};
			const given = isRec(value.attrs) ? value.attrs : {};
			for (const name of Object.keys(spec.attrs).sort()) {
				const v = given[name] ?? spec.attrs[name]!.default;
				if (v !== undefined) attrs[name] = normal(v);
			}
			if (Object.keys(attrs).length) out.attrs = attrs;
			continue;
		}
		if (key === "marks" && Array.isArray(value.marks)) {
			const marks = value.marks.filter(isRec).map((mark) => {
				const declared = FORMAT_SCHEMA.marks[String(mark.type)]?.attrs ?? {};
				const attrs: Rec = {};
				for (const name of Object.keys(declared).sort())
					if (isRec(mark.attrs) && mark.attrs[name] !== undefined) attrs[name] = mark.attrs[name];
				return Object.keys(attrs).length ? { attrs, type: mark.type } : { type: mark.type };
			});
			if (marks.length) out.marks = marks;
			continue;
		}
		const next = normal(value[key]);
		if (key === "content" && Array.isArray(next) && next.length === 0) continue;
		out[key] = next;
	}
	return out;
}

function joinText(nodes: unknown[]) {
	const out: unknown[] = [];
	for (const node of nodes) {
		const last = out.at(-1);
		if (
			isRec(node) &&
			isRec(last) &&
			node.type === "text" &&
			last.type === "text" &&
			JSON.stringify(node.marks ?? null) === JSON.stringify(last.marks ?? null)
		) {
			out[out.length - 1] = { ...last, text: String(last.text) + String(node.text) };
		} else out.push(node);
	}
	return out;
}

const key = (value: unknown) => JSON.stringify(normal(value));

/** A header or footer with no blocks prints nothing, so it counts as no region. */
const region = (value: Region | null | undefined): Region | null => (value?.content?.length ? value : null);
const layout = ({ header: _h, footer: _f, ...rest }: PageSetup): PageLayout => rest;
const PAGE_DEFAULTS = { tile: null };
const pageKey = (page: PageSetup) => key({ ...PAGE_DEFAULTS, ...layout(page) });

type Step =
	| { op: "same"; document: BlockNode }
	| { op: "changed"; document: BlockNode; template: BlockNode }
	| { op: "document-only"; document: BlockNode }
	| { op: "template-only"; template: BlockNode };

/**
 * The body in reading order as an alignment of the two block lists. An identical block always outweighs any number of
 * pairs, so the alignment keeps the most unchanged blocks; between them, a document block and a template block of the
 * same kind pair up as "Changed", and the rest are in one side only.
 */
function align(doc: readonly BlockNode[], tpl: readonly BlockNode[]): Step[] {
	const a = doc.map(key);
	const b = tpl.map(key);
	const n = doc.length;
	const m = tpl.length;
	const same = n + m + 1;
	const score = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--) {
			const pair = a[i] === b[j] ? same : doc[i]!.type === tpl[j]!.type ? 1 : -1;
			score[i]![j] = Math.max(score[i + 1]![j]!, score[i]![j + 1]!, pair > 0 ? pair + score[i + 1]![j + 1]! : -1);
		}
	const steps: Step[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m) {
			const pair = a[i] === b[j] ? same : doc[i]!.type === tpl[j]!.type ? 1 : -1;
			if (pair > 0 && score[i]![j] === pair + score[i + 1]![j + 1]!) {
				steps.push(
					pair === same ? { op: "same", document: doc[i]! } : { op: "changed", document: doc[i]!, template: tpl[j]! },
				);
				i++;
				j++;
				continue;
			}
			// A removed document block reads before the template block that takes its place.
			if (score[i]![j] === score[i + 1]![j]) {
				steps.push({ op: "document-only", document: doc[i++]! });
				continue;
			}
			steps.push({ op: "template-only", template: tpl[j++]! });
			continue;
		}
		if (i < n) steps.push({ op: "document-only", document: doc[i++]! });
		else steps.push({ op: "template-only", template: tpl[j++]! });
	}
	return steps;
}

type Plan = { differences: DocDifference[]; steps: Step[] };

function plan(doc: DocDocument, template: DocTemplate): Plan {
	const differences: DocDifference[] = [];
	const add = (d: DifferenceOf) => differences.push({ id: differences.length, ...d });
	if (doc.title !== template.title)
		add({ part: "title", kind: "changed", document: doc.title, template: template.title });
	if (pageKey(doc.page) !== pageKey(template.page))
		add({ part: "page", kind: "changed", document: layout(doc.page), template: layout(template.page) });
	const regionDiff = (part: "header" | "footer") => {
		const mine = region(doc.page[part]);
		const theirs = region(template.page[part]);
		if (key(mine) === key(theirs)) return;
		const kind: DifferenceKind = !mine ? "template-only" : !theirs ? "document-only" : "changed";
		add({ part, kind, document: mine, template: theirs });
	};
	regionDiff("header");
	const steps = align(doc.body.content ?? [], template.body.content ?? []);
	for (const step of steps) {
		if (step.op === "same") continue;
		add({
			part: "body",
			kind: step.op,
			document: "document" in step ? step.document : null,
			template: "template" in step ? step.template : null,
		});
	}
	regionDiff("footer");
	return { differences, steps };
}

/**
 * Every difference between a document and the current template, in reading order: the title, the page setup, the
 * header, the body block by block, then the footer. Merge fields compare by key, so a field whose value differs is
 * not a difference. Nothing outside the body is compared: the legal notice is never part of a document.
 */
export function compareWithTemplate(doc: DocDocument, template: DocTemplate): DocDifference[] {
	return plan(doc, template).differences;
}

/** The template fields a document does not declare. Accepting adds them, with their frozen values. */
export const missingFields = (doc: DocDocument, template: DocTemplate): FieldDecl[] =>
	template.fields.filter((field) => !doc.fields.some((mine) => mine.key === field.key));

/**
 * The document after accepting the differences numbered in `accepted` ("all" accepts every one). An accepted
 * difference takes the template's side: a template block is added or replaces the document's, a document-only block is
 * removed. Every other block keeps the document's version. The document records `origin`, declares the template's
 * fields it lacked and freezes `values` for them.
 */
export function acceptDifferences(
	doc: DocDocument,
	template: DocTemplate,
	accepted: readonly number[] | "all",
	{ origin, values }: { origin: Origin; values: Record<string, unknown> },
): DocDocument {
	const { differences, steps } = plan(doc, template);
	const taken = new Set(accepted === "all" ? differences.map((d) => d.id) : accepted);
	const take = (part: DocDifference["part"]) => {
		const found = differences.find((d) => d.part === part);
		return found && taken.has(found.id) ? found : null;
	};
	const blocks: BlockNode[] = [];
	const bodyDiffs = differences.filter((d) => d.part === "body");
	let at = 0;
	for (const step of steps) {
		if (step.op === "same") {
			blocks.push(step.document);
			continue;
		}
		const yes = taken.has(bodyDiffs[at++]!.id);
		if (step.op === "changed") blocks.push(yes ? step.template : step.document);
		else if (step.op === "template-only") {
			if (yes) blocks.push(step.template);
		} else if (!yes) blocks.push(step.document);
	}
	const page: PageSetup = take("page") ? { ...template.page } : { ...doc.page };
	for (const part of ["header", "footer"] as const) {
		const chosen = take(part) ? template.page[part] : doc.page[part];
		if (chosen === undefined) delete page[part];
		else page[part] = chosen;
	}
	const added = missingFields(doc, template);
	const data = { ...doc.data };
	for (const field of added) if (values[field.key] !== undefined) data[field.key] = values[field.key];
	return structuredClone({
		...doc,
		title: take("title") ? template.title : doc.title,
		origin,
		fields: [...doc.fields, ...added],
		data,
		page,
		body: { type: "doc", ...(blocks.length ? { content: blocks } : {}) },
	});
}
