import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet, type Decoration } from "@tiptap/pm/view";

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
