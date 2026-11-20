"use client";

import { Command, Field, Input, keepKeyInField, Textarea } from "@everyfield/ui/controls";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fieldToken, fieldsFor, type MergeField } from "./fields.ts";

type Open = { from: number; query: string; top: number; left: number };

const LINE = 22;

function openAt(el: HTMLTextAreaElement): Open | null {
	const caret = el.selectionStart;
	const before = el.value.slice(0, caret);
	const match = /\{\{([a-z0-9_]*)$/i.exec(before);
	if (!match) return null;
	const lines = before.split("\n");
	const top = Math.min(el.clientHeight, 12 + lines.length * LINE) - el.scrollTop;
	const left = Math.min(Math.max(0, el.clientWidth - 220), 12 + (lines.at(-1)?.length ?? 0) * 7.2);
	return { from: caret - match[0].length, query: match[0].slice(2).toLowerCase(), top, left };
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
	lossy?: boolean;
	children?: ReactNode;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState<Open | null>(null);
	const fields = fieldsFor(hasMeeting);
	const shown = open ? fields.filter((field) => field.key.startsWith(open.query)) : [];
	const firstShown = shown[0];
	const listed = open !== null && firstShown !== undefined;
	const reopen = (el: HTMLTextAreaElement) => setOpen(openAt(el));

	const insert = (field: MergeField, from?: number) => {
		const el = area.current;
		if (!el) return;
		const start = from ?? el.selectionStart;
		const end = el.selectionEnd;
		el.focus();
		el.setRangeText(fieldToken(field.key), start, end, "end");
		onText(el.value);
		setOpen(null);
	};

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (!listed) return keepKeyInField(event);
		if (event.key === "Tab") {
			event.preventDefault();
			const active = list.current?.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute("data-value");
			insert(shown.find((field) => field.key === active) ?? firstShown, open.from);
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
				<Command shouldFilter={false} vimBindings={false} label="Fields" className="relative">
					<Command.Input asChild value={shown.map((field) => field.key).join(" ")}>
						<Textarea
							ref={area}
							id={undefined}
							cmdk-input={undefined}
							value={text}
							disabled={disabled}
							rows={11}
							placeholder={"Hello {{name}},\n\nWe would love to see you."}
							aria-expanded={listed}
							autoComplete={undefined}
							autoCorrect={undefined}
							spellCheck={undefined}
							onKeyDown={onKey}
							onBlur={() => setOpen(null)}
							onChange={(event) => {
								onText(event.target.value);
								reopen(event.target);
							}}
							onClick={(event) => reopen(event.currentTarget)}
						/>
					</Command.Input>
					<Command.List
						ref={list}
						label="Fields"
						hidden={!listed}
						style={open ? { top: open.top, left: open.left } : undefined}
						className="absolute z-10 w-[220px] rounded-md bg-surface-raised p-1 shadow-[var(--ef-shadow-pop),0_0_0_1px_var(--ef-line)]"
					>
						{listed
							? shown.map((field) => (
									<Command.Item
										key={field.key}
										value={field.key}
										onMouseDown={(event) => event.preventDefault()}
										onSelect={() => insert(field, open.from)}
										className="flex flex-col rounded-sm px-2.5 py-1.5 text-md text-ink aria-selected:bg-surface-2"
									>
										<span>{field.label}</span>
										<span className="text-xs text-text-3">{fieldToken(field.key)}</span>
									</Command.Item>
								))
							: null}
					</Command.List>
				</Command>
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
								className="flex w-full items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-md text-ink hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ef-focus)] disabled:opacity-50"
							>
								<span className="font-medium">{field.label}</span>
								<span className="truncate text-sm text-text-3">{field.example}</span>
							</button>
						</li>
					))}
				</ul>
				<p className="text-xs text-text-3">
					{hasMeeting ? "" : "The RSVP button appears when the message is for a meeting. "}The subject is the same for
					everyone.
				</p>
			</section>
		</div>
	);
}
