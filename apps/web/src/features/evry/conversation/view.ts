import { createElement as h, Fragment, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "./markdown.ts";

const CODE = "rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-ink";
const LINK = "text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]";

function pieces(parts: Inline[]): ReactNode[] {
	return parts.map((part, key) => {
		switch (part.kind) {
			case "text":
				return h(Fragment, { key }, part.text);
			case "strong":
				return h("strong", { key, className: "font-medium text-ink" }, ...pieces(part.children));
			case "em":
				return h("em", { key }, ...pieces(part.children));
			case "code":
				return h("code", { key, className: CODE }, part.text);
			case "link":
				return h(
					"a",
					{
						key,
						href: part.href,
						className: LINK,
						...(part.external ? { target: "_blank", rel: "noopener noreferrer" } : {}),
					},
					...pieces(part.children),
				);
		}
	});
}

export function renderMarkdown(text: string, open = false): ReactNode[] {
	return parseMarkdown(text, open).map((block, key) => {
		if (block.kind === "paragraph")
			return h(
				"p",
				{ key },
				...block.lines.map((line, n) => h("span", { key: n }, n ? h("br") : null, ...pieces(line))),
			);
		return h(
			block.ordered ? "ol" : "ul",
			{ key, className: `${block.ordered ? "list-decimal" : "list-disc"} flex flex-col gap-1 pl-5 marker:text-text-3` },
			...block.items.map((item, n) => h("li", { key: n }, ...pieces(item))),
		);
	});
}
