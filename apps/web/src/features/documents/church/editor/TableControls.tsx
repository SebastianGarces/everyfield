"use client";

import { attrIssue, type DocBrand, type TableNode, type Token } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Group, keepSelection, Labeled, Segmented, Swatches, Tip } from "./ControlParts.tsx";
import { applyTable, newTyping, setAttrs, tableContext, typeInto, type TableContext } from "./table-actions.ts";
import { fieldKey } from "./table-extension.ts";
import {
	addCategory,
	addColumn,
	addLineItem,
	addRow,
	availability,
	categoryAt,
	KINDS,
	labelColumn,
	LAST_ROW,
	removeCategory,
	removeColumn,
	removeRow,
	setHeaderFill,
	setKind,
	setSign,
	setWriteInRows,
	setZebra,
	signAt,
	type Kind,
	type Place,
	type Reason,
} from "./table-ops.ts";
import { Button } from "./tiptap/primitives/button.tsx";

// The settings of the table the cursor is in: rows, columns, the kind of a column, blank write-in rows, the header color
// and striped rows, and for a budget its line items, categories and signs. Every control has a name and a tooltip. A
// control that cannot work is disabled and says why, in its tooltip and in the line under the controls.

/** A button that does one action to the table, or says why it cannot. */
function Act({
	label,
	reason,
	run,
	children,
}: {
	label: string;
	reason: Reason;
	run: () => void;
	children?: ReactNode;
}) {
	return (
		<Button
			type="button"
			data-style="ghost"
			aria-label={label}
			tooltip={reason ? `${label}. ${reason}` : label}
			disabled={reason !== null}
			className="h-8 px-2.5 shadow-[0_0_0_1px_var(--ef-line)]"
			onMouseDown={keepSelection}
			onClick={run}
		>
			{children ?? label}
		</Button>
	);
}

function useTableContext(editor: Editor) {
	return useEditorState({
		editor,
		selector: ({ editor: e }) => tableContext(e.state),
		equalityFn: (a, b) =>
			a === b ||
			(!!a &&
				!!b &&
				a.pos === b.pos &&
				a.node === b.node &&
				a.at.row === b.at.row &&
				a.at.col === b.at.col &&
				a.at.blank === b.at.blank),
	});
}

function run(editor: Editor, make: (context: TableContext) => { table: TableNode; place: Place } | null) {
	const context = tableContext(editor.state);
	const done = context && make(context);
	if (done) applyTable(editor, context, done.table, done.place);
}

/** The write-in row count: 0 to 200. A count outside it shows the format's message and is not applied. */
function WriteInField({ editor, context }: { editor: Editor; context: TableContext }) {
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);
	const typing = useRef(newTyping());
	const current = context.table.attrs.writeInRows ?? 0;
	const lastRow = !context.table.attrs.header && !context.table.content?.length && !context.table.attrs.source;
	const issue = (text: string) =>
		text.trim() === ""
			? "Type a number from 0 to 200."
			: (attrIssue("table", "writeInRows", Number(text)) ?? (lastRow && Number(text) === 0 ? LAST_ROW : null));
	// Undo or Redo can change the count under a typed draft: the field shows the stored count then.
	const shown = draft !== null && (issue(draft) || Number(draft) === current) ? draft : String(current);
	const problem = issue(shown);
	return (
		<span className="flex flex-wrap items-center gap-2">
			<label htmlFor={id} className="cursor-pointer text-sm text-text-2">
				Blank rows
			</label>
			<Tip text="How many blank rows to write in by hand, 0 to 200">
				<input
					id={id}
					type="number"
					inputMode="numeric"
					min={0}
					max={200}
					step={1}
					value={shown}
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? `${id}-problem` : undefined}
					className="h-9 w-20 rounded-sm bg-surface px-2 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] aria-[invalid=true]:shadow-[0_0_0_1px_var(--ef-magenta-500)]"
					onChange={(event) => {
						const text = event.target.value;
						setDraft(text);
						if (issue(text)) return;
						const count = Number(text);
						const live = tableContext(editor.state);
						if (!live || live.pos !== context.pos) return;
						typeInto(editor.view, typing.current, (tr) => setAttrs(tr, live.pos, { ...live.node.attrs, writeInRows: count }));
					}}
					onKeyDown={(event) => fieldKey(editor, event.nativeEvent)}
					onBlur={() => {
						typing.current = newTyping();
						setDraft(null);
					}}
				/>
			</Tip>
			{problem ? (
				<span id={`${id}-problem`} role="alert" className="text-xs font-medium text-magenta-600">
					{problem}
				</span>
			) : null}
		</span>
	);
}

export function TableControls({ editor, palette }: { editor: Editor; palette: DocBrand["palette"] }) {
	const context = useTableContext(editor);
	const zebraId = useId();
	if (!context) return null;
	const { table, at } = context;
	const ledger = table.attrs.style === "ledger";
	const can = availability(table, at);
	const column = at.col === null ? null : (table.attrs.columns[at.col] ?? null);
	const textAt = labelColumn(table);
	const sign = signAt(table, at.row);

	// Reasons a control is off because of the table itself, shown under the controls. Where the cursor is stays in tooltips.
	const reasons = (
		[
			["Add row", can.addRow],
			["Remove row", can.removeRow],
			["Add column", can.addColumnRight],
			["Remove column", can.removeColumn],
			["Column kind", can.kind],
			["Remove category", can.removeCategory],
		] as const
	).filter(([, reason]) => reason !== null && !reason.startsWith("Put the cursor"));
	const seen = new Set<string>();
	const unique = reasons.filter(([, reason]) => !seen.has(reason as string) && seen.add(reason as string));

	const rowAfter = (side: -1 | 1) =>
		run(editor, ({ table: t, at: place }) => {
			const index =
				place.row === null ? (side < 0 ? 0 : (t.content ?? []).length) : side < 0 ? place.row : place.row + 1;
			return {
				table: addRow(t, place.row, side),
				place: { row: index, col: place.col ?? 0 },
			};
		});

	return (
		<>
			<Group label="Table">
				{!ledger ? (
					<>
						<Act label="Add row above" reason={can.addRow} run={() => rowAfter(-1)} />
						<Act label="Add row below" reason={can.addRow} run={() => rowAfter(1)} />
						<Act
							label="Remove row"
							reason={can.removeRow}
							run={() =>
								run(editor, ({ table: t, at: place }) => {
									if (place.row !== null) {
										const next = removeRow(t, place.row);
										const left = (next.content ?? []).length;
										const blanks = next.attrs.writeInRows ?? 0;
										return {
											table: next,
											place: left
												? { row: Math.min(place.row, left - 1), col: place.col }
												: { row: null, col: place.col, blank: !next.attrs.header && blanks > 0 },
										};
									}
									const count = Math.max(0, (t.attrs.writeInRows ?? 0) - 1);
									const typed = (t.content ?? []).length;
									// With the last blank row gone, the person goes to the last typed row, or else the header.
									const after: Place = count
										? place
										: typed
											? { row: typed - 1, col: place.col ?? 0 }
											: { row: null, col: place.col ?? 0 };
									return { table: setWriteInRows(t, count), place: after };
								})
							}
						/>
					</>
				) : null}
				<Act
					label="Add column left"
					reason={can.addColumnLeft}
					run={() =>
						run(editor, ({ table: t, at: place }) => {
							const index = place.col ?? 0;
							return { table: addColumn(t, index), place: { ...place, col: index } };
						})
					}
				/>
				<Act
					label="Add column right"
					reason={can.addColumnRight}
					run={() =>
						run(editor, ({ table: t, at: place }) => {
							const index = place.col === null ? t.attrs.columns.length : place.col + 1;
							return { table: addColumn(t, index), place: { ...place, col: index } };
						})
					}
				/>
				<Act
					label="Remove column"
					reason={can.removeColumn}
					run={() =>
						run(editor, ({ table: t, at: place }) => {
							if (place.col === null) return null;
							return {
								table: removeColumn(t, place.col),
								place: { ...place, col: Math.min(place.col, t.attrs.columns.length - 2) },
							};
						})
					}
				/>
				<Labeled label="Column kind">
					<Tip text={can.kind ?? "What this column holds"}>
						<select
							aria-label="Column kind"
							value={column?.type ?? ""}
							disabled={can.kind !== null}
							className="h-9 cursor-pointer rounded-sm bg-surface px-2 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] disabled:cursor-not-allowed disabled:opacity-45"
							onMouseDown={(event) => event.stopPropagation()}
							onChange={(event) => {
								const kind = event.target.value as Kind;
								run(editor, ({ table: t, at: place }) =>
									place.col === null ? null : { table: setKind(t, place.col, kind), place },
								);
							}}
						>
							{column === null || column.type === "formula" ? (
								<option value={column ? "formula" : ""} disabled>
									{column ? "Formula" : "Pick a column"}
								</option>
							) : null}
							{KINDS.map((k) => (
								<option key={k.kind} value={k.kind}>
									{k.label}
								</option>
							))}
						</select>
					</Tip>
				</Labeled>
			</Group>
			{ledger ? (
				<Group label="Budget">
					<Act
						label="Add line item"
						reason={can.addItem}
						run={() =>
							run(editor, ({ table: t, at: place }) => {
								if (place.row === null) return null;
								const next = addLineItem(t, place.row);
								const row = (t.content ?? [])[place.row];
								const index = row?.attrs?.role === "subtotal" ? place.row : place.row + 1;
								return { table: next, place: { row: index, col: textAt } };
							})
						}
					/>
					<Act
						label="Remove line item"
						reason={can.removeItem}
						run={() =>
							run(editor, ({ table: t, at: place }) => {
								if (place.row === null) return null;
								const next = removeRow(t, place.row);
								const category = categoryAt(next, Math.max(0, place.row - 1));
								return {
									table: next,
									place: { row: category ? Math.min(place.row, category.end) : null, col: textAt },
								};
							})
						}
					/>
					<Act
						label="Add category"
						reason={can.addCategory}
						run={() =>
							run(editor, ({ table: t, at: place }) => {
								const next = addCategory(t, place.row);
								const added = (next.content ?? []).findIndex((row, i) => row !== (t.content ?? [])[i]);
								return { table: next, place: { row: Math.max(0, added), col: textAt } };
							})
						}
					/>
					<Act
						label="Remove category"
						reason={can.removeCategory}
						run={() =>
							run(editor, ({ table: t, at: place }) => {
								if (place.row === null) return null;
								const category = categoryAt(t, place.row);
								const next = removeCategory(t, place.row);
								const row = Math.max(0, Math.min(category?.start ?? 0, (next.content ?? []).length - 1));
								return { table: next, place: { row, col: textAt } };
							})
						}
					/>
					{sign ? (
						<Segmented
							label="Category sign"
							value={sign}
							options={[
								{ value: "add", label: "Adds", tooltip: "This category adds to the total" },
								{ value: "subtract", label: "Subtracts", tooltip: "This category subtracts from the total" },
							]}
							onChange={(next) =>
								run(editor, ({ table: t, at: place }) =>
									place.row === null ? null : { table: setSign(t, place.row, next), place },
								)
							}
						/>
					) : null}
				</Group>
			) : null}
			<Group label="Look">
				{!ledger ? <WriteInField editor={editor} context={context} /> : null}
				<Labeled label="Header color">
					<Swatches
						label="Header color"
						value={(table.attrs.headerFill as Token | undefined) ?? "muted"}
						palette={palette}
						onChange={(fill) => run(editor, ({ table: t, at: place }) => ({ table: setHeaderFill(t, fill), place }))}
					/>
				</Labeled>
				<Tip text="Shade every second row">
					<label htmlFor={zebraId} className="flex cursor-pointer items-center gap-2 text-sm text-text-2">
						<input
							id={zebraId}
							type="checkbox"
							className="size-4 cursor-pointer accent-[var(--ef-ink)]"
							checked={table.attrs.zebra === true}
							onMouseDown={keepSelection}
							onChange={(event) =>
								run(editor, ({ table: t, at: place }) => ({ table: setZebra(t, event.target.checked), place }))
							}
						/>
						Striped rows
					</label>
				</Tip>
			</Group>
			{unique.length ? (
				<p role="status" data-table-reasons="" className="basis-full px-1 text-xs text-text-2">
					{unique.map(([name, reason]) => `${name}: ${reason}`).join(" ")}
				</p>
			) : null}
		</>
	);
}
