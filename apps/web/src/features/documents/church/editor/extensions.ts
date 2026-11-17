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
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, type ViewMutationRecord } from "@tiptap/pm/view";
import {
	FORMAT_KEY,
	plainTable,
	type DocBrand,
	type EveryfieldDoc,
	type FieldDecl,
} from "@everyfield/contracts/documents";
import { fieldValues as printedValues, PLACEHOLDER, SLOT_BLANK_NOTE } from "@everyfield/domain/documents/values";
import { attrsOfSpec, BLOCKS, px, type Attrs } from "./attrs.ts";
import { IMAGE_KINDS, insideColumn, regionAt } from "./blocks.ts";
import { ConditionRules, EfIf } from "./condition-extension.ts";
import { docDecorations } from "./doc-decorations.ts";
import { nodeFromTable, tableOf } from "./table-actions.ts";
import { EfCell, EfRow, EfTable, EfValueCell, TableRules } from "./table-extension.ts";

const REGION_BLOCKS = "(colblock | columns)*";

const EfDocument = Document.extend({
	content: "pageHeader? block* pageFooter?",
	addAttributes() {
		return {
			page: { default: undefined, rendered: false },
			fields: { default: undefined, rendered: false },
			data: { default: undefined, rendered: false },
		};
	},
});

function regionNode(name: "pageHeader" | "pageFooter") {
	const tag = name === "pageHeader" ? "header" : "footer";
	return Node.create({
		name,
		content: REGION_BLOCKS,
		isolating: true,
		selectable: false,
		addAttributes() {
			return attrsOfSpec({ pages: "string" });
		},
		parseHTML: () => [{ tag: `${tag}[data-ef-node="${name}"]` }],
		renderHTML: ({ node, HTMLAttributes }) => [
			tag,
			mergeAttributes(HTMLAttributes, {
				"data-ef-node": name,
				role: "group",
				"aria-label": name === "pageHeader" ? "Page header" : "Page footer",
				"data-ef-pages": String(node.attrs.pages ?? "all"),
			}),
			0,
		],
	});
}
const EfPageHeader = regionNode("pageHeader");
const EfPageFooter = regionNode("pageFooter");

const EfParagraph = Paragraph.extend({
	group: BLOCKS,
	addAttributes() {
		return attrsOfSpec({ align: "string", style: "string" });
	},
});

const HEADING_TAGS = ["h1", "h2", "h3"] as const;
const EfHeading = Node.create({
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

const EfBulletList = BulletList.extend({
	group: `${BLOCKS} list`,
	addAttributes: () => ({}),
});
const EfOrderedList = OrderedList.extend({
	group: `${BLOCKS} list`,
	addAttributes: () => ({}),
});
const EfListItem = ListItem.extend({
	content: "paragraph+",
	addKeyboardShortcuts() {
		return {
			Enter: () => this.editor.commands.splitListItem(this.name),
			"Shift-Tab": () => this.editor.commands.liftListItem(this.name),
		};
	},
});
const EfQuote = Blockquote.extend({
	name: "quote",
	group: BLOCKS,
	content: "paragraph+",
	addAttributes: () => ({}),
});

const EfLink = Link.extend({
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
	isAllowedUri: (url) => isAllowedLink(url),
	HTMLAttributes: { target: null, rel: null, class: null },
});

export const isAllowedLink = (url: string) => /^(https?:\/\/|mailto:)/i.test(url.trim());

const EfTag = Mark.create({
	name: "tag",
	parseHTML: () => [{ tag: "span[data-ef-tag]" }],
	renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-ef-tag": "" }), 0],
});

const EfDivider = Node.create({
	name: "divider",
	group: BLOCKS,
	addAttributes() {
		return attrsOfSpec({ weight: "string", color: "string" });
	},
	parseHTML: () => [{ tag: 'hr[data-ef-node="divider"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"hr",
		mergeAttributes(HTMLAttributes, {
			"data-ef-node": "divider",
			"data-line-weight": String(node.attrs.weight ?? "rule"),
			"data-line-color": String(node.attrs.color ?? "ink"),
		}),
	],
});

const EfSpacer = Node.create({
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

const EfPageBreak = Node.create({
	name: "pageBreak",
	group: "block",
	parseHTML: () => [{ tag: 'div[data-ef-node="pageBreak"]' }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "pageBreak" }),
		["span", {}, "Page break"],
	],
});

export type FieldValues = Record<string, string>;

export function liveValues(doc: PMNode): FieldValues {
	return printedValues({
		kind: "document",
		fields: (doc.attrs.fields as FieldDecl[] | undefined) ?? [],
		data: doc.attrs.data as Record<string, unknown> | undefined,
	} as EveryfieldDoc);
}

export const fieldDecl = (doc: PMNode, key: string) =>
	((doc.attrs.fields as FieldDecl[] | undefined) ?? []).find((field) => field.key === key);

const isPlaceholder = (text: string) => new RegExp(`^${PLACEHOLDER.source}$`).test(text);

const EfField = Node.create({
	name: "field",
	group: "inline",
	inline: true,
	atom: true,
	addAttributes() {
		return attrsOfSpec({ key: "string" });
	},
	parseHTML: () => [{ tag: 'span[data-ef-node="field"]' }],
	renderHTML({ node, HTMLAttributes }) {
		const key = String(node.attrs.key ?? "");
		return ["span", mergeAttributes(HTMLAttributes, { "data-ef-node": "field" }), `{${key}}`];
	},
	addNodeView() {
		return ({ node, editor, decorations }) => {
			const dom = document.createElement("span");
			dom.setAttribute("data-ef-node", "field");
			dom.contentEditable = "false";
			const draw = (current: PMNode, decos: readonly Decoration[]) => {
				const key = String(current.attrs.key ?? "");
				const value = (decos.find((d) => d.spec.fieldValue !== undefined)?.spec.fieldValue as string) ?? "";
				const label = fieldDecl(editor.state.doc, key)?.label ?? key;
				dom.setAttribute("data-ef-key", key);
				dom.title = `Merge field: ${label}. Select it to change its value.`;
				dom.textContent = value;
				dom.classList.toggle("ef-placeholder", isPlaceholder(value));
				dom.classList.toggle("ef-field-empty", value === "");
			};
			draw(node, decorations);
			return {
				dom,
				update(next: PMNode, decos: readonly Decoration[]) {
					if (next.type !== node.type) return false;
					draw(next, decos);
					return true;
				},
				ignoreMutation: () => true,
			};
		};
	},
	addProseMirrorPlugins() {
		return [
			docDecorations("efFieldValues", (doc) => {
				const values = liveValues(doc);
				const found: Decoration[] = [];
				doc.descendants((node, pos) => {
					if (node.type.name !== "field") return;
					const value = values[String(node.attrs.key ?? "")] ?? "";
					found.push(Decoration.node(pos, pos + node.nodeSize, {}, { fieldValue: value }));
				});
				return found;
			}),
		];
	},
});

const EfPageNumber = Node.create({
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

const EfColumns = Node.create({
	name: "columns",
	group: "block boxblock",
	content: "column{2,4}",
	isolating: true,
	defining: true,
	addAttributes() {
		return attrsOfSpec({ gap: "number", valign: "string" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="columns"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, {
			"data-ef-node": "columns",
			"data-count": String(node.childCount),
			"data-valign": String(node.attrs.valign ?? "top"),
			style: `--ef-gap:${px(typeof node.attrs.gap === "number" ? node.attrs.gap : 12)}`,
		}),
		0,
	],
});
const EfColumn = Node.create({
	name: "column",
	content: "colblock*",
	isolating: true,
	addAttributes() {
		return attrsOfSpec({ width: "number", align: "string" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="column"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, {
			"data-ef-node": "column",
			"aria-label": "Column",
			role: "group",
			style: `flex-grow:${typeof node.attrs.width === "number" ? node.attrs.width : 1}`,
		}),
		0,
	],
});
const EfBox = Node.create({
	name: "box",
	group: "block colblock",
	content: "boxblock*",
	isolating: true,
	defining: true,
	addAttributes() {
		return attrsOfSpec({ fill: "string", border: "string", padding: "number", keepTogether: "boolean" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="box"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, {
			"data-ef-node": "box",
			role: "group",
			"aria-label": "Box",
			"data-box-fill": String(node.attrs.fill ?? "none"),
			"data-box-border": String(node.attrs.border ?? "border"),
			style: `--ef-pad:${px(typeof node.attrs.padding === "number" ? node.attrs.padding : 12)}`,
		}),
		0,
	],
});

type Assets = DocBrand["assets"];

const EfImage = Node.create<{ assets: Assets | null }>({
	name: "image",
	group: BLOCKS,
	atom: true,
	addOptions: () => ({ assets: null }),
	addAttributes() {
		return attrsOfSpec({ source: "string", width: "number", height: "number", align: "string", alt: "string" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="image"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "image" }),
		[node.attrs.source ?? "logo", node.attrs.alt].filter(Boolean).join(" · "),
	],
	addNodeView() {
		const assets = this.options.assets;
		return ({ node }) => imageView(node, assets);
	},
});

function imageView(initial: PMNode, assets: Assets | null) {
	const dom = document.createElement("div");
	dom.className = "ef-image";
	dom.setAttribute("data-ef-node", "image");
	dom.contentEditable = "false";
	const draw = (node: PMNode) => {
		const source = (node.attrs.source as keyof Assets | undefined) ?? "logo";
		const align = (node.attrs.align as string | undefined) ?? "left";
		const width = typeof node.attrs.width === "number" ? node.attrs.width : 150;
		const height = typeof node.attrs.height === "number" ? node.attrs.height : 34;
		dom.dataset.source = source;
		dom.dataset.align = align;
		dom.replaceChildren();
		const box = document.createElement("div");
		box.className = "ef-image-box";
		box.style.width = px(width);
		box.style.height = px(height);
		const asset = assets?.[source] ?? null;
		if (asset) {
			const img = document.createElement("img");
			img.src = `/api/brand/assets/${asset.fileId}`;
			img.alt = (node.attrs.alt as string | undefined) || asset.alt;
			img.draggable = false;
			box.append(img);
		} else {
			box.classList.add("ef-image-empty");
			box.textContent = `No ${IMAGE_KINDS[source]} in the brand kit`;
		}
		dom.append(box);
	};
	draw(initial);
	return {
		dom,
		update(next: PMNode) {
			if (next.type !== initial.type) return false;
			draw(next);
			return true;
		},
		ignoreMutation: () => true,
	};
}

const WRITE_IN_KIND: Record<string, string> = { text: "Write-in line", signature: "Signature line", date: "Date line" };
export const writeInKindLabel = (kind: unknown) =>
	WRITE_IN_KIND[typeof kind === "string" ? kind : "text"] ?? "Write-in line";

const EfWriteIn = Node.create({
	name: "writeIn",
	group: BLOCKS,
	atom: true,
	addAttributes() {
		return attrsOfSpec({ label: "string", key: "string", kind: "string", width: "number" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="writeIn"]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"div",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "writeIn" }),
		String(node.attrs.label ?? "Name"),
	],
	addNodeView() {
		return ({ node, editor, getPos }) => writeInView(node, editor, getPos);
	},
});

function writeInView(initial: PMNode, editor: Editor, getPos: () => number | undefined) {
	const dom = document.createElement("div");
	dom.className = "ef-writein";
	dom.setAttribute("data-ef-node", "writeIn");
	dom.contentEditable = "false";
	const kind = document.createElement("span");
	kind.className = "ef-writein-kind";
	const input = document.createElement("input");
	input.type = "text";
	input.className = "ef-writein-label";
	input.maxLength = 80;
	input.title = "Label of this line";
	const note = document.createElement("span");
	note.className = "ef-writein-note";
	note.setAttribute("role", "alert");
	const line = document.createElement("div");
	line.className = "ef-writein-line";
	dom.append(kind, input, note, line);
	let current = initial;
	const draw = (node: PMNode) => {
		current = node;
		const text = writeInKindLabel(node.attrs.kind);
		dom.dataset.kind = String(node.attrs.kind ?? "text");
		kind.textContent = text;
		input.setAttribute("aria-label", `Label of this ${text.toLowerCase()}`);
		if (document.activeElement !== input) input.value = String(node.attrs.label ?? "Name");
		note.textContent = "";
		input.removeAttribute("aria-invalid");
	};
	const commit = () => {
		const label = input.value.trim();
		if (label.length === 0) {
			input.setAttribute("aria-invalid", "true");
			note.textContent = "A line needs a label.";
			return;
		}
		note.textContent = "";
		input.removeAttribute("aria-invalid");
		const pos = getPos();
		if (pos === undefined || label === (current.attrs.label ?? "Name")) return;
		const tr = closeHistory(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, label }));
		editor.view.dispatch(tr);
	};
	input.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (event.key === "Enter") {
			event.preventDefault();
			commit();
			input.blur();
			editor.view.focus();
		} else if (event.key === "Escape") {
			input.value = String(current.attrs.label ?? "Name");
			note.textContent = "";
			input.removeAttribute("aria-invalid");
			input.blur();
			editor.view.focus();
		}
	});
	input.addEventListener("blur", commit);
	draw(initial);
	return {
		dom,
		update(next: PMNode) {
			if (next.type !== initial.type) return false;
			draw(next);
			return true;
		},
		stopEvent: (event: Event) => event.target === input,
		ignoreMutation: () => true,
	};
}

const SLOT_LABEL = "Statement of faith";

const EfSlot = Node.create({
	name: "slot",
	group: BLOCKS,
	content: "(paragraph | bulletList | orderedList)*",
	isolating: true,
	defining: true,
	addAttributes() {
		return attrsOfSpec({ label: "string", key: "string" });
	},
	parseHTML: () => [{ tag: 'section[data-ef-node="slot"]', contentElement: ".ef-slot-body" }],
	renderHTML: ({ node, HTMLAttributes }) => [
		"section",
		mergeAttributes(HTMLAttributes, { "data-ef-node": "slot" }),
		["div", { class: "ef-slot-label" }, String(node.attrs.label ?? SLOT_LABEL)],
		["div", { class: "ef-slot-body" }, 0],
	],
	addNodeView() {
		return ({ node }) => {
			const dom = document.createElement("section");
			dom.className = "ef-slot";
			dom.setAttribute("data-ef-node", "slot");
			dom.setAttribute("role", "group");
			const label = document.createElement("div");
			label.className = "ef-slot-label";
			label.contentEditable = "false";
			const note = document.createElement("div");
			note.className = "ef-slot-note";
			note.contentEditable = "false";
			note.textContent = SLOT_BLANK_NOTE;
			const body = document.createElement("div");
			body.className = "ef-slot-body";
			dom.append(label, note, body);
			const draw = (current: PMNode) => {
				const text = String(current.attrs.label ?? SLOT_LABEL);
				label.textContent = `Doctrinal section · ${text}`;
				dom.setAttribute("aria-label", `Doctrinal section: ${text}`);
				dom.toggleAttribute("data-empty", isBlankSlot(current));
			};
			draw(node);
			return {
				dom,
				contentDOM: body,
				update(next: PMNode) {
					if (next.type !== node.type) return false;
					draw(next);
					return true;
				},
				ignoreMutation: (mutation: ViewMutationRecord) => !body.contains(mutation.target),
			};
		};
	},
});

function isBlankSlot(node: PMNode) {
	let field = false;
	node.descendants((child) => {
		if (child.type.name === "field") field = true;
		return !field;
	});
	return !field && node.textContent.trim() === "";
}

function placeholderDecorations(doc: PMNode) {
	const found: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		for (const match of node.text.matchAll(PLACEHOLDER))
			found.push(
				Decoration.inline(pos + match.index, pos + match.index + match[0].length, { class: "ef-placeholder" }),
			);
	});
	return found;
}

const Placeholders = Extension.create({
	name: "placeholders",
	addProseMirrorPlugins() {
		return [docDecorations("efPlaceholders", placeholderDecorations)];
	},
});

function headingNumbers(doc: PMNode) {
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

const HeadingNumbers = Extension.create({
	name: "headingNumbers",
	addProseMirrorPlugins() {
		return [
			docDecorations("efHeadingNumbers", (doc) => {
				const decorations: Decoration[] = [];
				for (const [pos, text] of headingNumbers(doc)) {
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
					const node = doc.nodeAt(pos);
					if (node) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "ef-heading-numbered" }));
				}
				return decorations;
			}),
		];
	},
});

const keyOf = (node: PMNode) => (typeof node.attrs.key === "string" ? node.attrs.key : "name");

function freeKey(base: string, taken: ReadonlySet<string>) {
	const root = FORMAT_KEY.test(base) ? base : "line";
	if (!taken.has(root)) return root;
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const candidate = `${root.slice(0, 60 - suffix.length)}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

const CONTAINERS = ["column", "box", "pageHeader", "pageFooter", "slot"];

const LayoutRules = Extension.create({
	name: "layoutRules",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("efLayoutRules"),
				appendTransaction: (transactions, _old, state) => {
					if (!transactions.some((tr) => tr.docChanged)) return null;
					const tr = state.tr;
					const taken = new Set<string>();
					const renames: { pos: number; node: PMNode }[] = [];
					state.doc.descendants((node, pos) => {
						if (node.type.name !== "writeIn") return;
						const key = keyOf(node);
						if (taken.has(key)) renames.push({ pos, node });
						else taken.add(key);
					});
					for (const { pos, node } of renames) {
						const key = freeKey(keyOf(node), taken);
						taken.add(key);
						tr.setNodeMarkup(pos, undefined, { ...node.attrs, key });
					}
					const fills: number[] = [];
					for (const t of transactions)
						t.mapping.maps.forEach((map, index) =>
							map.forEach((_a, _b, start, end) => {
								const to = t.mapping.slice(index + 1).map(end);
								const from = t.mapping.slice(index + 1).map(start);
								state.doc.nodesBetween(Math.max(0, from - 1), Math.min(state.doc.content.size, to + 1), (node, pos) => {
									if (CONTAINERS.includes(node.type.name) && node.childCount === 0) fills.push(pos);
								});
							}),
						);
					for (const pos of [...new Set(fills)].sort((a, b) => b - a)) {
						const paragraph = state.schema.nodes.paragraph;
						if (paragraph) tr.insert(tr.mapping.map(pos) + 1, paragraph.create());
					}
					return tr.docChanged ? tr : null;
				},
				props: {
					transformPasted: (slice, view) => pastedSlice(slice, view.state),
				},
			}),
		];
	},
});

export function pastedSlice(slice: Slice, state: EditorState): Slice {
	const dropNumbers = !regionAt(state);
	const flatten = insideColumn(state);
	if (!dropNumbers && !flatten) return slice;
	const strip = (fragment: Fragment): Fragment => {
		const nodes: PMNode[] = [];
		fragment.forEach((child) => {
			if (dropNumbers && child.type.name === "pageNumber") return;
			if (flatten && (child.type.name === "columns" || child.type.name === "column")) {
				strip(child.content).forEach((node) => nodes.push(node));
				return;
			}
			nodes.push(child.isLeaf ? child : child.copy(strip(child.content)));
		});
		return Fragment.fromArray(nodes);
	};
	const open = (depth: number, edge: (node: Fragment) => PMNode | null) => {
		let removed = 0;
		let fragment: Fragment = slice.content;
		for (let d = 0; d < depth; d++) {
			const node = edge(fragment);
			if (!node) break;
			if (flatten && (node.type.name === "columns" || node.type.name === "column")) removed++;
			fragment = node.content;
		}
		return depth - removed;
	};
	const content = strip(slice.content);
	const max = Slice.maxOpen(content);
	return new Slice(
		content,
		Math.min(
			open(slice.openStart, (f) => f.firstChild),
			max.openStart,
		),
		Math.min(
			open(slice.openEnd, (f) => f.lastChild),
			max.openEnd,
		),
	);
}

export function editorExtensions(assets: Assets | null = null) {
	return [
		EfDocument,
		Text,
		EfPageHeader,
		EfPageFooter,
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
		EfImage.configure({ assets }),
		EfWriteIn,
		EfSlot,
		EfIf,
		EfTable,
		EfRow,
		EfCell,
		EfValueCell,
		HardBreak,
		EfField,
		EfPageNumber,
		Bold,
		Italic,
		Underline,
		EfLink,
		EfTag,
		UndoRedo,
		HeadingNumbers,
		Placeholders,
		LayoutRules,
		ConditionRules,
		TableRules,
	];
}

export function plainPastedSlice(slice: Slice): Slice {
	let changed = false;
	const strip = (fragment: Fragment): Fragment => {
		const nodes: PMNode[] = [];
		fragment.forEach((child) => {
			if (child.type.name === "table") {
				changed = true;
				nodes.push(nodeFromTable(child.type.schema, plainTable(tableOf(child))));
			} else nodes.push(child.isLeaf ? child : child.copy(strip(child.content)));
		});
		return Fragment.fromArray(nodes);
	};
	const content = strip(slice.content);
	if (!changed) return slice;
	const max = Slice.maxOpen(content);
	return new Slice(content, Math.min(slice.openStart, max.openStart), Math.min(slice.openEnd, max.openEnd));
}

const PlainPaste = Extension.create({
	name: "plainPaste",
	addProseMirrorPlugins: () => [
		new Plugin({ key: new PluginKey("efPlainPaste"), props: { transformPasted: (slice) => plainPastedSlice(slice) } }),
	],
});

export function nativeExtensions() {
	return [
		Document.extend({ content: "block*" }),
		Text,
		EfParagraph.extend({ addAttributes: () => ({}) }),
		EfHeading.extend({ addAttributes: () => attrsOfSpec({ level: "number" }) }),
		EfBulletList,
		EfOrderedList,
		EfListItem,
		EfQuote,
		EfDivider.extend({ addAttributes: () => ({}) }),
		EfTable,
		EfRow,
		EfCell,
		EfValueCell,
		HardBreak,
		Bold,
		Italic,
		Underline,
		EfLink,
		UndoRedo,
		Placeholders,
		PlainPaste,
		TableRules,
	];
}
