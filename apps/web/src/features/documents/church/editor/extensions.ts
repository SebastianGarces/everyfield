import { Extension, mergeAttributes, Node, Mark, textblockTypeInputRule, type Editor } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Underline from "@tiptap/extension-underline";
import { UndoRedo } from "@tiptap/extensions";
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// The Tiptap extensions for everyfield.doc/1. Each node and mark has the name and the attributes of the format
// (packages/contracts/src/documents/format/schema.ts), so `editor.getJSON()` is the document body and there is no
// mapping layer for prose. An attribute the file leaves out stays `undefined` in the editor and out of the JSON, so a
// document reads back exactly as it was stored. Nodes that later slices edit (columns, box, image, write-in, slot,
// table and the inline field) load, show, move, delete and save unchanged.

type Kind = "string" | "number" | "boolean" | "json";
type Attrs = Record<string, unknown>;

/** One format attribute: no default (the format's default applies at render), stored in a `data-ef-*` attribute. */
function attr(name: string, kind: Kind = "string") {
	const html = `data-ef-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
	return {
		default: undefined as unknown,
		parseHTML: (el: HTMLElement) => {
			const raw = el.getAttribute(html);
			if (raw === null) return undefined;
			if (kind === "number") return Number(raw);
			if (kind === "boolean") return raw === "true";
			if (kind === "json") return JSON.parse(raw) as unknown;
			return raw;
		},
		renderHTML: (attrs: Attrs) => {
			const value = attrs[name];
			if (value === undefined) return {};
			return {
				[html]: kind === "json" || kind === "number" || kind === "boolean" ? JSON.stringify(value) : String(value),
			};
		},
	};
}
const attrsOfSpec = (spec: Record<string, Kind>) =>
	Object.fromEntries(Object.entries(spec).map(([name, kind]) => [name, attr(name, kind)]));

const BLOCKS = "block colblock boxblock";

// ---------------------------------------------------------------- prose

export const EfDocument = Document.extend({
	content: "block*",
	// The header and footer live on the document node so Undo and Redo cover them (Delete all content empties them).
	addAttributes() {
		return { header: { default: undefined, rendered: false }, footer: { default: undefined, rendered: false } };
	},
});

export const EfParagraph = Paragraph.extend({
	group: BLOCKS,
	addAttributes() {
		return attrsOfSpec({ align: "string", style: "string" });
	},
});

const HEADING_TAGS = ["h1", "h2", "h3"] as const;
export const EfHeading = Node.create({
	name: "heading",
	group: BLOCKS,
	content: "inline*",
	defining: true,
	addAttributes() {
		return attrsOfSpec({ level: "number", numbered: "boolean", align: "string" });
	},
	parseHTML() {
		return HEADING_TAGS.map((tag, i) => ({
			tag,
			getAttrs: (el: HTMLElement | string) => {
				// A copy inside the editor keeps the format's own attributes; a heading from outside gets its level.
				const own = typeof el === "string" ? null : el.getAttribute("data-ef-level");
				return own === null ? { level: i + 1 } : null;
			},
		}));
	},
	renderHTML({ node, HTMLAttributes }) {
		const level = typeof node.attrs.level === "number" ? node.attrs.level : 2;
		return [`h${Math.min(Math.max(level, 1), 3)}`, mergeAttributes(HTMLAttributes, { "data-ef-node": "heading" }), 0];
	},
	addInputRules() {
		return [
			textblockTypeInputRule({
				find: /^(#{1,3})\s$/,
				type: this.type,
				getAttributes: (match) => ({ level: match[1]?.length }),
			}),
		];
	},
});

export const EfBulletList = BulletList.extend({
	group: `${BLOCKS} list`,
	addAttributes: () => ({}),
});
export const EfOrderedList = OrderedList.extend({
	group: `${BLOCKS} list`,
	addAttributes: () => ({}),
});
export const EfListItem = ListItem.extend({
	// The format keeps lists flat: an item holds paragraphs only, so Tab has nothing to nest into.
	content: "paragraph+",
	addKeyboardShortcuts() {
		return {
			Enter: () => this.editor.commands.splitListItem(this.name),
			"Shift-Tab": () => this.editor.commands.liftListItem(this.name),
		};
	},
});
export const EfQuote = Blockquote.extend({
	name: "quote",
	group: BLOCKS,
	content: "paragraph+",
	addAttributes: () => ({}),
});

// ---------------------------------------------------------------- marks

export const EfLink = Link.extend({
	addAttributes() {
		return {
			href: {
				default: undefined,
				parseHTML: (el: HTMLElement) => el.getAttribute("href") ?? undefined,
				renderHTML: (attrs: Attrs) => (attrs.href === undefined ? {} : { href: attrs.href }),
			},
		};
	},
}).configure({
	openOnClick: false,
	autolink: false,
	linkOnPaste: false,
	// The format's link rule: https, http or mailto, nothing else.
	isAllowedUri: (url) => isAllowedLink(url),
	HTMLAttributes: { target: null, rel: null, class: null },
});

/** True when a link target starts the way the format requires. */
export const isAllowedLink = (url: string) => /^(https?:\/\/|mailto:)/i.test(url.trim());

export const EfTag = Mark.create({
	name: "tag",
	parseHTML: () => [{ tag: "span[data-ef-tag]" }],
	renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-ef-tag": "" }), 0],
});

// ---------------------------------------------------------------- simple blocks

export const EfDivider = Node.create({
	name: "divider",
	group: BLOCKS,
	addAttributes() {
		return attrsOfSpec({ weight: "string", color: "string" });
	},
	parseHTML: () => [{ tag: 'hr[data-ef-node="divider"]' }],
	renderHTML: ({ HTMLAttributes }) => ["hr", mergeAttributes(HTMLAttributes, { "data-ef-node": "divider" })],
});

export const EfSpacer = Node.create({
	name: "spacer",
	group: BLOCKS,
	addAttributes() {
		return attrsOfSpec({ size: "number" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="spacer"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, {
			"data-ef-node": "spacer",
			style: `height:${typeof node.attrs.size === "number" ? node.attrs.size : 12}pt`,
		}),
		["span", {}, `Spacer`],
	],
});

export const EfPageBreak = Node.create({
	name: "pageBreak",
	group: "block",
	parseHTML: () => [{ tag: 'div[data-ef-node="pageBreak"]' }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "pageBreak" }),
		["span", {}, "Page break"],
	],
});

// ---------------------------------------------------------------- inline atoms

export type FieldValues = Record<string, string>;

export const EfField = Node.create<{ values: FieldValues }>({
	name: "field",
	group: "inline",
	inline: true,
	atom: true,
	addOptions: () => ({ values: {} }),
	addAttributes() {
		return attrsOfSpec({ key: "string" });
	},
	parseHTML: () => [{ tag: 'span[data-ef-node="field"]' }],
	renderHTML({ node, HTMLAttributes }) {
		const key = String(node.attrs.key ?? "");
		return [
			"span",
			mergeAttributes(HTMLAttributes, { "data-ef-node": "field", title: `Merge field: ${key}` }),
			this.options.values[key] ?? `{${key}}`,
		];
	},
});

export const EfPageNumber = Node.create({
	name: "pageNumber",
	group: "inline",
	inline: true,
	atom: true,
	addAttributes() {
		return attrsOfSpec({ format: "string" });
	},
	parseHTML: () => [{ tag: 'span[data-ef-node="pageNumber"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"span",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "pageNumber" }),
		node.attrs.format === "page" ? "Page 1" : "Page 1 of 1",
	],
});

// ---------------------------------------------------------------- later-slice blocks

const KIND_LABEL: Record<string, (attrs: Attrs) => string> = {
	columns: () => "Columns",
	box: () => "Box",
	image: (a) => `Image · ${String(a.source ?? "logo")}`,
	writeIn: (a) => (a.kind === "signature" ? "Signature line" : a.kind === "date" ? "Date line" : "Write-in line"),
	slot: (a) => `Section · ${String(a.label ?? "Statement of faith")}`,
	table: () => "Table",
};
export const blockLabel = (node: PMNode) => KIND_LABEL[node.type.name]?.(node.attrs) ?? node.type.name;

function laterNode(
	name: string,
	options: {
		group?: string;
		content?: string;
		attrs: Record<string, Kind>;
		atom?: boolean;
		leaf?: (node: PMNode) => string;
	},
) {
	return Node.create({
		name,
		group: options.group,
		content: options.content,
		atom: options.atom ?? false,
		isolating: true,
		addAttributes: () => attrsOfSpec(options.attrs),
		parseHTML: () => [{ tag: `div[data-ef-node="${name}"]` }],
		renderHTML({ node, HTMLAttributes }) {
			const attrs = mergeAttributes(HTMLAttributes, { "data-ef-node": name });
			if (options.leaf) return ["div", attrs, options.leaf(node)];
			return ["div", attrs, 0];
		},
		// A block with content is shown read-only: its kind as a label, and its content drawn by the same rules.
		addNodeView: options.atom && options.content ? () => readOnlyView : undefined,
	});
}

function readOnlyView({ node, editor }: { node: PMNode; editor: Editor }) {
	const serializer = DOMSerializer.fromSchema(editor.schema);
	const dom = document.createElement("div");
	dom.className = "ef-block";
	dom.setAttribute("data-ef-node", node.type.name);
	dom.contentEditable = "false";
	const draw = (current: PMNode) => {
		dom.replaceChildren();
		const label = document.createElement("span");
		label.className = "ef-block-label";
		label.textContent = blockLabel(current);
		const body = document.createElement("div");
		body.className = "ef-block-body";
		// A table's header cells come from its column list, and its blank write-in rows from `writeInRows`.
		if (current.type.name === "table") body.append(...tableExtras(current, "header"));
		for (let i = 0; i < current.childCount; i++) body.append(serializer.serializeNode(current.child(i)));
		if (current.type.name === "table") body.append(...tableExtras(current, "blank"));
		dom.append(label, body);
	};
	draw(node);
	return {
		dom,
		update(next: PMNode) {
			if (next.type !== node.type) return false;
			draw(next);
			return true;
		},
		ignoreMutation: () => true,
	};
}

function tableExtras(table: PMNode, part: "header" | "blank"): HTMLElement[] {
	const columns = (table.attrs.columns as { label?: string }[] | undefined) ?? [];
	const row = (cells: string[], header: boolean) => {
		const dom = document.createElement("div");
		dom.setAttribute("data-ef-node", "row");
		if (header) dom.setAttribute("data-ef-header", "");
		for (const text of cells) {
			const cell = document.createElement("div");
			cell.setAttribute("data-ef-node", "cell");
			cell.textContent = text;
			dom.append(cell);
		}
		return dom;
	};
	if (part === "header")
		return table.attrs.header === false
			? []
			: [
					row(
						columns.map((c) => c.label ?? ""),
						true,
					),
				];
	const blank = typeof table.attrs.writeInRows === "number" ? table.attrs.writeInRows : 0;
	return Array.from({ length: Math.min(blank, 8) }, () =>
		row(
			columns.map(() => ""),
			false,
		),
	);
}

const BLOCK_OR_PROSE = "colblock*";
export const EfColumns = laterNode("columns", {
	group: "block boxblock",
	content: "column column+",
	attrs: { gap: "number", valign: "string" },
	atom: true,
});
export const EfColumn = laterNode("column", { content: BLOCK_OR_PROSE, attrs: { width: "number", align: "string" } });
export const EfBox = laterNode("box", {
	group: "block colblock",
	content: "boxblock*",
	attrs: { fill: "string", border: "string", padding: "number", keepTogether: "boolean" },
	atom: true,
});
export const EfImage = laterNode("image", {
	group: BLOCKS,
	attrs: { source: "string", width: "number", height: "number", align: "string", alt: "string" },
	atom: true,
	leaf: (node) => [node.attrs.source ?? "logo", node.attrs.alt].filter(Boolean).join(" · "),
});
export const EfWriteIn = laterNode("writeIn", {
	group: BLOCKS,
	attrs: { label: "string", key: "string", kind: "string", width: "number" },
	atom: true,
	leaf: (node) => `${String(node.attrs.label ?? "Name")}`,
});
export const EfSlot = laterNode("slot", {
	group: BLOCKS,
	content: "(paragraph | bulletList | orderedList)*",
	attrs: { label: "string" },
	atom: true,
});
export const EfTable = laterNode("table", {
	group: BLOCKS,
	content: "row*",
	attrs: {
		columns: "json",
		style: "string",
		header: "boolean",
		headerFill: "string",
		zebra: "boolean",
		writeInRows: "number",
		rowHeight: "number",
		source: "string",
		sheet: "string",
	},
	atom: true,
});
export const EfRow = laterNode("row", { content: "cell+", attrs: { role: "string", sign: "string" } });
export const EfCell = laterNode("cell", { content: "inline*", attrs: { value: "number", checked: "boolean" } });

// ---------------------------------------------------------------- heading numbers

/** The numbers the PDF prints before a numbered heading: "01" for a level 2, "1.1" for a level 3 (doc.tsx, heading). */
export function headingNumbers(doc: PMNode) {
	const numbers = new Map<number, string>();
	let h2 = 0;
	let h3 = 0;
	doc.descendants((node, pos) => {
		if (node.type.name !== "heading") return;
		const level = typeof node.attrs.level === "number" ? node.attrs.level : 2;
		if (level === 1) return;
		if (level === 2) {
			h2 += 1;
			h3 = 0;
		} else h3 += 1;
		if (node.attrs.numbered) numbers.set(pos, level === 2 ? String(h2).padStart(2, "0") : `${h2}.${h3}`);
	});
	return numbers;
}

const numberKey = new PluginKey("efHeadingNumbers");
export const HeadingNumbers = Extension.create({
	name: "headingNumbers",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: numberKey,
				props: {
					decorations: (state) => {
						const decorations: Decoration[] = [];
						for (const [pos, text] of headingNumbers(state.doc)) {
							decorations.push(
								Decoration.widget(
									pos + 1,
									() => {
										const span = document.createElement("span");
										span.className = "ef-heading-number";
										span.contentEditable = "false";
										span.textContent = text;
										return span;
									},
									{ side: -1, ignoreSelection: true, key: `n${pos}${text}` },
								),
							);
							// The number sits in front of the text, so the heading itself also carries the numbered look.
							const node = state.doc.nodeAt(pos);
							if (node) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "ef-heading-numbered" }));
						}
						return DecorationSet.create(state.doc, decorations);
					},
				},
			}),
		];
	},
});

// ---------------------------------------------------------------- an empty page

/**
 * ProseMirror cannot redraw a document that loses every child in the same update as an attribute of the document node
 * (Delete all content and its Redo): it builds a new view of an empty document, finds nothing changed and leaves the old
 * blocks in the DOM. This plugin removes them, so the page matches the state.
 */
export const EmptyDocumentRedraw = Extension.create({
	name: "emptyDocumentRedraw",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				view: () => ({
					update: (view) => {
						if (view.state.doc.childCount === 0 && view.dom.childElementCount > 0) view.dom.replaceChildren();
					},
				}),
			}),
		];
	},
});

// ---------------------------------------------------------------- the set

/** Every extension of the editor. The headless tests load the same list. */
export function editorExtensions(values: FieldValues = {}) {
	return [
		EfDocument,
		Text,
		EfParagraph,
		EfHeading,
		EfBulletList,
		EfOrderedList,
		EfListItem,
		EfQuote,
		EfDivider,
		EfSpacer,
		EfPageBreak,
		EfColumns,
		EfColumn,
		EfBox,
		EfImage,
		EfWriteIn,
		EfSlot,
		EfTable,
		EfRow,
		EfCell,
		HardBreak,
		EfField.configure({ values }),
		EfPageNumber,
		Bold,
		Italic,
		Underline,
		EfLink,
		EfTag,
		UndoRedo,
		HeadingNumbers,
		EmptyDocumentRedraw,
	];
}
