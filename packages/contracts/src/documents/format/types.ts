// The everyfield.doc/1 tree as TypeScript types. The tree has the ProseMirror shape (`type`, `attrs`, `content`,
// `marks`, `text`). An attribute with a default may be left out; `attrsOf` fills the defaults from the schema.

export type Token = "none" | "ink" | "muted-text" | "primary" | "accent" | "muted" | "border";
export type Align = "left" | "center" | "right";
export type DocClass = "formal/legal" | "outward-facing" | "operational";
export type ExportFormat = "pdf" | "docx" | "xlsx";
export type PageSize = "letter" | "legal" | "a4" | "half-letter" | "card-4x6" | "custom";

export type Mark =
	| { type: "bold"; attrs?: Record<string, never> }
	| { type: "italic"; attrs?: Record<string, never> }
	| { type: "underline"; attrs?: Record<string, never> }
	| { type: "link"; attrs: { href: string } }
	| { type: "tag"; attrs?: Record<string, never> };

export type TextNode = { type: "text"; text: string; marks?: Mark[] };
export type FieldNode = { type: "field"; attrs: { key: string } };
export type HardBreakNode = { type: "hardBreak"; attrs?: Record<string, never> };
export type PageNumberNode = { type: "pageNumber"; attrs?: { format?: "page" | "page-of-total" } };
export type InlineNode = TextNode | FieldNode | HardBreakNode | PageNumberNode;

export type ParagraphNode = {
	type: "paragraph";
	attrs?: { align?: Align; style?: "body" | "lead" | "small" | "kicker" };
	content?: InlineNode[];
};
export type HeadingNode = {
	type: "heading";
	attrs?: { level?: 1 | 2 | 3; numbered?: boolean; align?: Align };
	content?: InlineNode[];
};
export type ListItemNode = { type: "listItem"; attrs?: Record<string, never>; content: ParagraphNode[] };
export type BulletListNode = { type: "bulletList"; attrs?: Record<string, never>; content: ListItemNode[] };
export type OrderedListNode = { type: "orderedList"; attrs?: Record<string, never>; content: ListItemNode[] };
export type QuoteNode = { type: "quote"; attrs?: Record<string, never>; content: ParagraphNode[] };
export type DividerNode = { type: "divider"; attrs?: { weight?: "hairline" | "rule" | "bar"; color?: Token } };
export type SpacerNode = { type: "spacer"; attrs?: { size?: number } };
export type PageBreakNode = { type: "pageBreak"; attrs?: Record<string, never> };
export type ColumnNode = { type: "column"; attrs?: { width?: number; align?: Align }; content?: BlockNode[] };
export type ColumnsNode = {
	type: "columns";
	attrs?: { gap?: number; valign?: "top" | "center" | "bottom" };
	content: ColumnNode[];
};
export type BoxNode = {
	type: "box";
	attrs?: { fill?: Token; border?: Token; padding?: number; keepTogether?: boolean };
	content?: BlockNode[];
};
export type ImageNode = {
	type: "image";
	attrs?: { source?: "logo" | "mark" | "photo"; width?: number; height?: number; align?: Align; alt?: string };
};
export type WriteInNode = {
	type: "writeIn";
	attrs?: { label?: string; key?: string; kind?: "text" | "signature" | "date"; width?: number };
};
export type SlotNode = {
	type: "slot";
	attrs?: { label?: string };
	content?: (ParagraphNode | BulletListNode | OrderedListNode)[];
};

export type ColumnType = "text" | "number" | "money" | "check" | "index" | "formula";
export type ColumnSpec = {
	id: string;
	label: string;
	type: ColumnType;
	width: number;
	align?: Align;
	formula?: string;
	format?: "number" | "money";
};
export type CellNode = { type: "cell"; attrs?: { value?: number | null; checked?: boolean }; content?: InlineNode[] };
export type RowRole = "item" | "group" | "subtotal" | "total";
export type RowNode = { type: "row"; attrs?: { role?: RowRole; sign?: "add" | "subtract" }; content: CellNode[] };
export type TableNode = {
	type: "table";
	attrs: {
		columns: ColumnSpec[];
		style?: "grid" | "rows" | "ledger";
		header?: boolean;
		headerFill?: Token;
		zebra?: boolean;
		writeInRows?: number;
		rowHeight?: number;
		source?: string | null;
		sheet?: string | null;
	};
	content?: RowNode[];
};

export type BlockNode =
	| ParagraphNode
	| HeadingNode
	| BulletListNode
	| OrderedListNode
	| QuoteNode
	| DividerNode
	| SpacerNode
	| PageBreakNode
	| ColumnsNode
	| BoxNode
	| ImageNode
	| WriteInNode
	| SlotNode
	| TableNode;
export type DocNode = { type: "doc"; attrs?: Record<string, never>; content?: BlockNode[] };
export type AnyNode = DocNode | BlockNode | ListItemNode | ColumnNode | RowNode | CellNode | InlineNode;

export type Region = { pages: "all" | "first" | "rest"; content: BlockNode[] };
export type Margin = { top: number; right: number; bottom: number; left: number };
export type Tile = { across: number; down: number; padding: number; cutMarks: boolean };
export type PageSetup = {
	size: PageSize;
	width?: number;
	height?: number;
	orientation: "portrait" | "landscape";
	margin: Margin;
	tile?: Tile | null;
	header?: Region | null;
	footer?: Region | null;
};

export type FieldDecl = {
	key: string;
	label: string;
	type: "text" | "date" | "number" | "list";
	source?: string | null;
	required?: boolean;
	sample?: unknown;
	fallback?: string;
};
export type Origin = { template: string; version: number; hash: string };

type Envelope = {
	format: "everyfield.doc/1";
	id: string;
	version: number;
	title: string;
	description?: string;
	class: DocClass;
	exports: ExportFormat[];
	fields: FieldDecl[];
	page: PageSetup;
	body: DocNode;
};
/** A template: the catalog file a document is forked from. It has no `data` and no `origin`. */
export type DocTemplate = Envelope & { kind: "template" };
/** A document: a fork of a template, or a blank document (`origin: null`). It holds frozen merge values. */
export type DocDocument = Envelope & { kind: "document"; origin: Origin | null; data?: Record<string, unknown> };
export type EveryfieldDoc = DocTemplate | DocDocument;

// ---------------------------------------------------------------- the schema's own shape

export type ValueSpec = {
	type:
		| "any"
		| "const"
		| "enum"
		| "token"
		| "int"
		| "number"
		| "bool"
		| "string"
		| "slug"
		| "key"
		| "list"
		| "object"
		| "map"
		| "page"
		| "region"
		| "blocks"
		| "node";
	value?: string;
	values?: string[];
	min?: number;
	max?: number;
	pattern?: string;
	of?: ValueSpec;
	props?: Record<string, ValueSpec>;
	node?: string;
	default?: unknown;
	optional?: boolean;
	nullable?: boolean;
};
export type NodeSpec = {
	group: string;
	attrs: Record<string, ValueSpec>;
	content: { allow: string[]; min?: number; max?: number; deny?: string[] } | null;
	text?: boolean;
};
export type FormatSchema = {
	format: string;
	limits: { nodes: number; textLength: number; jsonBytes: number };
	tokens: { color: string[] };
	pageSizes: Record<string, { width: number; height: number }>;
	envelope: Record<string, ValueSpec>;
	page: Record<string, ValueSpec>;
	region: Record<string, ValueSpec>;
	nodes: Record<string, NodeSpec>;
	marks: Record<string, { attrs: Record<string, ValueSpec> }>;
};
