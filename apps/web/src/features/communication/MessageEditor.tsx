"use client";

import { Field, Input, Textarea } from "@everyfield/ui/controls";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fieldToken, fieldsFor, type MergeField } from "./fields.ts";

// Subject and message for Write and for the template editor. The message is plain text. The rail lists the fields that
// work in it; a click inserts one at the cursor, and typing `{{` opens the same list under the cursor.

type Open = { from: number; query: string; top: number; left: number };

const LINE = 22;

/** Where the `{{name` being typed ends at the caret, and roughly where to draw the list. */
function openAt(el: HTMLTextAreaElement): Open | null {
	const caret = el.selectionStart;
	const before = el.value.slice(0, caret);
	const match = /\{\{([a-z0-9_]*)$/i.exec(before);
	if (!match) return null;
	const lines = before.split("\n");
	const top = Math.min(el.clientHeight, 12 + lines.length * LINE) - el.scrollTop;
	const left = Math.min(Math.max(0, el.clientWidth - 220), 12 + (lines.at(-1)?.length ?? 0) * 7.2);
	return { from: caret - match[0].length, query: match[1]!.toLowerCase(), top, left };
}

export function MessageEditor({
	subject,
	onSubject,
	text,
	onText,
	subjectError,
	bodyError,
	hasMeeting,
	disabled = false,
	lossy = false,
	children,
}: {
	subject: string;
	onSubject: (value: string) => void;
	text: string;
	onText: (value: string) => void;
	subjectError?: string;
	bodyError?: string;
	hasMeeting: boolean;
	disabled?: boolean;
	/** True when the opened body had markup the editor reduced to text. */
	lossy?: boolean;
	/** The template picker, above the subject. */
	children?: ReactNode;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const listId = useId();
	const [open, setOpen] = useState<Open | null>(null);
	const [active, setActive] = useState(0);
	const fields = fieldsFor(hasMeeting);
	const shown = open ? fields.filter((field) => field.key.startsWith(open.query)) : [];

	const insert = (field: MergeField, from?: number) => {
		const el = area.current;
		if (!el) return;
		const start = from ?? el.selectionStart;
		const end = el.selectionEnd;
		const token = fieldToken(field.key);
		onText(el.value.slice(0, start) + token + el.value.slice(end));
		setOpen(null);
		const caret = start + token.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(caret, caret);
		});
	};

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (!open || shown.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((current) => (current + step + shown.length) % shown.length);
		} else if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			// Replace the typed `{{na` with the whole field.
			const el = area.current!;
			const end = el.selectionStart;
			const field = shown[active] ?? shown[0]!;
			onText(el.value.slice(0, open.from) + fieldToken(field.key) + el.value.slice(end));
			setOpen(null);
			const caret = open.from + fieldToken(field.key).length;
			requestAnimationFrame(() => el.setSelectionRange(caret, caret));
		} else if (event.key === "Escape") {
			event.preventDefault();
			setOpen(null);
		}
	};

	return (
		<div className="flex min-w-0 flex-col gap-5">
			{children}
			<Field label="Subject" error={subjectError} hint="The subject is the same for everyone.">
				<Input
					value={subject}
					disabled={disabled}
					placeholder="Vision meeting this Thursday"
					onChange={(event) => onSubject(event.target.value)}
				/>
			</Field>
			<Field label="Message" error={bodyError}>
				<div className="relative">
					<Textarea
						ref={area}
						value={text}
						disabled={disabled}
						rows={11}
						placeholder={"Hello {{name}},\n\nWe would love to see you."}
						role="combobox"
						aria-expanded={open !== null && shown.length > 0}
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={open && shown.length > 0 ? `${listId}-${active}` : undefined}
						onKeyDown={onKey}
						onBlur={() => setOpen(null)}
						onChange={(event) => {
							onText(event.target.value);
							setOpen(openAt(event.target));
							setActive(0);
						}}
						onClick={(event) => setOpen(openAt(event.currentTarget))}
					/>
					{open && shown.length > 0 ? (
						<ul
							id={listId}
							role="listbox"
							aria-label="Fields"
							style={{ top: open.top, left: open.left }}
							className="absolute z-10 w-[220px] rounded-md bg-surface-raised p-1 shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)]"
						>
							{shown.map((field, index) => (
								<li
									key={field.key}
									id={`${listId}-${index}`}
									role="option"
									aria-selected={index === active}
									onMouseDown={(event) => {
										event.preventDefault();
										insert(field, open.from);
									}}
									className="flex cursor-pointer flex-col rounded-sm px-2.5 py-1.5 text-md text-ink aria-selected:bg-surface-2"
								>
									<span>{field.label}</span>
									<span className="text-xs text-text-3">{fieldToken(field.key)}</span>
								</li>
							))}
						</ul>
					) : null}
				</div>
			</Field>
			<p className="text-xs text-text-3">
				A blank line starts a new paragraph. Write **bold**, *italic* or [a link](https://example.org). Start a line
				with - for a list.
			</p>
			{lossy ? (
				<p role="status" className="text-xs text-text-2">
					This message had underline or span styling. The editor kept only the text.
				</p>
			) : null}
			<section aria-label="Fields you can use" className="flex flex-col gap-2 rounded-md bg-surface p-3">
				<h3 className="text-sm font-medium text-ink-2">Fields you can use</h3>
				<ul className="flex flex-col gap-1">
					{fields.map((field) => (
						<li key={field.key}>
							<button
								type="button"
								disabled={disabled}
								onClick={() => insert(field)}
								className="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-md text-ink hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ef-focus)] disabled:cursor-not-allowed disabled:opacity-50"
							>
								<span className="font-medium">{field.label}</span>
								<span className="truncate text-sm text-text-3">{field.example}</span>
							</button>
						</li>
					))}
				</ul>
				<p className="text-xs text-text-3">
					{hasMeeting ? "" : "The RSVP button appears when the message is for a meeting. "}The subject takes no fields.
				</p>
			</section>
		</div>
	);
}
