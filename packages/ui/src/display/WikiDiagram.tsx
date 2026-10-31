import { useId, type CSSProperties, type ReactNode } from "react";
import { cn } from "../foundations";

/**
 * WikiDiagram (WP-034): a diagram block from a Wiki article, drawn as cards with real text. The shape is structural, so
 * the parsed contracts `Diagram` fits it and this package needs no contracts import. The figure is named by its title
 * and the caller's `summary`, the text alternative (type, node count, loop). The nodes are a list in source order: `<ol>` for flow, stages, cycle
 * and timeline, nested `<ul>` for hierarchy. Arrows, rails and rings are decoration and hidden from assistive tech.
 * Layouts follow the figure's own width (container queries): flow, cycle and timeline turn vertical when narrow.
 */
export type WikiDiagramNode = { readonly label: string; readonly detail?: string; readonly note?: string };
export type WikiDiagramTreeNode = WikiDiagramNode & { readonly children: readonly WikiDiagramTreeNode[] };
export type WikiDiagramData =
	| {
			readonly type: "flow" | "cycle";
			readonly title: string;
			readonly loop?: string;
			readonly nodes: readonly WikiDiagramNode[];
	  }
	| { readonly type: "stages" | "timeline"; readonly title: string; readonly nodes: readonly WikiDiagramNode[] }
	| { readonly type: "hierarchy"; readonly title: string; readonly nodes: readonly WikiDiagramTreeNode[] };

/** Overrides for the article prose around the figure: its list bullets, paddings and paragraph gaps. */
const RESET = "m-0! list-none! p-0! [&>li]:my-0!";

export function WikiDiagram({
	diagram,
	summary,
	className,
}: {
	diagram: WikiDiagramData;
	summary: string;
	className?: string;
}) {
	const id = useId();
	const loop = "loop" in diagram && diagram.loop ? diagram.loop : null;
	return (
		<figure
			aria-labelledby={`${id}-title ${id}-alt`}
			data-diagram={diagram.type}
			className={cn(
				"@container my-6 rounded-card border border-line bg-surface-2 px-4 py-5 leading-snug text-ink-2 @xl:px-6",
				className,
			)}
		>
			<figcaption id={`${id}-title`} className="mb-4 font-title text-[19px] leading-tight tracking-[-0.02em] text-ink">
				{diagram.title}
			</figcaption>
			<span id={`${id}-alt`} className="sr-only">
				{summary}
			</span>
			{diagram.type === "flow" ? <Flow nodes={diagram.nodes} loop={loop} /> : null}
			{diagram.type === "stages" ? <Stages nodes={diagram.nodes} /> : null}
			{diagram.type === "cycle" ? <Cycle nodes={diagram.nodes} /> : null}
			{diagram.type === "hierarchy" ? <Tree nodes={diagram.nodes} root /> : null}
			{diagram.type === "timeline" ? <Timeline nodes={diagram.nodes} /> : null}
			{loop ? (
				<p className="m-0! mt-4! flex items-center gap-2 text-sm text-text-2">
					<ReturnIcon />
					<span>
						<span className="font-medium text-ink">Repeats:</span> {loop}
					</span>
				</p>
			) : null}
		</figure>
	);
}

/** Label, detail and note of one node as block text (spans, so the prose paragraph spacing does not apply). */
function Text({ node, note = true }: { node: WikiDiagramNode; note?: boolean }) {
	return (
		<>
			<span className="block font-medium text-ink">{node.label}</span>
			{node.detail ? <span className="mt-1 block text-sm text-text-2">{node.detail}</span> : null}
			{note && node.note ? <span className="mt-1.5 block text-xs font-medium text-text-3">{node.note}</span> : null}
		</>
	);
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn("relative min-w-0 rounded-md bg-surface-raised px-3.5 py-3 shadow-raised", className)}>
			{children}
		</div>
	);
}

function Number({ n, className }: { n: number; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"num grid size-6 shrink-0 place-items-center rounded-full bg-green-100 text-[13px] text-green-700",
				className,
			)}
		>
			{n}
		</span>
	);
}

/** A connector arrow pointing down; `sideways` turns it right in the wide layout. */
function Arrow({ sideways }: { sideways: boolean }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 16 24"
			className={cn("mx-auto h-6 w-4 shrink-0 text-text-3", sideways && "@xl:my-auto @xl:-rotate-90")}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M8 2v19M3 16l5 5 5-5" />
		</svg>
	);
}

function ReturnIcon() {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 20 20"
			className="size-5 shrink-0 text-green-700"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M15.5 6.5A6.5 6.5 0 1 0 16.5 12" />
			<path d="M16 2.5v4h-4" />
		</svg>
	);
}

/** Steps joined by arrows. Four steps or fewer run across a wide figure; a loop draws a return path back to step 1. */
function Flow({ nodes, loop }: { nodes: readonly WikiDiagramNode[]; loop: string | null }) {
	const across = nodes.length <= 4;
	return (
		<div className="relative">
			<ol
				className={cn(
					RESET,
					"flex flex-col",
					across && "@xl:flex-row",
					loop && "pl-6!",
					loop && across && "@xl:pb-6! @xl:pl-0!",
				)}
			>
				{nodes.map((node, index) => (
					<li key={index} className={cn("flex min-w-0 flex-col", across && "@xl:flex-1 @xl:flex-row")}>
						{index > 0 ? (
							<span className={cn("flex py-1", across && "@xl:px-1.5 @xl:py-0")}>
								<Arrow sideways={across} />
							</span>
						) : null}
						<Card className={cn("flex items-start gap-3", across && "@xl:flex-1 @xl:flex-col @xl:gap-2")}>
							<Number n={index + 1} />
							<span className="min-w-0">
								<Text node={node} />
							</span>
						</Card>
					</li>
				))}
			</ol>
			{loop ? <ReturnRail across={across} /> : null}
		</div>
	);
}

/** The return path of a vertical loop: a rail on the left. `wideHidden` drops it in a wide figure. */
function SideRail({ wideHidden }: { wideHidden: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute top-6 bottom-6 left-0 w-4 rounded-l-lg border-y-[1.75px] border-l-[1.75px] border-text-3",
				wideHidden && "@xl:hidden",
			)}
		>
			<span className="absolute -top-[5.5px] right-0 size-0 border-y-[4.5px] border-l-[7px] border-y-transparent border-l-text-3" />
		</span>
	);
}

/** The return path of a loop: a rail on the left in the vertical form, a bracket under the row when across. */
function ReturnRail({ across }: { across: boolean }) {
	return (
		<>
			<SideRail wideHidden={across} />
			{across ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute bottom-0 left-[12%] right-[12%] hidden h-6 rounded-b-lg border-x-[1.75px] border-b-[1.75px] border-text-3 @xl:block"
				>
					<span className="absolute -top-[2px] -left-[5.5px] size-0 border-x-[4.5px] border-b-[7px] border-x-transparent border-b-text-3" />
				</span>
			) : null}
		</>
	);
}

/** Numbered stage cards in reading order. */
function Stages({ nodes }: { nodes: readonly WikiDiagramNode[] }) {
	return (
		<ol className={cn(RESET, "grid gap-3 @md:grid-cols-2", nodes.length % 3 === 0 && "@2xl:grid-cols-3")}>
			{nodes.map((node, index) => (
				<li key={index} className="flex">
					<Card className="flex-1 border-t-[3px] border-green-500 pt-3">
						<span aria-hidden="true" className="num mb-1.5 block text-[22px] leading-none text-green-700">
							{String(index + 1).padStart(2, "0")}
						</span>
						<Text node={node} />
					</Card>
				</li>
			))}
		</ol>
	);
}

/**
 * Perimeter cells of a 3 by 3 grid, clockwise from the top middle, for 2 to 8 nodes in a wide figure. Each cell is
 * [row, column]. The center holds the ring mark; the cards sit on a rounded ring drawn behind them.
 */
const RING: Record<number, readonly (readonly [number, number])[]> = {
	2: [
		[1, 2],
		[3, 2],
	],
	3: [
		[1, 2],
		[3, 3],
		[3, 1],
	],
	4: [
		[1, 2],
		[2, 3],
		[3, 2],
		[2, 1],
	],
	5: [
		[1, 2],
		[2, 3],
		[3, 3],
		[3, 1],
		[2, 1],
	],
	6: [
		[1, 1],
		[1, 3],
		[2, 3],
		[3, 3],
		[3, 1],
		[2, 1],
	],
	7: [
		[1, 1],
		[1, 2],
		[1, 3],
		[2, 3],
		[3, 3],
		[3, 1],
		[2, 1],
	],
	8: [
		[1, 1],
		[1, 2],
		[1, 3],
		[2, 3],
		[3, 3],
		[3, 2],
		[3, 1],
		[2, 1],
	],
};

/** Nodes on a closed loop: a ring of cards in a wide figure, or a column with a return rail. */
function Cycle({ nodes }: { nodes: readonly WikiDiagramNode[] }) {
	const ring = RING[nodes.length];
	const place = (index: number) =>
		ring ? ({ "--row": ring[index]![0], "--col": ring[index]![1] } as CSSProperties) : undefined;
	return (
		<div className="relative">
			{ring ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-[16%] inset-y-[14%] hidden rounded-card border-[1.75px] border-dashed border-text-3 @xl:block"
				/>
			) : null}
			<ol
				className={cn(
					RESET,
					"relative flex flex-col pl-6!",
					ring &&
						"@xl:grid @xl:grid-cols-[1fr_minmax(96px,0.7fr)_1fr] @xl:items-center @xl:gap-x-4 @xl:gap-y-5 @xl:pl-0!",
				)}
			>
				{nodes.map((node, index) => (
					<li
						key={index}
						style={place(index)}
						className={cn("flex flex-col", ring && "@xl:[grid-column:var(--col)] @xl:[grid-row:var(--row)]")}
					>
						{index > 0 ? (
							<span className={cn("flex py-1", ring && "@xl:hidden")}>
								<Arrow sideways={false} />
							</span>
						) : null}
						<Card className="flex items-start gap-3">
							<Number n={index + 1} />
							<span className="min-w-0">
								<Text node={node} />
							</span>
						</Card>
					</li>
				))}
			</ol>
			{ring ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 left-1/2 hidden size-14 -translate-1/2 place-items-center rounded-full bg-surface-2 text-green-700 @xl:grid"
				>
					<svg
						viewBox="0 0 32 32"
						className="size-9"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M25.5 12A10 10 0 0 0 7 10.5M6.5 20A10 10 0 0 0 25 21.5" />
						<path d="M7 5v5.5h5.5M25 27v-5.5h-5.5" />
					</svg>
				</span>
			) : null}
			<SideRail wideHidden={!!ring} />
		</div>
	);
}

/** A tree: each level indents under its parent with elbow connectors. */
function Tree({ nodes, root = false }: { nodes: readonly WikiDiagramTreeNode[]; root?: boolean }) {
	return (
		<ul className={cn(RESET, !root && "mt-2! ml-4! pl-5!")}>
			{nodes.map((node, index) => (
				<li
					key={index}
					className={cn(
						"relative",
						!root && "mt-2!",
						// The elbow: a line down from the parent and across to this card. The last child stops at its card.
						!root &&
							"before:absolute before:-top-2 before:-left-5 before:h-[calc(1.5rem+0.5rem)] before:w-4 before:rounded-bl-md before:border-b-[1.75px] before:border-l-[1.75px] before:border-text-3 before:content-['']",
						!root &&
							index < nodes.length - 1 &&
							"after:absolute after:top-0 after:bottom-[-0.5rem] after:-left-5 after:border-l-[1.75px] after:border-text-3 after:content-['']",
					)}
				>
					<Card className={cn(root ? "bg-surface-raised" : "py-2.5", "inline-block max-w-full")}>
						<Text node={node} />
					</Card>
					{node.children.length ? <Tree nodes={node.children} /> : null}
				</li>
			))}
		</ul>
	);
}

/** Markers on a line, each with its note as the time label. Five or fewer run across a wide figure. */
function Timeline({ nodes }: { nodes: readonly WikiDiagramNode[] }) {
	const across = nodes.length <= 5;
	return (
		<div className="relative">
			<span
				aria-hidden="true"
				className={cn(
					"absolute top-2 bottom-2 left-[5px] w-[1.75px] bg-text-3",
					across && "@xl:top-[29px] @xl:right-0 @xl:bottom-auto @xl:left-0 @xl:h-[1.75px] @xl:w-auto",
				)}
			/>
			<ol className={cn(RESET, "relative flex flex-col", across && "@xl:flex-row @xl:gap-3")}>
				{nodes.map((node, index) => (
					<li
						key={index}
						className={cn(
							"relative flex min-w-0 flex-col pb-5 pl-7 last:pb-0",
							across && "@xl:flex-1 @xl:pb-0 @xl:pl-0",
						)}
					>
						<span
							className={cn(
								"block min-h-5 text-xs font-semibold tracking-wide text-green-700 uppercase",
								across && "@xl:h-5",
							)}
						>
							{node.note ?? ""}
						</span>
						<span
							aria-hidden="true"
							className={cn(
								"absolute top-[3px] left-0 size-3 rounded-full border-[2.5px] border-green-700 bg-surface-2",
								across && "@xl:static @xl:my-1.5",
							)}
						/>
						<span className={cn("mt-1 block", across && "@xl:mt-0")}>
							<Text node={node} note={false} />
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}
