import { Prose, WikiDiagram } from "@everyfield/ui/display";
import { diagramSummary } from "@everyfield/contracts/wiki";
import { HEADING_STOP } from "./layout.ts";
import { articleBlocks, inlineParts, type Block, type Inline } from "./model.ts";

// Renders the entitled body as elements. It does not parse MDX and it does not emit raw HTML. A code fence shows its
// text as written; a diagram fence that parses draws as a diagram (WP-034).

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

const TABLE_LINES =
	"[&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:border [&_th]:border-line [&_th]:px-2.5 [&_th]:py-1.5 [&_table]:w-full [&_table]:border-collapse";

/** One block as the article renders it. The editor shows its read-only blocks with this too. */
export function ArticleBlock({ block }: { block: Block }) {
	if (block.kind === "heading") {
		const Tag = block.level === 3 ? "h3" : "h2";
		return <Tag id={block.id}>{block.text}</Tag>;
	}
	if (block.kind === "quote")
		return (
			<blockquote>
				<InlineText text={block.text} />
			</blockquote>
		);
	if (block.kind === "list") {
		const Tag = block.ordered ? "ol" : "ul";
		return (
			<Tag>
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
			<div className="my-4 overflow-x-auto">
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
	if (block.kind === "code")
		return (
			<pre
				tabIndex={0}
				className="my-5 max-w-full overflow-x-auto rounded-card border border-line bg-surface-2 px-4 py-3.5 font-mono text-[13.5px] leading-[1.6] text-ink"
			>
				<code>{block.text}</code>
			</pre>
		);
	if (block.kind === "diagram") return <WikiDiagram diagram={block.diagram} summary={diagramSummary(block.diagram)} />;
	if (block.kind === "callout")
		return (
			<aside role="note" className="my-5 rounded-card bg-surface-2 px-5 py-4">
				{block.label ? <p className="mb-1 font-medium text-ink">{block.label}</p> : null}
				<Lines text={block.text} />
			</aside>
		);
	return (
		<p>
			<InlineText text={block.text} />
		</p>
	);
}

/** Blocks inside the article's prose styles. */
export function ArticleBlocks({
	blocks,
	size,
	className = "",
}: {
	blocks: readonly Block[];
	size?: "md" | "sm";
	className?: string;
}) {
	return (
		<Prose size={size} className={`${className} ${HEADING_STOP} ${TABLE_LINES}`}>
			{blocks.map((block, index) => (
				<ArticleBlock key={block.kind === "heading" ? block.id : index} block={block} />
			))}
		</Prose>
	);
}

/** The article body. Headings carry the ids the contents list uses. */
export function ArticleBody({
	contentType,
	body,
	size,
	className = "",
}: {
	contentType: string;
	body: string;
	size?: "md" | "sm";
	className?: string;
}) {
	return <ArticleBlocks blocks={articleBlocks(contentType, body)} size={size} className={className} />;
}
