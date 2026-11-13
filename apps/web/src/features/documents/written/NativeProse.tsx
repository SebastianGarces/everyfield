import { safeLinkAddress } from "@everyfield/contracts/common";
import { attrsOf, columnWidths, formatNumber, type DocNode, type TableNode } from "@everyfield/contracts/documents";
import type { CSSProperties, ReactNode } from "react";
import "../church/editor/editor.css";
import { tableView } from "../church/editor/table-model.ts";

// A native body drawn read-only, for a Member and for an archived document: the editor's paper and type, without the
// editor. Text is drawn as text nodes and never as HTML; a link keeps only an address the safe link rule accepts. A
// table draws as the editor draws it (T-100): header labels, cell text, amounts in the shared format, check boxes, row
// numbers and stripes, with no control. Nothing here imports the editor (D-227).

/** The text width of the plain paper in points, as the editor lays a table out (table-extension.ts). */
const PLAIN_TEXT_WIDTH = 480;

type Node = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Mark[]; content?: Node[] };
type Mark = { type: string; attrs?: { href?: unknown } };

function marked(text: string, marks: Mark[] = []): ReactNode {
	let out: ReactNode = text;
	for (const mark of marks) {
		if (mark.type === "bold") out = <strong>{out}</strong>;
		else if (mark.type === "italic") out = <em>{out}</em>;
		else if (mark.type === "underline") out = <u>{out}</u>;
		else if (mark.type === "link") {
			const href = typeof mark.attrs?.href === "string" ? safeLinkAddress(mark.attrs.href) : null;
			if (href)
				out = (
					<a href={href} rel="noreferrer noopener" target="_blank" className="cursor-pointer">
						{out}
					</a>
				);
		}
	}
	return out;
}

function inline(nodes: Node[] = []): ReactNode[] {
	return nodes.map((node, i) =>
		node.type === "hardBreak" ? <br key={i} /> : <span key={i}>{marked(node.text ?? "", node.marks)}</span>,
	);
}

function table(node: TableNode, key: number): ReactNode {
	const a = attrsOf(node);
	const view = tableView(node);
	const widths = columnWidths(a.columns, PLAIN_TEXT_WIDTH);
	const align = (type: string) => (type === "text" ? "left" : "right");
	const grid = {
		"--ef-cols": widths.map((pt) => `${((pt * 4) / 3).toFixed(2)}px`).join(" "),
		minWidth: `${widths.reduce((sum, pt) => sum + pt, 0) * (4 / 3)}px`,
	} as CSSProperties;
	return (
		<div key={key} className="ef-table" data-ef-node="table">
			<div className="ef-table-scroll">
				<div className="ef-table-grid" role="table" aria-label="Table" style={grid}>
					{a.header ? (
						<div className="ef-table-head" role="row">
							{a.columns.map((c) => (
								<div key={c.id} className="ef-head-wrap" role="columnheader">
									<span className="ef-head-cell ef-read-head" style={{ textAlign: align(c.type) }}>
										{c.label}
									</span>
								</div>
							))}
						</div>
					) : null}
					{(node.content ?? []).map((row, r) => (
						<div
							key={r}
							data-ef-node="row"
							data-role="item"
							role="row"
							className={view[r]?.stripe ? "ef-stripe" : undefined}
						>
							{a.columns.map((c, ci) => {
								const cell = row.content[ci];
								if (c.type === "text")
									return (
										<div key={c.id} data-ef-node="cell" data-ef-cell="text" role="cell">
											{inline(cell?.content as Node[] | undefined)}
										</div>
									);
								const value = cell?.attrs?.value;
								const checked = cell?.attrs?.checked === true;
								return (
									<div
										key={c.id}
										data-ef-node="cell"
										data-ef-cell="value"
										role="cell"
										className="ef-vcell"
										style={{ textAlign: align(c.type) }}
									>
										{c.type === "check" ? (
											<span
												className="ef-vcheck ef-read-check"
												role="img"
												aria-label={`${c.label}, row ${r + 1}: ${checked ? "checked" : "not checked"}`}
												data-checked={String(checked)}
											/>
										) : (
											<span className="ef-computed">
												{c.type === "index"
													? (view[r]?.shown[ci] ?? "")
													: typeof value === "number" && (c.type === "number" || c.type === "money")
														? formatNumber(value, c.type)
														: ""}
											</span>
										)}
									</div>
								);
							})}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function block(node: Node, key: number): ReactNode {
	const children = node.content ?? [];
	switch (node.type) {
		case "table":
			return table(node as unknown as TableNode, key);
		case "heading": {
			const level = node.attrs?.level === 1 ? 1 : node.attrs?.level === 3 ? 3 : 2;
			const Tag = `h${level}` as "h1" | "h2" | "h3";
			return <Tag key={key}>{inline(children)}</Tag>;
		}
		case "bulletList":
			return <ul key={key}>{children.map(block)}</ul>;
		case "orderedList":
			return <ol key={key}>{children.map(block)}</ol>;
		case "listItem":
			return <li key={key}>{children.map(block)}</li>;
		case "quote":
			return <blockquote key={key}>{children.map(block)}</blockquote>;
		case "divider":
			return <hr key={key} data-ef-node="divider" />;
		default:
			return <p key={key}>{inline(children)}</p>;
	}
}

export function NativeProse({ body, label }: { body: DocNode; label: string }) {
	return (
		<div className="ef-sheet ef-native">
			<article aria-label={label} className="ef-paper">
				<div className="ProseMirror">{((body.content ?? []) as Node[]).map(block)}</div>
			</article>
		</div>
	);
}
