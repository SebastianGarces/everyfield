import { Extension, mergeAttributes, Node } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { DocDocument } from "@everyfield/contracts/documents";
import { attrsOfSpec, BLOCKS } from "./attrs.ts";
import { conditionHolds } from "@everyfield/domain/documents/values";
import { conditionLabel, type Condition } from "./condition.ts";

// Conditional text: the format's `if` node. It always shows its blocks so they can be edited; a condition that does not
// hold with this document's values dims them and says "Does not print now". The rules plugin keeps it where the format
// takes it: in the body, a column or a box, never in the page header or footer, never inside another conditional text,
// and never around a budget table, a section slot or a block its column or box refuses.

export type ConditionDoc = Pick<DocDocument, "kind" | "fields" | "data">;

/** The condition an `if` node holds. */
export const conditionOf = (node: PMNode): Condition => ({
	field: String(node.attrs.field ?? ""),
	test: (node.attrs.test as Condition["test"] | undefined) ?? "has-value",
	...(typeof node.attrs.value === "number" ? { value: node.attrs.value } : {}),
});

export const EfIf = Node.create<{ doc: ConditionDoc | null }>({
	name: "if",
	group: BLOCKS,
	content: "block+",
	defining: true,
	isolating: true,
	addOptions: () => ({ doc: null }),
	addAttributes() {
		return attrsOfSpec({ field: "string", test: "string", value: "number" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="if"]' }],
	renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-ef-node": "if" }), 0],
	addNodeView() {
		const doc = this.options.doc;
		return ({ node }) => conditionView(node, doc);
	},
});

/** The block on the page: its condition and whether it prints now, above its editable blocks. */
function conditionView(initial: PMNode, doc: ConditionDoc | null) {
	const dom = document.createElement("div");
	dom.className = "ef-if";
	dom.setAttribute("data-ef-node", "if");
	dom.setAttribute("role", "group");
	const head = document.createElement("div");
	head.className = "ef-if-head";
	head.contentEditable = "false";
	const label = document.createElement("span");
	label.className = "ef-if-label";
	const state = document.createElement("span");
	state.className = "ef-if-state";
	head.append(label, state);
	const contentDOM = document.createElement("div");
	contentDOM.className = "ef-if-body";
	dom.append(head, contentDOM);
	const draw = (node: PMNode) => {
		const condition = conditionOf(node);
		const text = conditionLabel(doc?.fields ?? [], condition);
		const prints = doc ? conditionHolds(doc as DocDocument, condition) : true;
		label.textContent = text;
		state.textContent = prints ? "Prints now" : "Does not print now";
		dom.dataset.prints = prints ? "true" : "false";
		dom.setAttribute("aria-label", `Conditional text. ${text}. ${state.textContent}.`);
	};
	draw(initial);
	return {
		dom,
		contentDOM,
		update(next: PMNode) {
			if (next.type !== initial.type) return false;
			draw(next);
			return true;
		},
		ignoreMutation: (mutation: { target: globalThis.Node; type: string }) =>
			mutation.type !== "selection" && head.contains(mutation.target),
	};
}

// ---------------------------------------------------------------- where it may sit

/** What a column and a box refuse inside them, conditional text included (the format's `deny`, passed down). */
const DENY: Record<string, string[]> = { column: ["pageBreak", "columns"], box: ["pageBreak", "box"] };
const NAME: Record<string, string> = { pageBreak: "a page break", columns: "columns", box: "a box" };

/** Why the conditional text at `pos` cannot sit where it is, or null when the format takes it. */
function issueAt(doc: PMNode, pos: number, node: PMNode): string | null {
	const $pos = doc.resolve(pos);
	const deny = new Set<string>();
	for (let d = 1; d <= $pos.depth; d++) {
		const name = $pos.node(d).type.name;
		if (name === "pageHeader" || name === "pageFooter")
			return "Conditional text cannot sit in the page header or footer. It prints in the body only.";
		if (name === "if") return "Conditional text cannot hold another conditional text.";
		for (const type of DENY[name] ?? []) deny.add(type);
	}
	let found: string | null = null;
	node.forEach((child) => {
		if (!found && deny.has(child.type.name))
			found = `Conditional text inside a column or box cannot hold ${NAME[child.type.name]}.`;
	});
	node.descendants((child) => {
		if (found) return false;
		if (child.type.name === "slot") found = "A section slot cannot sit inside conditional text.";
		else if (child.type.name === "table" && child.attrs.style === "ledger")
			found = "A budget table cannot sit inside conditional text. The Excel file prints no conditions.";
		return !found;
	});
	return found;
}

/** The first reason any conditional text in the document cannot sit where it is, or null. */
export function conditionIssue(doc: PMNode): string | null {
	let found: string | null = null;
	doc.descendants((node, pos) => {
		if (found) return false;
		if (node.type.name !== "if") return true;
		found = issueAt(doc, pos, node);
		// Go on into it: conditional text inside conditional text is a fault of the inner one.
		return found === null;
	});
	return found;
}

/** A pasted slice with each conditional text replaced by its blocks, for a place that takes no conditional text. */
function unwrap(slice: Slice): Slice {
	const strip = (fragment: Fragment): Fragment => {
		const nodes: PMNode[] = [];
		fragment.forEach((child) => {
			if (child.type.name === "if") strip(child.content).forEach((inner) => nodes.push(inner));
			else nodes.push(child.isLeaf ? child : child.copy(strip(child.content)));
		});
		return Fragment.fromArray(nodes);
	};
	return new Slice(strip(slice.content), slice.openStart, slice.openEnd);
}

/**
 * Keeps conditional text where the format takes it. A change that would put it somewhere else does not happen, and the
 * editor says why. A paste into the header, the footer or another conditional text keeps the blocks and drops the
 * condition around them.
 */
export const ConditionRules = Extension.create({
	name: "conditionRules",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("efConditionRules"),
				filterTransaction: (tr) => {
					if (!tr.docChanged) return true;
					const issue = conditionIssue(tr.doc);
					if (issue) this.editor.emit("conditionChangeRefused", issue);
					return issue === null;
				},
				props: {
					transformPasted: (slice, view) => {
						const $from = view.state.selection.$from;
						for (let d = $from.depth; d >= 0; d--) {
							const name = $from.node(d).type.name;
							if (name === "if" || name === "pageHeader" || name === "pageFooter") return unwrap(slice);
						}
						return slice;
					},
				},
			}),
		];
	},
});

declare module "@tiptap/core" {
	interface EditorEvents {
		conditionChangeRefused: string;
	}
}
