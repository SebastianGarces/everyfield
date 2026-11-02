// The one Forme renderer for everyfield.doc/1. It walks the tree and maps each node to the parts in blocks.tsx, so a
// template has no layout code of its own. Same tree, same theme, same bytes.
import type {
	BlockNode,
	BoxNode,
	CellNode,
	ColumnSpec,
	ColumnsNode,
	EveryfieldDoc,
	HeadingNode,
	ImageNode,
	InlineNode,
	Mark,
	ParagraphNode,
	Region,
	RowRole,
	SlotNode,
	TableNode,
	Token,
	WriteInNode,
} from "@everyfield/contracts/documents";
import { attrsOf, computeTable, pageBox, tileBox } from "@everyfield/contracts/documents";
import type { ReactNode } from "react";
import { Cell, Fixed, H1, H2, H3, Page, PageBreak, Row, Svg, Table, Text, View } from "@formepdf/react";
import type { Style } from "@formepdf/react";
import { MIN_BODY, MIN_NONTEXT, textOn } from "../contrast.ts";
import { listValues } from "../doc-values.ts";
import { SLOT_BLANK_NOTE } from "../templates/church.ts";
import { FONT, SIZE, SP, tokenColor, type Palette } from "../theme.ts";
import { LEGAL_NOTICE } from "@everyfield/contracts/documents";
import { Box, Cellfield, Field, LogoSlot, PhotoSlot, type Ctx } from "./blocks.tsx";
import { Doc } from "./shell.tsx";

/** The content box under which headings use the compact scale (a card): 5 in. */
const COMPACT_WIDTH = 360;

/** The render state of one place in the tree: the width it has, the color under it and the form-name suffix. */
type R = Ctx & {
	doc: EveryfieldDoc;
	width: number;
	bg: string;
	compact: boolean;
	/** `_t1` to `_tN` on a tiled sheet, so each card's form fields have their own names. */
	suffix: string;
	/** Shared by every place: form names in use and the heading numbers. */
	run: { names: Set<string>; h2: number; h3: number; tables: number };
};

/** Vertical space between blocks: half on the compact (card) scale. */
const space = (r: R, value: number) => (r.compact ? value / 2 : value);

// ---------------------------------------------------------------- colors

/** Strong and quiet text on a background: the palette's own tones on white or muted, the legible one on a fill. */
function inkOn(r: R) {
	const { p } = r;
	if (r.bg === p.white || r.bg === p.muted) return { strong: p.ink, quiet: p.mutedText, accent: p.primaryText };
	const on = textOn(r.bg, p.ink);
	return { strong: on, quiet: on, accent: on };
}
/** A line color on the current background: a token, made legible as a line when it is the brand color on white. */
function lineColor(r: R, token: Token) {
	const color = tokenColor(r.p, token);
	if (!color) return null;
	if (token === "accent" && r.bg === r.p.white) return r.p.brand ? r.p.accentLine : color;
	return color;
}

// ---------------------------------------------------------------- inline runs

type Base = { size: number; weight: 400 | 500 | 700; color: string; use: string; figures?: boolean };

function name(r: R, raw: string) {
	let candidate = `${raw}${r.suffix}`;
	if (r.run.names.has(candidate)) candidate = `table${r.run.tables}_${raw}${r.suffix}`;
	r.run.names.add(candidate);
	return candidate;
}

const pageNumberText = (format: "page" | "page-of-total") =>
	format === "page" ? "Page {{pageNumber}}" : "Page {{pageNumber}} of {{totalPages}}";

/** The text of one inline node: a field prints its value, a page number its counter. */
function inlineText(r: R, node: InlineNode): string {
	switch (node.type) {
		case "text":
			return node.text;
		case "field":
			return r.values[node.attrs.key] ?? "";
		case "hardBreak":
			return "\n";
		case "pageNumber":
			return pageNumberText(attrsOf(node).format);
	}
}

function markStyle(r: R, marks: readonly Mark[] | undefined, base: Base): { style: Style; href?: string } {
	const style: Style = {};
	let href: string | undefined;
	for (const mark of marks ?? []) {
		if (mark.type === "bold") style.fontWeight = 700;
		if (mark.type === "italic") style.fontStyle = "italic";
		if (mark.type === "underline") style.textDecoration = "underline";
		if (mark.type === "link") {
			href = mark.attrs.href;
			style.textDecoration = "underline";
			style.color = r.log.pair(`${base.use} link`, inkOn(r).accent, r.bg, MIN_BODY);
		}
	}
	return href ? { style, href } : { style };
}

/** Nested Text runs for marks. A run with no mark is a plain string. */
function runs(r: R, content: readonly InlineNode[] | undefined, base: Base): ReactNode[] {
	return (content ?? []).map((node, i) => {
		const value = inlineText(r, node);
		if (node.type !== "text" || !node.marks?.length) return value;
		const { style, href } = markStyle(r, node.marks, base);
		return (
			<Text key={i} style={style} {...(href ? { href } : {})}>
				{value}
			</Text>
		);
	});
}

function textStyle(r: R, base: Base, extra: Style = {}): Style {
	return {
		fontFamily: base.figures ? FONT.figures : FONT.body,
		fontSize: base.size,
		fontWeight: base.weight,
		color: r.log.pair(base.use, base.color, r.bg, MIN_BODY),
		lineHeight: 1.4,
		...extra,
	};
}

/** A tag mark prints as a small caps label on an accent tile, like GROW, PRAY and GIVE on the card. */
function tagTile(r: R, text: string, key: number) {
	const { p } = r;
	return (
		<View
			key={key}
			style={{
				backgroundColor: p.accent,
				paddingHorizontal: 4,
				height: 14,
				alignItems: "center",
				justifyContent: "center",
				marginRight: SP[2],
			}}
		>
			<Text
				style={{
					fontFamily: FONT.body,
					fontSize: SIZE.xs - 1,
					fontWeight: 700,
					color: r.log.pair("tag on accent fill", p.onAccent, p.accent, MIN_BODY),
					textTransform: "uppercase",
					letterSpacing: 0.6,
					lineHeight: 1,
				}}
			>
				{text}
			</Text>
		</View>
	);
}

const hasTag = (content: readonly InlineNode[] | undefined) =>
	(content ?? []).some((n) => n.type === "text" && n.marks?.some((m) => m.type === "tag"));

/**
 * One line of inline content in a given text style. Content with tag marks lays out as a row: each tag run is a tile and
 * the text between tiles wraps in the width left over.
 */
function line(r: R, content: readonly InlineNode[] | undefined, base: Base, extra: Style = {}, width = r.width) {
	if (!hasTag(content)) {
		const parts = runs(r, content, base);
		return <Text style={textStyle(r, base, extra)}>{parts.length ? parts : " "}</Text>;
	}
	const groups: { tag?: string; nodes: InlineNode[] }[] = [];
	for (const node of content ?? []) {
		if (node.type === "text" && node.marks?.some((m) => m.type === "tag")) groups.push({ tag: node.text, nodes: [] });
		else {
			const last = groups.at(-1);
			if (last && !last.tag) last.nodes.push(node);
			else groups.push({ nodes: [node] });
		}
	}
	const tiles = groups.filter((g) => g.tag).length;
	const textWidth = Math.max(40, width - tiles * 44);
	return (
		<View style={{ flexDirection: "row", alignItems: "center" }}>
			{groups.map((group, i) =>
				group.tag ? (
					tagTile(r, group.tag, i)
				) : (
					<View key={i} style={{ width: textWidth }}>
						<Text style={textStyle(r, base, extra)}>{runs(r, trimStart(group.nodes), base)}</Text>
					</View>
				),
			)}
		</View>
	);
}
const trimStart = (nodes: InlineNode[]) =>
	nodes.map((n, i) => (i === 0 && n.type === "text" ? { ...n, text: n.text.replace(/^\s+/, "") || " " } : n));

// ---------------------------------------------------------------- blocks

const PARAGRAPH = {
	body: { size: SIZE.base, weight: 400, quiet: false, caps: false, lineHeight: 1.5, gap: SP[2] },
	lead: { size: SIZE.base, weight: 400, quiet: true, caps: false, lineHeight: 1.5, gap: SP[3] },
	small: { size: SIZE.xs, weight: 400, quiet: true, caps: false, lineHeight: 1.35, gap: SP[1] },
	kicker: { size: SIZE.xs, weight: 700, quiet: true, caps: true, lineHeight: 1.3, gap: SP[1] },
} as const;

function paragraph(r: R, node: ParagraphNode, key: number, gap = true) {
	const a = attrsOf(node);
	const s = PARAGRAPH[a.style];
	const ink = inkOn(r);
	const base: Base = {
		size: s.size,
		weight: s.weight,
		color: s.quiet ? ink.quiet : ink.strong,
		use: `${a.style} paragraph`,
	};
	const extra: Style = {
		textAlign: a.align,
		lineHeight: s.lineHeight,
		...(s.caps ? { textTransform: "uppercase", letterSpacing: 0.6 } : {}),
	};
	return (
		<View key={key} style={{ marginBottom: gap ? space(r, s.gap) : 0 }}>
			{line(r, node.content, base, extra)}
		</View>
	);
}

function heading(r: R, node: HeadingNode, key: number) {
	const a = attrsOf(node);
	const ink = inkOn(r);
	const reset = { margin: 0, marginTop: 0, marginBottom: 0, padding: 0 } as const;
	if (a.level === 1) {
		const size = r.compact ? 20 : 30;
		return (
			<View key={key} style={{ marginBottom: SP[2], alignItems: alignOf(a.align) }}>
				<H1
					style={{
						...reset,
						fontFamily: FONT.display,
						fontWeight: 400,
						fontSize: size,
						lineHeight: 1.1,
						letterSpacing: -0.02 * size,
						textAlign: a.align,
						color: r.log.pair("document title", ink.accent, r.bg, 3),
					}}
				>
					{runs(r, node.content, { size, weight: 400, color: ink.accent, use: "document title" })}
				</H1>
			</View>
		);
	}
	const level2 = a.level === 2;
	if (level2) {
		r.run.h2 += 1;
		r.run.h3 = 0;
	} else r.run.h3 += 1;
	const size = level2 ? (r.compact ? SIZE.lg : SIZE.h3) : SIZE.base;
	const color = a.numbered && level2 ? ink.accent : ink.strong;
	const base: Base = { size, weight: 700, color, use: level2 ? "section heading" : "subheading" };
	const Tag = level2 ? H2 : H3;
	const title = (
		<Tag
			style={{
				...reset,
				fontFamily: FONT.body,
				fontWeight: 700,
				fontSize: size,
				lineHeight: 1.2,
				textAlign: a.align,
				color: r.log.pair(base.use, color, r.bg, MIN_BODY),
			}}
		>
			{runs(r, node.content, base)}
		</Tag>
	);
	if (!a.numbered)
		return (
			<View key={key} style={{ marginTop: space(r, SP[2]), marginBottom: SP[1] }}>
				{title}
			</View>
		);
	const number = level2 ? String(r.run.h2).padStart(2, "0") : `${r.run.h2}.${r.run.h3}`;
	return (
		<View
			key={key}
			style={{
				flexDirection: "row",
				alignItems: "center",
				marginTop: space(r, SP[3]),
				marginBottom: space(r, SP[2]),
				paddingBottom: 3,
				...(level2 ? { borderBottomWidth: 1.5, borderColor: lineColor(r, "primary") ?? r.p.primary } : {}),
			}}
		>
			<Text
				style={{
					fontFamily: FONT.figures,
					fontWeight: 700,
					fontSize: size,
					lineHeight: 1.1,
					marginRight: SP[2],
					color: r.log.pair("section number", ink.accent, r.bg, MIN_BODY),
				}}
			>
				{number}
			</Text>
			<View style={{ flexGrow: 1, width: r.width - 40 }}>{title}</View>
		</View>
	);
}

function list(r: R, items: { content: ParagraphNode[] }[], ordered: boolean, key: number) {
	const ink = inkOn(r);
	const inner = { ...r, width: r.width - SP[3] - 16 };
	return (
		<View key={key} style={{ marginBottom: SP[2], paddingLeft: SP[3] }}>
			{items.map((item, i) => (
				<View key={i} style={{ flexDirection: "row", marginBottom: 2 }}>
					<View style={{ width: 16 }}>
						<Text
							style={textStyle(r, {
								size: SIZE.base,
								weight: 400,
								color: ink.strong,
								use: "list marker",
								figures: true,
							})}
						>
							{ordered ? `${i + 1}.` : "•"}
						</Text>
					</View>
					<View style={{ width: inner.width }}>
						{item.content.map((p, pi) => paragraph(inner, p, pi, pi < item.content.length - 1))}
					</View>
				</View>
			))}
		</View>
	);
}

function quote(r: R, content: ParagraphNode[], key: number) {
	const inner = { ...r, width: r.width - 2 * SP[3] - 3 };
	return (
		<View
			key={key}
			style={{
				marginBottom: SP[2],
				marginLeft: SP[3],
				paddingLeft: SP[3],
				borderLeftWidth: 3,
				borderColor: lineColor(r, "primary") ?? r.p.primary,
			}}
		>
			{content.map((p, i) => paragraph(inner, p, i, i < content.length - 1))}
		</View>
	);
}

const alignOf = (align: "left" | "center" | "right") =>
	align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";

function divider(r: R, node: Extract<BlockNode, { type: "divider" }>, key: number) {
	const a = attrsOf(node);
	const color = lineColor(r, a.color) ?? r.p.ink;
	if (a.color !== "none") r.log.pair(`divider (${a.color})`, color, r.bg, 1);
	if (a.weight === "bar")
		return <View key={key} style={{ backgroundColor: color, height: 4, marginBottom: space(r, SP[2]) }} />;
	return (
		<View
			key={key}
			style={{
				borderBottomWidth: a.weight === "hairline" ? 0.5 : 2,
				borderColor: color,
				marginTop: a.weight === "hairline" ? 0 : space(r, SP[1]),
				marginBottom: a.weight === "hairline" ? SP[1] : space(r, SP[3]),
			}}
		/>
	);
}

function columns(r: R, node: ColumnsNode, key: number) {
	const a = attrsOf(node);
	const cols = node.content;
	const shares = cols.map((c) => attrsOf(c).width);
	const total = shares.reduce((s, w) => s + w, 0);
	const free = r.width - a.gap * (cols.length - 1);
	const widths = shares.map((w) => +((free * w) / total).toFixed(2));
	return (
		<View
			key={key}
			style={{
				flexDirection: "row",
				alignItems: a.valign === "center" ? "center" : a.valign === "bottom" ? "flex-end" : "flex-start",
				marginBottom: r.compact ? 0 : SP[2],
			}}
		>
			{cols.map((col, i) => {
				const ca = attrsOf(col);
				const width = widths[i] ?? 0;
				return (
					<View key={i} style={{ width, marginRight: i < cols.length - 1 ? a.gap : 0, alignItems: alignOf(ca.align) }}>
						{blocks({ ...r, width }, col.content ?? [], true)}
					</View>
				);
			})}
		</View>
	);
}

function box(r: R, node: BoxNode, key: number) {
	const a = attrsOf(node);
	const fill = tokenColor(r.p, a.fill);
	const border = a.border === "none" ? null : tokenColor(r.p, a.border);
	const borderWidth = border ? 1 : 0;
	const inner: R = { ...r, bg: fill ?? r.bg, width: r.width - 2 * a.padding - 2 * borderWidth };
	return (
		<View
			key={key}
			wrap={!a.keepTogether}
			style={{
				...(fill ? { backgroundColor: fill } : {}),
				...(border ? { borderWidth, borderColor: border } : {}),
				padding: a.padding,
				marginBottom: fill === r.p.primary ? 0 : space(r, SP[2]),
			}}
		>
			{blocks(inner, node.content ?? [], true)}
		</View>
	);
}

function image(r: R, node: ImageNode, key: number) {
	const a = attrsOf(node);
	const width = Math.min(a.width, r.width);
	const slot =
		a.source === "photo" ? (
			r.theme.photo ? (
				PhotoSlot(r.theme.photo, width, a.height)
			) : (
				<View style={{ width, height: a.height }} />
			)
		) : (
			LogoSlot(r, width, a.height, r.theme.logo, {
				align: a.align === "center" ? "center" : "flex-start",
				nameColor: inkOn(r).strong,
				nameBg: r.bg,
				...(r.bg === r.p.primary ? { reversedOn: r.p.primary } : {}),
			})
		);
	return (
		<View key={key} style={{ width: r.width, alignItems: alignOf(a.align), marginBottom: space(r, SP[1]) }}>
			{slot}
		</View>
	);
}

function writeIn(r: R, node: WriteInNode, key: number) {
	const a = attrsOf(node);
	const width = a.width > 0 ? Math.min(a.width, r.width) : r.width;
	const height = a.kind === "signature" ? 24 : 17;
	return (
		<View key={key} style={{ marginBottom: space(r, SP[2]) }}>
			{Field(r, a.label, width, height, { name: name(r, a.key), bg: r.bg })}
		</View>
	);
}

function slot(r: R, node: SlotNode, key: number) {
	const { p } = r;
	const a = attrsOf(node);
	const inner: R = { ...r, width: r.width - 2 * SP[3] - 2 };
	const content = node.content ?? [];
	return (
		<View
			key={key}
			wrap={false}
			style={{ borderWidth: 1, borderColor: p.fieldBorder, padding: SP[3], marginVertical: SP[2], minHeight: 72 }}
		>
			<Text
				style={textStyle(
					r,
					{ size: SIZE.xs, weight: 700, color: inkOn(r).quiet, use: "doctrinal slot label" },
					{
						textTransform: "uppercase",
						letterSpacing: 0.6,
						marginBottom: SP[1],
					},
				)}
			>
				{a.label}
			</Text>
			{content.length ? (
				blocks(inner, content, true)
			) : (
				<Text style={textStyle(r, { size: SIZE.sm, weight: 400, color: inkOn(r).quiet, use: "doctrinal slot blank" })}>
					{SLOT_BLANK_NOTE}
				</Text>
			)}
		</View>
	);
}

// ---------------------------------------------------------------- tables

const grouped = (n: number) => String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** `$1,234` for money (cents when the amount has them), `1,234.5` for a number. */
export function formatNumber(value: number, kind: "money" | "number") {
	const sign = value < 0 ? "-" : "";
	const abs = Math.abs(value);
	const cents = Math.round((abs - Math.trunc(abs)) * 100);
	const fraction = cents ? `.${String(cents).padStart(2, "0")}` : "";
	if (kind === "money") return `${sign}$${grouped(abs)}${fraction}`;
	const decimals = Number.isInteger(abs) ? "" : String(+abs.toFixed(4)).replace(/^\d+/, "");
	return `${sign}${grouped(abs)}${decimals}`;
}

/** Column widths in points: fixed widths as given, the rest of the width shared by the columns with width 0. */
function columnWidths(cols: readonly ColumnSpec[], width: number) {
	const fixed = cols.reduce((s, c) => s + c.width, 0);
	const auto = cols.filter((c) => c.width === 0).length;
	const share = auto ? Math.max(24, (width - fixed) / auto) : 0;
	return cols.map((c) => +(c.width || share).toFixed(2));
}

type BuiltRow = { role: RowRole; cells: (CellNode | null)[] };

function table(r: R, node: TableNode, key: number) {
	const { p } = r;
	const a = attrsOf(node);
	r.run.tables += 1;
	const cols = a.columns;
	const widths = columnWidths(cols, r.width);
	const computed = computeTable(node);
	const anyValue = (node.content ?? []).some((row) =>
		row.content.some((cell) => typeof cell.attrs?.value === "number"),
	);
	const content: BuiltRow[] = (node.content ?? []).map((row) => ({
		role: row.attrs?.role ?? "item",
		cells: row.content,
	}));
	const source = a.source ? listValues(r.doc, a.source) : [];
	const fromSource: BuiltRow[] = source.map((entry) => ({
		role: "item",
		cells: cols.map((c): CellNode => {
			const v = entry[c.id];
			if (typeof v === "number" && (c.type === "number" || c.type === "money"))
				return { type: "cell", attrs: { value: v } };
			if (typeof v === "string" && v && c.type === "text")
				return { type: "cell", content: [{ type: "text", text: v }] };
			return { type: "cell" };
		}),
	}));
	const blanks = source.length ? 0 : a.writeInRows;
	const rows: BuiltRow[] = [
		...content,
		...fromSource,
		...Array.from({ length: blanks }, (): BuiltRow => ({ role: "item", cells: cols.map(() => null) })),
	];
	const headFill = tokenColor(p, a.headerFill);
	const headBg = headFill ?? r.bg;
	const headText = headFill ? textOn(headFill, p.ink) : p.ink;
	const cellStyle: Style = { paddingVertical: r.compact ? 2 : 3, paddingHorizontal: SP[2], justifyContent: "center" };
	let index = 0;
	let item = 0;
	return (
		<View key={key} style={{ marginBottom: space(r, SP[3]) }}>
			<Table columns={widths.map((w) => ({ width: { fixed: w } }))} style={{ width: "100%" }}>
				{a.header ? (
					<Row
						header
						style={{
							backgroundColor: headBg,
							...(headFill ? {} : { borderBottomWidth: 1.5, borderColor: p.ink }),
						}}
					>
						{cols.map((c, ci) => (
							<Cell key={ci} style={cellStyle}>
								<Text
									style={textStyle(
										{ ...r, bg: headBg },
										{ size: SIZE.xs, weight: 700, color: headText, use: "table header" },
										{
											textTransform: "uppercase",
											letterSpacing: 0.6,
											textAlign: c.align ?? (c.type === "text" ? "left" : "right"),
										},
									)}
								>
									{c.label || " "}
								</Text>
							</Cell>
						))}
					</Row>
				) : null}
				{rows.map((row, ri) => {
					const numbers = ri < content.length ? (computed[ri] ?? []) : [];
					const isItem = row.role === "item";
					if (isItem) {
						index += 1;
						item += 1;
					}
					const strong = row.role === "subtotal" || row.role === "total";
					const zebra = a.zebra && isItem && item % 2 === 0;
					const bg = row.role === "group" ? p.muted : zebra ? p.muted : r.bg;
					const cr: R = { ...r, bg };
					const rowInputs = row.cells.some((cell, ci) => {
						const t = cols[ci]?.type;
						return (t === "money" || t === "number") && typeof cell?.attrs?.value === "number";
					});
					return (
						<Row
							key={ri}
							style={{
								backgroundColor: bg,
								borderBottomWidth: 0.5,
								borderColor: p.border,
								...(strong ? { borderTopWidth: 1, borderColor: p.ink } : {}),
								minHeight: a.rowHeight,
							}}
						>
							{cols.map((c, ci) => {
								const cell = row.cells[ci] ?? null;
								const w = widths[ci] ?? 24;
								const align = c.align ?? (c.type === "text" ? "left" : "right");
								const base: Base = {
									size: SIZE.sm,
									weight: row.role === "item" ? 400 : 700,
									color: p.ink,
									use: `table ${row.role} cell`,
									figures: c.type !== "text",
								};
								const label = (text: string) => <Text style={textStyle(cr, base, { textAlign: align })}>{text}</Text>;
								let inner: ReactNode = null;
								if (c.type === "text") {
									if (cell?.content?.length)
										inner = line({ ...cr, width: w - 2 * SP[2] }, cell.content, base, { textAlign: align });
									else if (isItem)
										inner = Cellfield(name(r, `row_${index}_${c.id}`), w - 2 * SP[2], Math.max(14, a.rowHeight - 8));
								} else if (c.type === "index") {
									if (isItem) inner = label(String(index));
								} else if (c.type === "check") {
									if (isItem)
										inner = (
											<View style={{ alignItems: alignOf(align) }}>{Box(cr, name(r, `row_${index}_${c.id}`), 12)}</View>
										);
								} else if (c.type === "number" || c.type === "money") {
									const value = isItem ? cell?.attrs?.value : numbers[ci];
									if (typeof value === "number" && (isItem || anyValue)) inner = label(formatNumber(value, c.type));
									else if (isItem) inner = Cellfield(name(r, `row_${index}_${c.id}`), w - 2 * SP[2], 14);
								} else {
									const value = numbers[ci];
									const show = isItem ? rowInputs : row.role !== "group" && anyValue;
									if (typeof value === "number" && show) inner = label(formatNumber(value, c.format ?? "number"));
								}
								return (
									<Cell key={ci} style={cellStyle}>
										{inner ?? label(" ")}
									</Cell>
								);
							})}
						</Row>
					);
				})}
			</Table>
		</View>
	);
}

// ---------------------------------------------------------------- the block list

/** The size of a block's text, for the keep-with-next rule. */
const textSize = (node: BlockNode): number => JSON.stringify(node).length;

function block(r: R, node: BlockNode, key: number): ReactNode {
	switch (node.type) {
		case "paragraph":
			return paragraph(r, node, key);
		case "heading":
			return heading(r, node, key);
		case "bulletList":
			return list(r, node.content, false, key);
		case "orderedList":
			return list(r, node.content, true, key);
		case "quote":
			return quote(r, node.content, key);
		case "divider":
			return divider(r, node, key);
		case "spacer":
			return <View key={key} style={{ height: attrsOf(node).size }} />;
		case "pageBreak":
			return <PageBreak key={key} />;
		case "columns":
			return columns(r, node, key);
		case "box":
			return box(r, node, key);
		case "image":
			return image(r, node, key);
		case "writeIn":
			return writeIn(r, node, key);
		case "slot":
			return slot(r, node, key);
		case "table":
			return table(r, node, key);
	}
}

/** A block list. A heading never ends a page: it travels with a short block that follows it. */
function blocks(r: R, nodes: readonly BlockNode[], nested = false): ReactNode[] {
	const out: ReactNode[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		const next = nodes[i + 1];
		const keep =
			!nested &&
			node.type === "heading" &&
			next &&
			!["table", "slot", "pageBreak", "heading"].includes(next.type) &&
			textSize(next) < 1500;
		if (keep) {
			out.push(
				<View key={i} wrap={false}>
					{block(r, node, 0)}
					{block(r, next, 1)}
				</View>,
			);
			i += 1;
		} else out.push(block(r, node, i));
	}
	return out;
}

// ---------------------------------------------------------------- page setup

function notice(r: R) {
	if (r.doc.class !== "formal/legal") return null;
	return (
		<Text
			style={textStyle(
				r,
				{ size: SIZE.xs, weight: 700, color: inkOn(r).strong, use: "legal notice" },
				{ marginTop: 2 },
			)}
		>
			{LEGAL_NOTICE}
		</Text>
	);
}

/** Header and footer content. The class's fixed parts (the legal notice) close the footer. */
function region(r: R, which: "header" | "footer", reg: Region | null | undefined) {
	const content = reg ? blocks(r, reg.content, true) : [];
	const extra = which === "footer" ? notice(r) : null;
	if (!content.length && !extra) return null;
	return (
		<View style={which === "header" ? { marginBottom: space(r, SP[2]) } : { marginTop: space(r, SP[2]) }}>
			{content}
			{extra}
		</View>
	);
}

/** Trim marks at each tile edge and corner of a tiled sheet. */
function cutMarks(p: Palette, w: number, h: number, across: number, down: number) {
	const tw = w / across;
	const th = h / down;
	const L = 9;
	const d: string[] = [];
	for (let i = 0; i <= across; i++) {
		const x = +(i * tw).toFixed(2);
		d.push(`M${x} 0 L${x} ${L}`, `M${x} ${h - L} L${x} ${h}`);
	}
	for (let j = 0; j <= down; j++) {
		const y = +(j * th).toFixed(2);
		d.push(`M0 ${y} L${L} ${y}`, `M${w - L} ${y} L${w} ${y}`);
	}
	for (let i = 1; i < across; i++)
		for (let j = 1; j < down; j++) {
			const x = +(i * tw).toFixed(2);
			const y = +(j * th).toFixed(2);
			d.push(`M${x - 6} ${y} L${x + 6} ${y}`, `M${x} ${y - 6} L${x} ${y + 6}`);
		}
	const content = `<path d="${d.join(" ")}" stroke="${p.fieldBorder}" stroke-width="0.5" fill="none"/>`;
	return (
		<View style={{ position: "absolute", left: 0, top: 0 }}>
			<Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} content={content} />
		</View>
	);
}

/** One tiled sheet: the header, body and footer repeat in each tile, each tile clips its content. */
function tiledPage(r: R, size: { width: number; height: number }) {
	const page = r.doc.page;
	const tile = page.tile!;
	const tb = tileBox(page)!;
	const inner = {
		width: size.width - page.margin.left - page.margin.right,
		height: size.height - page.margin.top - page.margin.bottom,
	};
	const count = tile.across * tile.down;
	const tiles = Array.from({ length: count }, (_, i) => {
		const tr: R = {
			...r,
			width: tb.width - 2 * tile.padding,
			suffix: count > 1 ? `_t${i + 1}` : "",
			run: { ...r.run, h2: 0, h3: 0 },
		};
		const body = (r.doc.body.content ?? []).filter((n) => n.type !== "pageBreak");
		return (
			<View
				key={i}
				style={{
					position: "absolute",
					left: (i % tile.across) * tb.width,
					top: Math.floor(i / tile.across) * tb.height,
					width: tb.width,
					height: tb.height,
					overflow: "hidden",
				}}
			>
				<View
					style={{
						position: "absolute",
						left: tile.padding,
						top: tile.padding,
						width: tb.width - 2 * tile.padding,
						height: tb.height - 2 * tile.padding,
						flexDirection: "column",
						justifyContent: "space-between",
					}}
				>
					<View style={{ overflow: "hidden" }}>
						{region(tr, "header", page.header)}
						{blocks(tr, body)}
					</View>
					{region(tr, "footer", page.footer)}
				</View>
			</View>
		);
	});
	return (
		<Page size={size} margin={page.margin}>
			<View wrap={false} style={{ width: inner.width, height: inner.height }}>
				{tiles}
				{tile.cutMarks ? cutMarks(r.p, inner.width, inner.height, tile.across, tile.down) : null}
			</View>
		</Page>
	);
}

/** The marker a probe layout puts on each top-level body element, so the split point can be read back. */
export const PROBE_MARK = "everyfield-block:";

/**
 * How a flowing document lays out. `single`: one Forme page run with the `all` regions (and the `first` regions as
 * repeated ones, to measure page 1). `probe` is that layout with a marker on each top-level body element. `split`:
 * the body elements before `at` run with the `first` regions, the rest start a new page with the `rest` regions.
 */
export type FlowMode = { kind: "single" } | { kind: "probe" } | { kind: "split"; at: number };

/** A flowing document: the header and footer repeat by `pages`, the body flows from page to page. */
function flowPages(r: R, size: { width: number; height: number }, mode: FlowMode) {
	const page = r.doc.page;
	const body = blocks(r, r.doc.body.content ?? []);
	const run = (which: "first" | "rest", nodes: ReactNode[], key: number) => {
		const on = (reg: Region | null | undefined) => (reg && (reg.pages === "all" || reg.pages === which) ? reg : null);
		const header = region(r, "header", on(page.header));
		const footer = region(r, "footer", on(page.footer));
		return (
			<Page key={key} size={size} margin={page.margin}>
				{header ? <Fixed position="header">{header}</Fixed> : null}
				{footer ? <Fixed position="footer">{footer}</Fixed> : null}
				{nodes.length ? nodes : <View />}
			</Page>
		);
	};
	if (mode.kind === "split" && mode.at < body.length)
		return [run("first", body.slice(0, mode.at), 0), run("rest", body.slice(mode.at), 1)];
	if (mode.kind === "probe")
		return run(
			"first",
			body.map((node, i) => (
				<View key={i} bookmark={`${PROBE_MARK}${i}`}>
					{node}
				</View>
			)),
			0,
		);
	return run("first", body, 0);
}

/** True when a region prints on only the first page or only the later pages, so the layout needs a probe. */
export const needsSplit = (doc: EveryfieldDoc) =>
	!doc.page.tile && [doc.page.header, doc.page.footer].some((reg) => reg && reg.pages !== "all");

/**
 * The Forme element for one document or template. `ctx.values` holds the field values (doc-values.ts). The class adds
 * its fixed parts: a formal/legal document prints "Template, not legal advice" on every page, even when wiped.
 */
export function docElement(ctx: Ctx, doc: EveryfieldDoc, mode: FlowMode = { kind: "single" }) {
	const size = pageBox(doc.page);
	const box = tileBox(doc.page);
	if (!size || !box) throw new Error("the page has no size");
	const width = doc.page.tile ? box.width - 2 * doc.page.tile.padding : box.width;
	const r: R = {
		...ctx,
		doc,
		width,
		bg: ctx.p.white,
		compact: width < COMPACT_WIDTH,
		suffix: "",
		run: { names: new Set(), h2: 0, h3: 0, tables: 0 },
	};
	ctx.log.pair("page text", ctx.p.ink, ctx.p.white, MIN_BODY);
	ctx.log.pair("field border", ctx.p.fieldBorder, ctx.p.white, MIN_NONTEXT);
	const pages = doc.page.tile ? tiledPage(r, size) : flowPages(r, size, mode);
	return Doc(ctx, `${doc.title}, ${ctx.church}`, `${doc.title}, ${ctx.church}`, pages, doc.page.margin.left);
}
