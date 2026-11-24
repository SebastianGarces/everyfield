import assert from "node:assert/strict";
import type {
	BlockNode,
	DocDifference,
	DocNode,
	generatedDocument,
	ParagraphNode,
	SlotNode,
} from "../../../packages/contracts/src/documents/index.ts";

export function present<T>(value: T | null | undefined, what = "a value"): T {
	assert.ok(value !== null && value !== undefined, `${what} is missing`);
	return value;
}

export type Generated = (typeof generatedDocument)["_output"];

export const blocksOf = (doc: { body: DocNode }): BlockNode[] => present(doc.body.content, "the body's content");

export const isSlot = (node: BlockNode): node is SlotNode => node.type === "slot";
export const para = (text: string): ParagraphNode => ({ type: "paragraph", content: [{ type: "text", text }] });

const isKind = <K extends BlockNode["type"]>(
	node: BlockNode | null | undefined,
	type: K,
): node is Extract<BlockNode, { type: K }> => node?.type === type;
export function asKind<K extends BlockNode["type"]>(node: BlockNode | null | undefined, type: K) {
	assert.ok(isKind(node, type), `a ${type} block, not ${node?.type}`);
	return node;
}
export function firstText(node: DocDifference["document"] | BlockNode | undefined) {
	assert.ok(node && typeof node === "object" && "type" in node);
	assert.ok(node.type === "heading" || node.type === "paragraph", node.type);
	const [first] = node.content ?? [];
	assert.ok(first?.type === "text");
	return first.text;
}
