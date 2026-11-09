"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { FieldDecl } from "@everyfield/contracts/documents";
import { Icon } from "@everyfield/ui/foundations";
import { useEditorState, type Editor } from "@tiptap/react";
import { useId, useState } from "react";
import { removeCondition } from "./blocks.ts";
import { nextCondition, parseConditionValue, TEST_LABEL, testsFor, type Condition } from "./condition.ts";
import { conditionOf } from "./condition-extension.ts";
import { Group, keepSelection, Labeled, Tip } from "./ControlParts.tsx";
import { setBlockAttrs, type Target } from "./layout.ts";
import { Button } from "./tiptap/primitives/button.tsx";
import { BUTTON_ICON } from "./tiptap/styles.ts";

// The condition of the conditional text the cursor is in: the field it reads, the test, and for "is more than" the
// number. The fields are the document's own; each field offers only the tests its type takes. Each change is one step
// that Undo reverses, and the block's label on the page follows it at once.

const SELECT =
	"h-9 max-w-full min-w-0 cursor-pointer rounded-sm bg-surface px-2 text-md text-ink shadow-[0_0_0_1px_var(--ef-line-2)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] disabled:cursor-not-allowed disabled:opacity-45";

/** The format's attributes for a condition: no `value` unless the test is "is more than". */
const attrsFor = (c: Condition) => ({ field: c.field, test: c.test, value: c.value });

/** The number "is more than" compares with. A value that is not a whole number from 0 shows why and is not applied. */
function ValueField({ editor, target, condition }: { editor: Editor; target: Target; condition: Condition }) {
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);
	const current = String(condition.value ?? 0);
	const parsed = draft === null ? null : parseConditionValue(draft);
	// Undo or Redo can change the value under a draft: the field shows the stored value then.
	const shown = draft !== null && parsed && ("problem" in parsed || String(parsed.value) === current) ? draft : current;
	const problem = draft !== null && shown === draft && parsed && "problem" in parsed ? parsed.problem : null;
	return (
		<span className="flex flex-wrap items-center gap-2">
			<label htmlFor={id} className="cursor-pointer text-sm text-text-2">
				Number
			</label>
			<Tip text="Prints when the field is more than this whole number">
				<input
					id={id}
					type="text"
					inputMode="numeric"
					value={shown}
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? `${id}-problem` : undefined}
					className="h-9 w-20 rounded-sm bg-surface px-2 text-md text-ink tabular-nums shadow-[0_0_0_1px_var(--ef-line-2)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] aria-[invalid=true]:shadow-[0_0_0_1px_var(--ef-magenta-500)]"
					onMouseDown={(event) => event.stopPropagation()}
					onChange={(event) => {
						const text = event.target.value;
						setDraft(text);
						const next = parseConditionValue(text);
						if ("value" in next) setBlockAttrs(editor, target.pos, { value: next.value });
					}}
					onBlur={() => setDraft(null)}
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

export function ConditionControls({ editor, target }: { editor: Editor; target: Target }) {
	// The document's fields as the root node holds them now, so a merge field inserted a moment ago is offered at once.
	const fields =
		useEditorState({
			editor,
			selector: ({ editor: e }) => (e.state.doc.attrs.fields as FieldDecl[] | undefined) ?? [],
		}) ?? [];
	const condition = conditionOf(target.node);
	const field = fields.find((f) => f.key === condition.field);
	const tests = testsFor(field);
	const apply = (patch: Partial<Condition>) =>
		setBlockAttrs(editor, target.pos, attrsFor(nextCondition(fields, condition, patch)));
	return (
		<Group label="Conditional text">
			<Labeled label="Field">
				<Tip text="The field this condition reads">
					<select
						aria-label="Condition field"
						value={field ? condition.field : ""}
						className={SELECT}
						onMouseDown={(event) => event.stopPropagation()}
						onChange={(event) => apply({ field: event.target.value })}
					>
						{field ? null : (
							<option value="" disabled>
								Pick a field
							</option>
						)}
						{fields.map((f) => (
							<option key={f.key} value={f.key}>
								{f.label}
							</option>
						))}
					</select>
				</Tip>
			</Labeled>
			<Labeled label="Prints when it">
				<Tip text="What the field must be for this text to print">
					<select
						aria-label="Condition test"
						value={condition.test}
						disabled={tests.length === 0}
						className={SELECT}
						onMouseDown={(event) => event.stopPropagation()}
						onChange={(event) => apply({ test: event.target.value as Condition["test"] })}
					>
						{tests.map((t) => (
							<option key={t} value={t}>
								{TEST_LABEL[t]}
							</option>
						))}
					</select>
				</Tip>
			</Labeled>
			{condition.test === "more-than" ? (
				<ValueField key={target.pos} editor={editor} target={target} condition={condition} />
			) : null}
			<Button
				type="button"
				data-style="ghost"
				aria-label="Remove condition"
				tooltip="Remove the condition and keep the text as plain blocks"
				onMouseDown={keepSelection}
				onClick={() => removeCondition(editor, target.pos)}
			>
				<Icon icon={Cancel01Icon} size={18} className={BUTTON_ICON} />
				<span>Remove condition</span>
			</Button>
		</Group>
	);
}
