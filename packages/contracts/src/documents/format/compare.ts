// "Compare with template" (Approach A, "Versioning and forking"). Two lists of a document beside its template:
// "All differences" (T-19), a two-way, block-level compare with the template's current version; and "Template changes"
// (T-81, D-423), a three-way compare that lists only what the template changed between the version the document
// records (the base) and the current one, so the church's own edits are not listed. Each has the document that
// accepting some of its items makes. Pure: the caller supplies the templates, the origin to record and the merge
// values of any field the document lacks.
import { FORMAT_SCHEMA } from "./schema.ts";
import type { BlockNode, DocDocument, DocTemplate, FieldDecl, Origin, PageSetup, Region } from "./types.ts";

/**
 * What an item is, each with its own words. "All differences": "In template only", "In your document only" or
 * "Changed". "Template changes": "In template only" (added), "Removed from template", "Changed", or "Changed in
 * template and in your document" (`both`, D-424) when the church had changed what the template changed.
 */
type DifferenceKind = "template-only" | "document-only" | "changed" | "removed" | "both";
/** The page setup without its header and footer, which are listed on their own. */
export type PageLayout = Omit<PageSetup, "header" | "footer">;

/**
 * One item, numbered in reading order. `document` is the document's side, null when it has none ("In template only");
 * `template` is the current template's side, null for "In your document only", "Removed from template", or a block the
 * template removed that the church had changed.
 */
export type DocDifference = { id: number } & DifferenceOf;
type DifferenceOf =
	| { part: "title"; kind: "changed" | "both"; document: string; template: string }
	| { part: "page"; kind: "changed" | "both"; document: PageLayout; template: PageLayout }
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
	// A node the schema knows always gets its `attrs` step, so a block with no `attrs` at all still fills the defaults.
	const keys = new Set(Object.keys(value));
	if (spec) keys.add("attrs");
	for (const key of [...keys].sort()) {
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
		if (value[key] === undefined) continue;
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
/** Two values are the same when their comparable forms are: schema defaults filled, undeclared attributes dropped. */
export const sameKey = key;

/** A header or footer with no blocks prints nothing, so it counts as no region. */
const region = (value: Region | null | undefined): Region | null => (value?.content?.length ? value : null);
const layout = (page: PageSetup): PageLayout => {
	const rest: Partial<PageSetup> = { ...page };
	delete rest.header;
	delete rest.footer;
	return rest as PageLayout;
};
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

/** What an accept keeps or takes, part by part. A header or footer is the raw value, so an absent one stays absent. */
type Picked = {
	title: string;
	page: PageSetup;
	header: PageSetup["header"];
	footer: PageSetup["footer"];
	blocks: BlockNode[];
};
/** A list and the document parts that accepting the items numbered in `taken` gives. */
type Plan = { differences: DocDifference[]; apply: (taken: ReadonlySet<number>) => Picked };

/** "All differences": every difference between a document and a template, and what taking each gives. */
function twoWay(doc: DocDocument, template: DocTemplate): Plan {
	const differences: DocDifference[] = [];
	const add = (d: DifferenceOf) => differences.push({ id: differences.length, ...d }) - 1;
	const title =
		doc.title !== template.title
			? add({ part: "title", kind: "changed", document: doc.title, template: template.title })
			: null;
	const page =
		pageKey(doc.page) !== pageKey(template.page)
			? add({ part: "page", kind: "changed", document: layout(doc.page), template: layout(template.page) })
			: null;
	const regionDiff = (part: "header" | "footer") => {
		const mine = region(doc.page[part]);
		const theirs = region(template.page[part]);
		if (key(mine) === key(theirs)) return null;
		const kind: DifferenceKind = !mine ? "template-only" : !theirs ? "document-only" : "changed";
		return add({ part, kind, document: mine, template: theirs });
	};
	const header = regionDiff("header");
	const body = align(doc.body.content ?? [], template.body.content ?? []).map((step) => ({
		step,
		id:
			step.op === "same"
				? null
				: add({
						part: "body",
						kind: step.op,
						document: "document" in step ? step.document : null,
						template: "template" in step ? step.template : null,
					}),
	}));
	const footer = regionDiff("footer");
	return {
		differences,
		apply(taken) {
			const yes = (id: number | null) => id !== null && taken.has(id);
			const blocks: BlockNode[] = [];
			for (const { step, id } of body) {
				if (step.op === "same") blocks.push(step.document);
				else if (step.op === "changed") blocks.push(yes(id) ? step.template : step.document);
				else if (step.op === "template-only") {
					if (yes(id)) blocks.push(step.template);
				} else if (!yes(id)) blocks.push(step.document);
			}
			return {
				title: yes(title) ? template.title : doc.title,
				page: yes(page) ? template.page : doc.page,
				header: yes(header) ? template.page.header : doc.page.header,
				footer: yes(footer) ? template.page.footer : doc.page.footer,
				blocks,
			};
		},
	};
}

/** How one side moved from the base: what became of each base block, and the blocks it added before each one. */
type Track = {
	/** Per base block: the side's block, the same or edited, or null when the side removed it. */
	at: { block: BlockNode | null; edited: boolean }[];
	/** `inserts[k]` comes before base block k; the last one after the last block. */
	inserts: BlockNode[][];
};
function track(side: readonly BlockNode[], base: readonly BlockNode[]): Track {
	const out: Track = { at: [], inserts: [[]] };
	for (const step of align(side, base)) {
		if (step.op === "document-only") {
			out.inserts.at(-1)!.push(step.document);
			continue;
		}
		out.at.push(
			step.op === "template-only"
				? { block: null, edited: false }
				: { block: step.document, edited: step.op === "changed" },
		);
		out.inserts.push([]);
	}
	return out;
}

/**
 * "Template changes" (D-423, D-424): only what the template changed between `base` and `current`, each in its place
 * among the document's blocks. A change the document already has, or a block the template removed or reworded that
 * the document already removed, is not listed. Every block the template did not change keeps the document's version.
 */
function threeWay(doc: DocDocument, base: DocTemplate, current: DocTemplate): Plan {
	const differences: DocDifference[] = [];
	const add = (d: DifferenceOf) => differences.push({ id: differences.length, ...d }) - 1;
	/** One part with no blocks (title, page setup, header, footer): its item, or null when nothing is to take. */
	function part<T>(mine: T | null, was: T | null, now: T | null, listed: (kind: DifferenceKind) => DifferenceOf) {
		if (key(was) === key(now) || key(mine) === key(now)) return null;
		if (mine === null && was !== null) return null;
		return add(
			listed(key(mine) !== key(was) ? "both" : was === null ? "template-only" : now === null ? "removed" : "changed"),
		);
	}
	const title = part(doc.title, base.title, current.title, (kind) => ({
		part: "title",
		kind: kind as "changed" | "both",
		document: doc.title,
		template: current.title,
	}));
	const withDefaults = (page: PageSetup) => ({ ...PAGE_DEFAULTS, ...layout(page) });
	const page = part(withDefaults(doc.page), withDefaults(base.page), withDefaults(current.page), (kind) => ({
		part: "page",
		kind: kind as "changed" | "both",
		document: layout(doc.page),
		template: layout(current.page),
	}));
	const regionPart = (name: "header" | "footer") => {
		const [mine, now] = [region(doc.page[name]), region(current.page[name])];
		return part(mine, region(base.page[name]), now, (kind) => ({ part: name, kind, document: mine, template: now }));
	};
	const header = regionPart("header");

	// The body: the base's blocks in order, the blocks each side added before each one, then after the last.
	const baseBlocks = base.body.content ?? [];
	const mine = track(doc.body.content ?? [], baseBlocks);
	const theirs = track(current.body.content ?? [], baseBlocks);
	/** What one place prints: `keep` unless its item, `id`, is taken. */
	const slots: { keep: BlockNode[]; take: BlockNode[]; id: number | null }[] = [];
	for (let k = 0; k <= baseBlocks.length; k++) {
		const added = mine.inserts[k]!;
		slots.push({ keep: added, take: added, id: null });
		for (const block of theirs.inserts[k]!) {
			if (added.some((own) => key(own) === key(block))) continue;
			slots.push({
				keep: [],
				take: [block],
				id: add({ part: "body", kind: "template-only", document: null, template: block }),
			});
		}
		if (k === baseBlocks.length) break;
		const own = mine.at[k]!;
		const now = theirs.at[k]!;
		const keep = own.block ? [own.block] : [];
		if (!own.block || (now.block && !now.edited) || (now.block && key(now.block) === key(own.block))) {
			slots.push({ keep, take: keep, id: null });
			continue;
		}
		const kind: DifferenceKind = own.edited ? "both" : now.block ? "changed" : "removed";
		const id = add({ part: "body", kind, document: own.block, template: now.block });
		slots.push({ keep, take: now.block ? [now.block] : [], id });
	}
	const footer = regionPart("footer");
	return {
		differences,
		apply(taken) {
			const yes = (id: number | null) => id !== null && taken.has(id);
			return {
				title: yes(title) ? current.title : doc.title,
				page: yes(page) ? current.page : doc.page,
				header: yes(header) ? current.page.header : doc.page.header,
				footer: yes(footer) ? current.page.footer : doc.page.footer,
				blocks: slots.flatMap((slot) => (yes(slot.id) ? slot.take : slot.keep)),
			};
		},
	};
}

/**
 * Every difference between a document and the current template, in reading order: the title, the page setup, the
 * header, the body block by block, then the footer. Merge fields compare by key, so a field whose value differs is
 * not a difference. Nothing outside the body is compared: the legal notice is never part of a document.
 */
export function compareWithTemplate(doc: DocDocument, template: DocTemplate): DocDifference[] {
	return twoWay(doc, template).differences;
}

/**
 * "Template changes": what the template changed from `base`, the version the document records, to `current`, in
 * the same reading order and with the same field rule as `compareWithTemplate`. The church's own edits to blocks the
 * template did not change are not listed.
 */
export function templateChanges(doc: DocDocument, base: DocTemplate, current: DocTemplate): DocDifference[] {
	return threeWay(doc, base, current).differences;
}

/** The template fields a document does not declare. Accepting adds them, with their frozen values. */
export const missingFields = (doc: DocDocument, template: DocTemplate): FieldDecl[] =>
	template.fields.filter((field) => !doc.fields.some((mine) => mine.key === field.key));

type AcceptWith = { origin: Origin; values: Record<string, unknown> };

/**
 * The document after accepting the items numbered in `accepted` ("all" accepts every one). The document records
 * `origin`, declares the template's fields it lacked and freezes `values` for them.
 */
function accept(
	doc: DocDocument,
	template: DocTemplate,
	plan: Plan,
	accepted: readonly number[] | "all",
	{ origin, values }: AcceptWith,
): DocDocument {
	const picked = plan.apply(new Set(accepted === "all" ? plan.differences.map((d) => d.id) : accepted));
	const page: PageSetup = { ...picked.page };
	for (const part of ["header", "footer"] as const) {
		if (picked[part] === undefined) delete page[part];
		else page[part] = picked[part];
	}
	const added = missingFields(doc, template);
	const data = { ...doc.data };
	for (const field of added) if (values[field.key] !== undefined) data[field.key] = values[field.key];
	return structuredClone({
		...doc,
		title: picked.title,
		origin,
		fields: [...doc.fields, ...added],
		data,
		page,
		body: { type: "doc", ...(picked.blocks.length ? { content: picked.blocks } : {}) },
	});
}

/**
 * Accepting from "All differences": an accepted difference takes the template's side: a template block is added or
 * replaces the document's, a document-only block is removed. Every other block keeps the document's version.
 */
export function acceptDifferences(
	doc: DocDocument,
	template: DocTemplate,
	accepted: readonly number[] | "all",
	options: AcceptWith,
): DocDocument {
	return accept(doc, template, twoWay(doc, template), accepted, options);
}

/**
 * Accepting from "Template changes": each accepted change is applied in its place among the document's own blocks;
 * every block the church edited and the template did not change keeps the church's version.
 */
export function acceptTemplateChanges(
	doc: DocDocument,
	base: DocTemplate,
	current: DocTemplate,
	accepted: readonly number[] | "all",
	options: AcceptWith,
): DocDocument {
	return accept(doc, current, threeWay(doc, base, current), accepted, options);
}
