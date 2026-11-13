import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet, type Decoration } from "@tiptap/pm/view";

/**
 * A plugin whose decorations are read from the document alone. They live in plugin state, built when the editor starts
 * and again only when a transaction changes the document, so a cursor move or a React render draws nothing new.
 */
export function docDecorations(name: string, build: (doc: PMNode) => Decoration[]) {
	const key = new PluginKey<DecorationSet>(name);
	const create = (doc: PMNode) => DecorationSet.create(doc, build(doc));
	return new Plugin<DecorationSet>({
		key,
		state: {
			init: (_config, state) => create(state.doc),
			apply: (tr, old) => (tr.docChanged ? create(tr.doc) : old),
		},
		props: { decorations: (state) => key.getState(state) },
	});
}
