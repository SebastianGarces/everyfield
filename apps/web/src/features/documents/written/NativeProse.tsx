import { safeLinkAddress } from "@everyfield/contracts/common";
import type { DocNode } from "@everyfield/contracts/documents";
import type { ReactNode } from "react";
import "../church/editor/editor.css";

// A native body drawn read-only, for a Member and for an archived document: the editor's paper and type, without the
// editor. Text is drawn as text nodes and never as HTML; a link keeps only an address the safe link rule accepts.

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

function block(node: Node, key: number): ReactNode {
	const children = node.content ?? [];
	switch (node.type) {
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
