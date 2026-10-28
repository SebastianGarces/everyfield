"use client";

import { Download04Icon, HierarchyIcon } from "@hugeicons/core-free-icons";
import { Button, EmptyState, IntentLink, Switch, useToast } from "@everyfield/ui/controls";
import { cn } from "@everyfield/ui/foundations";
import { useState } from "react";
import { exportChart } from "./actions.ts";
import type { ChartNode } from "./model.ts";
import { LeaderLine, TeamIcon } from "./parts.tsx";

// The organization view (REQ-TEAM-012): Leadership is the fixed root and every other ministry sits under it. It is a
// picture of the ministries, not a reporting hierarchy, and nothing here edits one. The tree is nested lists, so a
// screen reader hears the same structure the lines draw. On a wide screen the ministries sit in one row that pans
// sideways; on a narrow one they stack under the root.

type Tree = { root: ChartNode | null; children: ChartNode[] };
function tree(nodes: readonly ChartNode[]): Tree {
	const root = nodes.find((n) => n.parentId === null && nodes.some((c) => c.parentId === n.id)) ?? null;
	const lone = root === null && nodes.length === 1 && nodes[0]!.parentId === null ? nodes[0]! : null;
	if (lone && lone.templateKey === "leadership") return { root: lone, children: [] };
	return { root, children: nodes.filter((n) => n !== root) };
}

// Each ministry under the root: a rail across the row and a stem down to the card (wide), or a tick off the side rail
// (narrow). The rail stops at the first and last card's middle.
const BRANCH = cn(
	"relative",
	"app-md:px-2 app-md:pt-6",
	"app-md:before:absolute app-md:before:inset-x-0 app-md:before:top-0 app-md:before:border-t-2 app-md:before:border-line-2",
	"app-md:first:before:left-1/2 app-md:last:before:right-1/2 app-md:only:before:hidden",
	"app-md:after:absolute app-md:after:top-0 app-md:after:left-1/2 app-md:after:h-6 app-md:after:border-l-2 app-md:after:border-line-2",
	"max-app-md:pt-3 max-app-md:pl-5",
	"max-app-md:before:absolute max-app-md:before:top-9 max-app-md:before:left-0 max-app-md:before:w-4 max-app-md:before:border-t-2 max-app-md:before:border-line-2",
);

function Node({ node, current }: { node: ChartNode; current?: boolean }) {
	return (
		<IntentLink
			href={`/ministries/${node.id}`}
			aria-current={current ? "page" : undefined}
			className={cn(
				"flex w-[232px] items-center gap-3 rounded-card border border-[var(--ef-card-edge)] bg-surface p-3.5 text-left shadow-card transition-shadow duration-150 hover:shadow-raised focus-visible:shadow-[0_0_0_2px_var(--ef-ink)] focus-visible:outline-none max-app-sm:w-full",
				current && "shadow-[0_0_0_2px_var(--ef-ink)]",
				node.archived && "border-dashed bg-surface-2",
			)}
		>
			<TeamIcon team={{ icon: null, templateKey: node.templateKey }} size={36} />
			<span className="flex min-w-0 flex-col gap-1">
				<span className="font-medium wrap-anywhere text-ink">{node.name}</span>
				{node.archived ? (
					<span className="text-xs font-semibold text-text-2">Archived</span>
				) : (
					<LeaderLine name={node.leaderName} className="text-xs" />
				)}
			</span>
		</IntentLink>
	);
}

/** The tree itself. `focus` draws only the root and that ministry, stacked, for the ministry page. */
export function ChartTree({ nodes, focus }: { nodes: readonly ChartNode[]; focus?: string }) {
	const t = tree(nodes);
	if (focus) {
		const node = nodes.find((n) => n.id === focus);
		if (!node) return null;
		return (
			<ul aria-label="Place in the organization view" className="flex flex-col">
				{t.root && t.root.id !== focus ? (
					<li className="flex flex-col">
						<Node node={t.root} />
						<span aria-hidden="true" className="ml-8 block h-4 w-0.5 bg-line-2" />
					</li>
				) : null}
				<li className={t.root && t.root.id !== focus ? "ml-8 border-l-2 border-line-2 pt-3 pl-4" : undefined}>
					<Node node={node} current />
				</li>
			</ul>
		);
	}
	const children = t.children;
	const list = (
		<ul
			className={cn(
				"flex max-app-md:flex-col",
				t.root && "max-app-md:ml-5 max-app-md:border-l-2 max-app-md:border-line-2",
				!t.root && "flex-wrap gap-4 max-app-md:gap-3",
				t.root && "app-md:justify-center",
			)}
		>
			{children.map((n) => (
				<li key={n.id} className={t.root ? BRANCH : undefined}>
					<Node node={n} current={n.id === focus} />
				</li>
			))}
		</ul>
	);
	if (!t.root) return list;
	return (
		<ul aria-label="Organization view">
			<li className="flex flex-col app-md:items-center">
				<Node node={t.root} current={t.root.id === focus} />
				{children.length ? (
					<>
						<span aria-hidden="true" className="block h-6 w-0.5 bg-line-2 max-app-md:ml-5 max-app-md:h-3" />
						{list}
					</>
				) : null}
			</li>
		</ul>
	);
}

/** The whole organization view on the ministries page, with the archived switch and the exports. */
export function OrgChart({ nodes, onAdd }: { nodes: readonly ChartNode[]; onAdd?: () => void }) {
	const [archived, setArchived] = useState(false);
	const shown = archived ? nodes : nodes.filter((n) => !n.archived);
	const hasArchived = nodes.some((n) => n.archived);
	const archivedLeadership = nodes.find((n) => n.archived && n.templateKey === "leadership");
	const t = tree(shown);
	return (
		<section aria-labelledby="org-chart-title" className="flex flex-col gap-5">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div className="min-w-0">
					<h2 id="org-chart-title" className="font-title text-title-md tracking-[-0.02em] text-ink">
						Organization view
					</h2>
					<p className="mt-1 max-w-[620px] text-md text-text-2 text-pretty">
						Every ministry under Leadership. It shows how the church is organized, not who reports to whom.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					{hasArchived ? <Switch checked={archived} onCheckedChange={setArchived} label="Show archived" /> : null}
					<Exports archived={archived} disabled={shown.length === 0} />
				</div>
			</div>
			{shown.length === 0 ? (
				<EmptyState icon={HierarchyIcon} title="No ministries to draw" headingLevel="h3">
					When ministries exist, they appear here under Leadership.
				</EmptyState>
			) : (
				<>
					{!t.root ? (
						<p className="rounded-md bg-surface-2 px-4 py-3 text-sm text-text-2">
							{archivedLeadership ? (
								<>
									The Leadership ministry is archived, so the chart has no root.{" "}
									<IntentLink
										href={`/ministries/${archivedLeadership.id}`}
										className="font-medium text-ink underline underline-offset-4 hover:no-underline"
									>
										Open Leadership to restore it
									</IntentLink>{" "}
									and put every ministry under it.
								</>
							) : (
								<>
									There is no Leadership ministry, so the chart has no root. Add Leadership from the templates to put
									every ministry under it.
									{onAdd ? (
										<Button variant="ghost" size="sm" className="ml-2" onClick={onAdd}>
											Set up ministries
										</Button>
									) : null}
								</>
							)}
						</p>
					) : null}
					{/* Wide charts pan sideways inside this box; the page itself never scrolls sideways. */}
					<div
						tabIndex={0}
						role="region"
						aria-label="Organization view, scrolls sideways"
						className="-mx-2 overflow-x-auto rounded-md px-2 pt-1 pb-4 focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] focus-visible:outline-none"
					>
						<div className="min-w-max max-app-md:min-w-0">
							<ChartTree nodes={shown} />
						</div>
					</div>
				</>
			)}
		</section>
	);
}

/** SVG and PDF of the same drawing. Each download reads the chart again, so it shows what the seat may see now. */
function Exports({ archived, disabled }: { archived: boolean; disabled: boolean }) {
	const toast = useToast();
	const [busy, setBusy] = useState<"svg" | "pdf" | null>(null);
	async function download(kind: "svg" | "pdf") {
		setBusy(kind);
		const r = await exportChart(archived).catch(() => ({ status: "lost" }) as const);
		setBusy(null);
		if (r.status !== "ok") {
			toast({ message: "The chart did not download. Nothing changed. Try again in a moment.", tone: "error" });
			return;
		}
		const blob = new Blob([kind === "svg" ? r.value.svg : r.value.pdf], {
			type: kind === "svg" ? "image/svg+xml" : "application/pdf",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `organization-view.${kind}`;
		a.click();
		URL.revokeObjectURL(url);
	}
	return (
		<div className="flex gap-2">
			<Button
				variant="secondary"
				size="sm"
				icon={Download04Icon}
				loading={busy === "svg"}
				disabled={disabled || busy !== null}
				onClick={() => download("svg")}
			>
				Download SVG
			</Button>
			<Button
				variant="secondary"
				size="sm"
				icon={Download04Icon}
				loading={busy === "pdf"}
				disabled={disabled || busy !== null}
				onClick={() => download("pdf")}
			>
				Download PDF
			</Button>
		</div>
	);
}
