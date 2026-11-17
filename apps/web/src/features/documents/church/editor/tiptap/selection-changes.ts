import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";

const key = new PluginKey<number>("selectionChanges");

export const selectionChanges = () =>
	new Plugin<number>({
		key,
		state: {
			init: () => 0,
			apply: (_tr, count, before, after) => (after.selection.eq(before.selection) ? count : count + 1),
		},
	});

export const selectionChangeCount = (state: EditorState) => key.getState(state) ?? 0;
