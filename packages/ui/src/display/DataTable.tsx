"use client";

import { ArrowLeft01Icon, ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { Button, Checkbox, EmptyState, Skeleton, StatePanel } from "../controls";
import { cn, Icon, type IconSvgElement } from "../foundations";
import type { Loadable } from "./values";

export type EmptyCopy = { icon?: IconSvgElement; title: string; text?: ReactNode; action?: ReactNode };

/**
 * The loading, error and empty states of anything that loads data (components.md: every component that loads data
 * draws them from StatePanel, Skeleton and EmptyState). `skeleton` is the loading shape; children render the data.
 */
export function LoadableView<T>({
	state,
	isEmpty,
	empty,
	skeleton,
	loadingLabel = "Loading",
	children,
}: {
	state: Loadable<T>;
	isEmpty?: (data: T) => boolean;
	empty: EmptyCopy;
	skeleton: ReactNode;
	loadingLabel?: string;
	children: (data: T) => ReactNode;
}) {
	if (state.status === "loading") {
		return (
			<div aria-busy="true">
				<span className="sr-only" role="status">
					{loadingLabel}
				</span>
				{skeleton}
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<StatePanel
				tone="error"
				title={state.title ?? "This did not load"}
				headingLevel="h3"
				className="py-10"
				meta={state.meta}
				actions={
					state.onRetry ? (
						<Button variant="secondary" size="sm" onClick={state.onRetry}>
							Try again
						</Button>
					) : undefined
				}
			>
				Nothing was changed. Try again in a moment.
			</StatePanel>
		);
	}
	if (isEmpty?.(state.data)) {
		return (
			<EmptyState icon={empty.icon ?? Search01Icon} title={empty.title} action={empty.action}>
				{empty.text}
			</EmptyState>
		);
	}
	return <>{children(state.data)}</>;
}

export type Column<Row> = {
	key: string;
	header: ReactNode;
	cell: (row: Row) => ReactNode;
	align?: "left" | "right";
	/** Numbers in the display face with tabular figures. */
	numeric?: boolean;
	width?: string;
	/** A header the eye does not need (an action column); it stays for screen readers. */
	srOnlyHeader?: boolean;
};

export type Selection = { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void };

/**
 * DataTable (components.md): Header, Row, Cell and Selection, with a highlighted row. It is a real table with a
 * caption. Below the content width it scrolls sideways in a focusable, named region, so keyboard users can scroll it.
 */
export function DataTable<Row>({
	caption,
	captionHidden = true,
	columns,
	state,
	rowId,
	rowLabel,
	selection,
	highlight,
	empty,
	skeletonRows = 3,
	minWidth = 720,
	className,
}: {
	caption: string;
	captionHidden?: boolean;
	columns: Column<Row>[];
	state: Loadable<Row[]>;
	rowId: (row: Row) => string;
	/** The row's name for its selection box: "Select Maria Santos". */
	rowLabel: (row: Row) => string;
	selection?: Selection;
	/** The id of a row to tint, such as the one a dialog acts on. */
	highlight?: string | null;
	empty: EmptyCopy;
	skeletonRows?: number;
	minWidth?: number;
	className?: string;
}) {
	return (
		<LoadableView
			state={state}
			isEmpty={(rows) => rows.length === 0}
			empty={empty}
			loadingLabel={`Loading ${caption.toLowerCase()}`}
			skeleton={<TableSkeleton rows={skeletonRows} />}
		>
			{(rows) => (
				<div
					role="region"
					aria-label={caption}
					tabIndex={0}
					data-focus-inset=""
					className={cn("relative -mx-1 overflow-x-auto rounded-md px-1", className)}
				>
					<table className="w-full border-separate border-spacing-0" style={{ minWidth }}>
						<caption className={captionHidden ? "sr-only" : "pb-3 text-left font-medium text-ink"}>{caption}</caption>
						<thead>
							<tr>
								{selection ? (
									<th scope="col" className={cn(TH, "w-9")}>
										<SelectAll rows={rows} rowId={rowId} selection={selection} caption={caption} />
									</th>
								) : null}
								{columns.map((c) => (
									<th
										key={c.key}
										scope="col"
										style={{ width: c.width }}
										className={cn(TH, c.align === "right" && "text-right")}
									>
										{c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => {
								const id = rowId(row);
								const checked = selection?.selected.has(id) ?? false;
								return (
									<tr
										key={id}
										data-highlight={id === highlight || checked ? "true" : undefined}
										aria-selected={selection ? checked : undefined}
										className="group/row data-[highlight=true]:*:bg-amber-50"
									>
										{selection ? (
											<td className={cn(TD, "w-9")}>
												<Checkbox
													aria-label={rowLabel(row)}
													checked={checked}
													onCheckedChange={(on) => {
														const next = new Set(selection.selected);
														if (on === true) next.add(id);
														else next.delete(id);
														selection.onChange(next);
													}}
												/>
											</td>
										) : null}
										{columns.map((c) => (
											<td
												key={c.key}
												className={cn(TD, c.align === "right" && "text-right", c.numeric && "text-base tabular-nums")}
											>
												{c.cell(row)}
											</td>
										))}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</LoadableView>
	);
}

const TH = "border-b border-line px-3.5 pb-3 text-left text-sm font-normal whitespace-nowrap text-text-3";
const TD =
	"border-b border-line p-3.5 align-middle text-ink group-last/row:border-b-0 first:rounded-l-md last:rounded-r-md";

function SelectAll<Row>({
	rows,
	rowId,
	selection,
	caption,
}: {
	rows: Row[];
	rowId: (row: Row) => string;
	selection: Selection;
	caption: string;
}) {
	const ids = rows.map(rowId);
	const count = ids.filter((id) => selection.selected.has(id)).length;
	const state = count === 0 ? false : count === ids.length ? true : "indeterminate";
	return (
		<Checkbox
			aria-label={`Select all ${caption.toLowerCase()} on this page`}
			checked={state}
			onCheckedChange={() => {
				const next = new Set(selection.selected);
				for (const id of ids) {
					if (state === true) next.delete(id);
					else next.add(id);
				}
				selection.onChange(next);
			}}
		/>
	);
}

/** Table-shaped placeholder rows: an avatar, two lines and a short value per row. */
export function TableSkeleton({ rows = 3 }: { rows?: number }) {
	return (
		<div className="flex flex-col">
			<Skeleton width="40%" height={12} className="mb-4" />
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="flex items-center gap-3 border-t border-line py-3.5">
					<Skeleton shape="circle" width={32} height={32} />
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton width={i % 2 ? "38%" : "52%"} />
						<Skeleton width="24%" height={12} />
					</div>
					<Skeleton width={64} />
				</div>
			))}
		</div>
	);
}

/**
 * The page numbers to show: always the first and last, the current one and its neighbours, with a gap marker where
 * pages are left out. pageItems(1, 9) is [1, 2, 3, "gap", 9]; pageItems(5, 9) is [1, "gap", 4, 5, 6, "gap", 9].
 */
function pageItems(current: number, total: number): (number | "gap")[] {
	if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
	const near = new Set([1, total, current - 1, current, current + 1]);
	if (current <= 3) [2, 3].forEach((p) => near.add(p));
	if (current >= total - 2) [total - 2, total - 1].forEach((p) => near.add(p));
	const pages = [...near].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
	const out: (number | "gap")[] = [];
	pages.forEach((p, i) => {
		if (i > 0 && p - pages[i - 1]! > 1) out.push("gap");
		out.push(p);
	});
	return out;
}

/**
 * Pagination (components.md): Prev, Page and Next. A navigation landmark with the current page marked; Prev and Next
 * are disabled at the ends. The summary ("Showing 3 of 214 people") goes beside it, outside this component.
 */
export function Pagination({
	page,
	pageCount,
	onPageChange,
	label = "Pages",
	className,
}: {
	page: number;
	pageCount: number;
	onPageChange: (page: number) => void;
	label?: string;
	className?: string;
}) {
	if (pageCount <= 1) return null;
	const base =
		"grid size-10 place-items-center rounded-md font-medium text-ink-2 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";
	return (
		<nav aria-label={label} className={cn("flex items-center gap-1.5", className)}>
			<button
				type="button"
				aria-label="Previous page"
				disabled={page <= 1}
				onClick={() => onPageChange(page - 1)}
				className={cn(base, "shadow-[0_0_0_1px_var(--ef-line-2)]")}
			>
				<Icon icon={ArrowLeft01Icon} size={16} />
			</button>
			{pageItems(page, pageCount).map((p, i) =>
				p === "gap" ? (
					<span key={`gap${i}`} aria-hidden="true" className="w-6 text-center text-text-3 max-app-sm:hidden">
						…
					</span>
				) : (
					<button
						key={p}
						type="button"
						aria-label={`Page ${p}`}
						aria-current={p === page ? "page" : undefined}
						onClick={() => onPageChange(p)}
						className={cn(
							base,
							"tabular-nums max-app-sm:[&:not([aria-current])]:hidden",
							p === page && "bg-ink text-on-ink hover:bg-ink",
						)}
					>
						{p}
					</button>
				),
			)}
			<button
				type="button"
				aria-label="Next page"
				disabled={page >= pageCount}
				onClick={() => onPageChange(page + 1)}
				className={cn(base, "shadow-[0_0_0_1px_var(--ef-line-2)]")}
			>
				<Icon icon={ArrowRight01Icon} size={16} />
			</button>
		</nav>
	);
}
