import { createElement as h, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "../evry/conversation/markdown.ts";
import { renderMarkdown } from "../evry/conversation/view.ts";

// A task description on screen (REQ-TSK-016). The task panel and the list row read the same canonical value, which
// the server already normalized, and parse it with the one safe Markdown parser Evry's answers use: text becomes text
// nodes and only http, https and mailto addresses become links. Nothing here produces HTML. Written with createElement
// so tests/ui/tasks renders it in node.

const plain = (parts: Inline[]): string =>
	parts.map((p) => (p.kind === "text" || p.kind === "code" ? p.text : plain(p.children))).join("");

/** The description as readable lines, from the same parse the panel draws: each line, each list item, no markup. */
export function descriptionText(value: string): string {
	return parseMarkdown(value)
		.flatMap((block) =>
			block.kind === "paragraph"
				? block.lines.map(plain)
				: block.items.map((item, n) => `${block.ordered ? `${n + 1}.` : "•"} ${plain(item)}`),
		)
		.join("\n");
}

/** The full description in the task panel, or its empty state. */
export function DescriptionView({ value }: { value: string | null }): ReactNode {
	if (!value?.trim())
		return h("p", { className: "text-sm text-text-3", "data-description": "empty" }, "No description.");
	return h(
		"div",
		{ className: "flex flex-col gap-2 text-md break-words text-ink", "data-description": "full" },
		...renderMarkdown(value),
	);
}

/** The list row's two-line preview of the same text, or nothing when the task has no description. */
export function DescriptionPreview({ value }: { value: string }): ReactNode {
	const text = descriptionText(value);
	if (!text.trim()) return null;
	return h(
		"p",
		{
			className: "mt-0.5 line-clamp-2 text-sm break-words whitespace-pre-line text-text-2",
			"data-description": "preview",
		},
		text,
	);
}
