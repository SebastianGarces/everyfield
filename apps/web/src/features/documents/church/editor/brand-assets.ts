import type { DocBrand } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/core";

type Assets = DocBrand["assets"];

export type LiveAssets = ReturnType<typeof liveAssets>;

export function liveAssets(initial: Assets) {
	let current = initial;
	let shown: Editor | null = null;
	return {
		assets: {
			get logo() {
				return current.logo;
			},
			get mark() {
				return current.mark;
			},
			get photo() {
				return current.photo;
			},
		} satisfies Assets,
		drawIn(editor: Editor) {
			shown = editor;
			editor.on("destroy", () => {
				if (shown === editor) shown = null;
			});
		},
		show(next: Assets) {
			if (next === current) return;
			current = next;
			if (shown && !shown.isDestroyed) shown.createNodeViews();
		},
	};
}
