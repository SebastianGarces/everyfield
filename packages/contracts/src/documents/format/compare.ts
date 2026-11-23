import { FORMAT_SCHEMA } from "./schema.ts";
import { backwards, pairs, scores } from "./scores.ts";
import type { BlockNode, DocDocument, DocTemplate, FieldDecl, Origin, PageSetup, Region } from "./types.ts";

type DifferenceKind = "template-only" | "document-only" | "changed" | "removed" | "both";
export type PageLayout = Omit<PageSetup, "header" | "footer">;

export type DocDifference = { id: number } & DifferenceOf;
type DifferenceOf =
	| { part: "title"; kind: "changed" | "both"; document: string; template: string }
	| { part: "page"; kind: "changed" | "both"; document: PageLayout; template: PageLayout }
	| { part: "header" | "footer"; kind: DifferenceKind; document: Region | null; template: Region | null }
	| { part: "body"; kind: DifferenceKind; document: BlockNode | null; template: BlockNode | null };

type Rec = { [key: string]: unknown };
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);

function normal(value: unknown): unknown {
	if (Array.isArray(value)) return joinText(value.map(normal));
	if (!isRec(value)) return value;
	const spec = typeof value.type === "string" ? FORMAT_SCHEMA.nodes[value.type] : undefined;
	const out: Rec = {};
	const keys = new Set(Object.keys(value));
	if (spec) keys.add("attrs");
	for (const key of [...keys].sort()) {
		if (key === "attrs" && spec) {
			const attrs: Rec = {};
			const given = isRec(value.attrs) ? value.attrs : {};
			for (const [name, declared] of Object.entries(spec.attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
				const v = given[name] ?? declared.default;
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
export const sameKey = key;

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

function align(doc: readonly BlockNode[], tpl: readonly BlockNode[]): Step[] {
	const docs = doc.map((block) => ({ block, key: key(block) }));
	const tpls = tpl.map((block) => ({ block, key: key(block) }));
	const same = doc.length + tpl.length + 1;
	const pairScore = (d: (typeof docs)[number], t: (typeof tpls)[number]) =>
		d.key === t.key ? same : d.block.type === t.block.type ? 1 : -1;
	const score = scores(doc.length, tpl.length);
	const tplsBack = backwards(tpls);
	for (const [i, d] of backwards(docs))
		for (const [j, t] of tplsBack) {
			const pair = pairScore(d, t);
			score.set(i, j, Math.max(score.at(i + 1, j), score.at(i, j + 1), pair > 0 ? pair + score.at(i + 1, j + 1) : -1));
		}
	const steps: Step[] = [];
	let i = 0;
	let j = 0;
	for (;;) {
		const d = docs[i];
		const t = tpls[j];
		if (d && t) {
			const pair = pairScore(d, t);
			if (pair > 0 && score.at(i, j) === pair + score.at(i + 1, j + 1)) {
				steps.push(
					pair === same ? { op: "same", document: d.block } : { op: "changed", document: d.block, template: t.block },
				);
				i++;
				j++;
			} else if (score.at(i, j) === score.at(i + 1, j)) {
				steps.push({ op: "document-only", document: d.block });
				i++;
			} else {
				steps.push({ op: "template-only", template: t.block });
				j++;
			}
		} else if (d) {
			steps.push({ op: "document-only", document: d.block });
			i++;
		} else if (t) {
			steps.push({ op: "template-only", template: t.block });
			j++;
		} else return steps;
	}
}

type Picked = {
	title: string;
	page: PageSetup;
	header: PageSetup["header"];
	footer: PageSetup["footer"];
	blocks: BlockNode[];
};
type Plan = { differences: DocDifference[]; apply: (taken: ReadonlySet<number>) => Picked };

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

type Track = {
	at: { block: BlockNode | null; edited: boolean }[];
	inserts: BlockNode[][];
};
function track(side: readonly BlockNode[], base: readonly BlockNode[]): Track {
	let gap: BlockNode[] = [];
	const out: Track = { at: [], inserts: [gap] };
	for (const step of align(side, base)) {
		if (step.op === "document-only") {
			gap.push(step.document);
			continue;
		}
		out.at.push(
			step.op === "template-only"
				? { block: null, edited: false }
				: { block: step.document, edited: step.op === "changed" },
		);
		gap = [];
		out.inserts.push(gap);
	}
	return out;
}

function threeWay(doc: DocDocument, base: DocTemplate, current: DocTemplate): Plan {
	const differences: DocDifference[] = [];
	const add = (d: DifferenceOf) => differences.push({ id: differences.length, ...d }) - 1;
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

	const baseBlocks = base.body.content ?? [];
	const mine = track(doc.body.content ?? [], baseBlocks);
	const theirs = track(current.body.content ?? [], baseBlocks);
	const slots: { keep: BlockNode[]; take: BlockNode[]; id: number | null }[] = [];
	const places = pairs(mine.at, theirs.at);
	for (const [k, [added, incoming]] of pairs(mine.inserts, theirs.inserts).entries()) {
		slots.push({ keep: added, take: added, id: null });
		for (const block of incoming) {
			if (added.some((own) => key(own) === key(block))) continue;
			slots.push({
				keep: [],
				take: [block],
				id: add({ part: "body", kind: "template-only", document: null, template: block }),
			});
		}
		const place = places[k];
		if (!place) break;
		const [own, now] = place;
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

export function compareWithTemplate(doc: DocDocument, template: DocTemplate): DocDifference[] {
	return twoWay(doc, template).differences;
}

export function templateChanges(doc: DocDocument, base: DocTemplate, current: DocTemplate): DocDifference[] {
	return threeWay(doc, base, current).differences;
}

export const missingFields = (doc: DocDocument, template: DocTemplate): FieldDecl[] =>
	template.fields.filter((field) => !doc.fields.some((mine) => mine.key === field.key));

type AcceptWith = { origin: Origin; values: Record<string, unknown> };

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

export function acceptDifferences(
	doc: DocDocument,
	template: DocTemplate,
	accepted: readonly number[] | "all",
	options: AcceptWith,
): DocDocument {
	return accept(doc, template, twoWay(doc, template), accepted, options);
}

export function acceptTemplateChanges(
	doc: DocDocument,
	base: DocTemplate,
	current: DocTemplate,
	accepted: readonly number[] | "all",
	options: AcceptWith,
): DocDocument {
	return accept(doc, current, threeWay(doc, base, current), accepted, options);
}
