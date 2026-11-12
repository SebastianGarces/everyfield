import type { WordRun } from "@everyfield/contracts/documents";
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// The word marks of one side of a "Changed" item in the template compare (T-82), drawn as inline decorations on the
// read-only snippet: the document stays the block as saved, so nothing of a mark can reach a revision. Removed words
// are a <del> with a strikethrough and added words an <ins> with an underline; editor.css gives each a hidden
// "removed" or "added" word for a screen reader, so the color only repeats what the line and the words say.

/** A run's element and class, by what it is. */
export const WORD_MARK = {
	removed: { nodeName: "del", class: "ef-word ef-word-removed" },
	added: { nodeName: "ins", class: "ef-word ef-word-added" },
} as const;

/**
 * The decorations for `lines`, one list of runs per text line in reading order. Lines are the doc's text blocks in
 * order; when their count is not the compare's, the snippet shows the side unmarked rather than marks in the wrong
 * place.
 */
function decorate(doc: PmNode, lines: readonly WordRun[][]): DecorationSet {
	const starts: number[] = [];
	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		starts.push(pos + 1);
		return false;
	});
	if (starts.length !== lines.length) return DecorationSet.empty;
	const marks = lines.flatMap((runs, k) =>
		runs
			.filter((run) => run.op !== "kept")
			.map((run) =>
				Decoration.inline(starts[k]! + run.from, starts[k]! + run.to, WORD_MARK[run.op as "removed" | "added"]),
			),
	);
	return DecorationSet.create(doc, marks);
}

/** The extension that draws `lines` on a snippet, made once per doc: a read-only snippet keeps its first one. */
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
