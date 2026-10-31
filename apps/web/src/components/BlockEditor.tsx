"use client";

import { Button, Field, Select, Textarea } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

// The block editor the Wiki and Church Documents share: heading, subheading, paragraph, quote, bulleted list and
// numbered list, with add, move, remove and change kind. A row that carries a `slot` is a doctrinal slot: it keeps its
// place and its label, takes text, and has no remove or change-kind control. The owner of the rows keeps them in state.

export type BlockKind = "paragraph" | "heading" | "subheading" | "quote" | "list" | "numbered";
export type SlotInfo = { label: string };
export type BlockRow = { key: string; kind: BlockKind; text: string; slot?: SlotInfo };
export type BlockEditorHandle = { focus: (key: string) => void };

const KINDS: { value: BlockKind; label: string }[] = [
	{ value: "paragraph", label: "Paragraph" },
	{ value: "heading", label: "Heading" },
	{ value: "subheading", label: "Subheading" },
	{ value: "quote", label: "Quote" },
	{ value: "list", label: "List" },
	{ value: "numbered", label: "Numbered list" },
];

function textLabel(kind: BlockKind): string {
	if (kind === "heading") return "Heading";
	if (kind === "subheading") return "Subheading";
	if (kind === "quote") return "Quote";
	if (kind === "list" || kind === "numbered") return "List items";
	return "Paragraph";
}

type Props = {
	rows: BlockRow[];
	onChange: (rows: BlockRow[]) => void;
	disabled?: boolean;
	/** One field error: the row it belongs to and its message. */
	error?: { key: string; message: string } | null;
	ref?: Ref<BlockEditorHandle>;
};

export function BlockEditor({ rows, onChange, disabled = false, error = null, ref }: Props) {
	const keyCount = useRef(rows.length + 1);
	const fields = useRef(new Map<string, HTMLTextAreaElement>());
	const pendingFocus = useRef<string | null>(null);

	useImperativeHandle(ref, () => ({ focus: (key) => fields.current.get(key)?.focus() }), []);

	useEffect(() => {
		const key = pendingFocus.current;
		if (!key) return;
		pendingFocus.current = null;
		fields.current.get(key)?.focus();
	});

	function update(key: string, patch: Partial<BlockRow>) {
		onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
	}

	function move(index: number, direction: -1 | 1) {
		const row = rows[index];
		const other = rows[index + direction];
		if (!row || !other) return;
		const next = rows.slice();
		next[index] = other;
		next[index + direction] = row;
		onChange(next);
		pendingFocus.current = row.key;
	}

	function remove(key: string) {
		if (rows.length < 2) return;
		const index = rows.findIndex((row) => row.key === key);
		onChange(rows.filter((row) => row.key !== key));
		pendingFocus.current = rows[Math.max(0, index - 1)]?.key ?? null;
	}

	function addParagraph() {
		const key = `new-${keyCount.current}`;
		keyCount.current += 1;
		onChange([...rows, { key, kind: "paragraph", text: "" }]);
		pendingFocus.current = key;
	}

	return (
		<>
			<ol className="flex flex-col gap-8">
				{rows.map((row, index) => (
					<li key={row.key}>
						<fieldset
							className={
								row.slot
									? "flex flex-col gap-4 rounded-md border border-dashed border-line bg-surface-raised p-4"
									: "flex flex-col gap-4"
							}
							disabled={disabled}
						>
							<legend className="text-sm font-medium text-ink">
								{row.slot ? (
									<span className="flex flex-wrap items-center gap-2">
										{row.slot.label}
										<Tag tone="amber">Doctrinal slot</Tag>
									</span>
								) : (
									`Block ${index + 1}`
								)}
							</legend>
							{row.slot ? null : (
								<Field label={`Block ${index + 1} type`}>
									<Select
										options={KINDS}
										value={row.kind}
										onValueChange={(value) => update(row.key, { kind: value as BlockKind })}
									/>
								</Field>
							)}
							<Field
								label={row.slot ? `${row.slot.label} text` : textLabel(row.kind)}
								hint={
									row.slot
										? "Blank until you type. Nothing fills it for you."
										: row.kind === "list" || row.kind === "numbered"
											? "Put one item on each line."
											: undefined
								}
								error={error?.key === row.key ? error.message : undefined}
							>
								<Textarea
									ref={(node) => {
										if (node) fields.current.set(row.key, node);
										else fields.current.delete(row.key);
									}}
									value={row.text}
									rows={row.kind === "paragraph" || row.kind === "list" || row.kind === "numbered" || row.slot ? 5 : 2}
									onChange={(event) => update(row.key, { text: event.target.value })}
								/>
							</Field>
							<div className="flex flex-wrap gap-2">
								<Button type="button" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
									Move up
								</Button>
								<Button
									type="button"
									variant="ghost"
									disabled={index === rows.length - 1}
									onClick={() => move(index, 1)}
								>
									Move down
								</Button>
								{row.slot ? null : (
									<Button type="button" variant="ghost" disabled={rows.length < 2} onClick={() => remove(row.key)}>
										Remove
									</Button>
								)}
							</div>
						</fieldset>
					</li>
				))}
			</ol>
			<div>
				<Button type="button" variant="outline" disabled={disabled} onClick={addParagraph}>
					Add a paragraph
				</Button>
			</div>
		</>
	);
}
