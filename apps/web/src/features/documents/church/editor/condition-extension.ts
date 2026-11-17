import { Extension, mergeAttributes, Node } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration } from "@tiptap/pm/view";
import type { DocDocument, FieldDecl } from "@everyfield/contracts/documents";
import { attrsOfSpec, BLOCKS } from "./attrs.ts";
import { docDecorations } from "./doc-decorations.ts";
import { conditionHolds } from "@everyfield/domain/documents/values";
import { conditionLabel, type Condition } from "./condition.ts";

export const conditionOf = (node: PMNode): Condition => ({
	field: String(node.attrs.field ?? ""),
	test: (node.attrs.test as Condition["test"] | undefined) ?? "has-value",
	...(typeof node.attrs.value === "number" ? { value: node.attrs.value } : {}),
});

function conditionSpec(root: PMNode, node: PMNode) {
	const fields = (root.attrs.fields as FieldDecl[] | undefined) ?? [];
	const doc = { kind: "document", fields, data: root.attrs.data } as DocDocument;
	const condition = conditionOf(node);
	return { conditionText: conditionLabel(fields, condition), prints: conditionHolds(doc, condition) };
}
type ConditionSpec = ReturnType<typeof conditionSpec>;

export const EfIf = Node.create({
	name: "if",
	group: BLOCKS,
	content: "block+",
	defining: true,
	isolating: true,
	addAttributes() {
		return attrsOfSpec({ field: "string", test: "string", value: "number" });
	},
	parseHTML: () => [{ tag: 'div[data-ef-node="if"]' }],
	renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-ef-node": "if" }), 0],
	addNodeView() {
		return ({ node, decorations }) => conditionView(node, decorations);
	},
	addProseMirrorPlugins() {
		return [
			docDecorations("efConditionState", (doc) => {
				const found: Decoration[] = [];
				doc.descendants((node, pos) => {
					if (node.type.name !== "if") return true;
					found.push(Decoration.node(pos, pos + node.nodeSize, {}, conditionSpec(doc, node)));
					return false;
				});
				return found;
			}),
		];
	},
});

function conditionView(initial: PMNode, decorations: readonly Decoration[]) {
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
	const draw = (decos: readonly Decoration[]) => {
		const spec = decos.find((d) => (d.spec as Partial<ConditionSpec>).conditionText !== undefined)?.spec as
			ConditionSpec | undefined;
		const text = spec?.conditionText ?? "";
		const prints = spec?.prints ?? true;
		label.textContent = text;
		state.textContent = prints ? "Prints now" : "Does not print now";
		dom.dataset.prints = prints ? "true" : "false";
		dom.setAttribute("aria-label", `Conditional text. ${text}. ${state.textContent}.`);
	};
	draw(decorations);
	return {
		dom,
		contentDOM,
		update(next: PMNode, decos: readonly Decoration[]) {
			if (next.type !== initial.type) return false;
			draw(decos);
			return true;
		},
		ignoreMutation: (mutation: { target: globalThis.Node; type: string }) =>
			mutation.type !== "selection" && head.contains(mutation.target),
	};
}

const DENY: Record<string, string[]> = { column: ["pageBreak", "columns"], box: ["pageBreak", "box"] };
const NAME: Record<string, string> = { pageBreak: "a page break", columns: "columns", box: "a box" };

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

export function conditionIssue(doc: PMNode): string | null {
	let found: string | null = null;
	doc.descendants((node, pos) => {
		if (found) return false;
		if (node.type.name !== "if") return true;
		found = issueAt(doc, pos, node);
		return found === null;
	});
	return found;
}

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
