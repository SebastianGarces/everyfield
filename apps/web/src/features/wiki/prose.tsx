import { Prose } from "@everyfield/ui/display";
import { articleBlocks, inlineParts, type Inline } from "./model.ts";

// Renders the entitled body as elements. It does not parse MDX and it does not emit raw HTML.

function InlineText({ text }: { text: string }) {
	const parts = inlineParts(text);
	return (
		<>
			{parts.map((part, index) => (
				<Piece key={index} part={part} />
			))}
		</>
	);
}

function Piece({ part }: { part: Inline }) {
	if (part.kind === "strong") return <strong className="font-medium text-ink">{part.text}</strong>;
	if (part.kind === "link") return <a href={part.href}>{part.text}</a>;
	return part.text;
}

function Lines({ text }: { text: string }) {
	const lines = text.split("\n");
	return lines.map((line, index) => (
		<p key={index}>
			<InlineText text={line} />
		</p>
	));
}

/** The article body. Headings carry the ids the contents list uses. */
export function ArticleBody({ contentType, body }: { contentType: string; body: string }) {
	const blocks = articleBlocks(contentType, body);
	return (
		<Prose className="min-[1280px]:[&_h2]:scroll-mt-3 min-[1280px]:[&_h3]:scroll-mt-3 [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:border [&_th]:border-line [&_th]:px-2.5 [&_th]:py-1.5 [&_table]:w-full [&_table]:border-collapse">
			{blocks.map((block, index) => {
				if (block.kind === "heading") {
					const Tag = block.level === 3 ? "h3" : "h2";
					return (
						<Tag key={block.id} id={block.id}>
							{block.text}
						</Tag>
					);
				}
				if (block.kind === "quote")
					return (
						<blockquote key={index}>
							<InlineText text={block.text} />
						</blockquote>
					);
				if (block.kind === "list") {
					const Tag = block.ordered ? "ol" : "ul";
					return (
						<Tag key={index}>
							{block.items.map((item, itemIndex) => (
								<li key={itemIndex}>
									<InlineText text={item} />
								</li>
							))}
						</Tag>
					);
				}
				if (block.kind === "table")
					return (
						<div key={index} className="my-4 overflow-x-auto">
							<table>
								<tbody>
									{block.rows.map((row, rowIndex) => (
										<tr key={rowIndex}>
											{row.map((cell, cellIndex) => (
												<td key={cellIndex}>
													<InlineText text={cell} />
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					);
				if (block.kind === "callout")
					return (
						<aside key={index} role="note" className="my-5 rounded-card bg-surface-2 px-5 py-4">
							{block.label ? <p className="mb-1 font-medium text-ink">{block.label}</p> : null}
							<Lines text={block.text} />
						</aside>
					);
				return (
					<p key={index}>
						<InlineText text={block.text} />
					</p>
				);
			})}
		</Prose>
	);
}
