import type { WordRun } from "@everyfield/contracts/documents";
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const WORD_MARK = {
	removed: { nodeName: "del", class: "ef-word ef-word-removed" },
	added: { nodeName: "ins", class: "ef-word ef-word-added" },
} as const;

function decorate(doc: PmNode, lines: readonly WordRun[][]): DecorationSet {
	const starts: number[] = [];
	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		starts.push(pos + 1);
		return false;
	});
	if (starts.length !== lines.length) return DecorationSet.empty;
	const marks = lines.flatMap((runs, k) => {
		const start = starts[k];
		if (start === undefined) return [];
		return runs
			.filter((run) => run.op !== "kept")
			.map((run) => Decoration.inline(start + run.from, start + run.to, WORD_MARK[run.op as "removed" | "added"]));
	});
	return DecorationSet.create(doc, marks);
}

export const wordMarks = (lines: readonly WordRun[][]) =>
	Extension.create({
		name: "wordMarks",
		addProseMirrorPlugins() {
			let made: { doc: PmNode; set: DecorationSet } | null = null;
			return [
				new Plugin({
					props: {
						decorations(state) {
							if (made?.doc !== state.doc) made = { doc: state.doc, set: decorate(state.doc, lines) };
							return made.set;
						},
					},
				}),
			];
		},
	});
