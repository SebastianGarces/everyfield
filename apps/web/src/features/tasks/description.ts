import { createElement as h, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "../evry/conversation/markdown.ts";
import { renderMarkdown } from "../evry/conversation/view.ts";

const plain = (parts: Inline[]): string =>
	parts.map((p) => (p.kind === "text" || p.kind === "code" ? p.text : plain(p.children))).join("");

function descriptionText(value: string): string {
	return parseMarkdown(value)
		.flatMap((block) =>
			block.kind === "paragraph"
				? block.lines.map(plain)
				: block.items.map((item, n) => `${block.ordered ? `${n + 1}.` : "•"} ${plain(item)}`),
		)
		.join("\n");
}

export function DescriptionView({ value }: { value: string | null }): ReactNode {
	if (!value?.trim())
		return h("p", { className: "text-sm text-text-3", "data-description": "empty" }, "No description.");
	return h(
		"div",
		{ className: "flex flex-col gap-2 text-md break-words text-ink", "data-description": "full" },
		...renderMarkdown(value),
	);
}

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
