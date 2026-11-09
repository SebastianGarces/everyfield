"use client";

import {
	Add01Icon,
	ArrowDown01Icon,
	File02Icon,
	ArrowUp01Icon,
	Delete02Icon,
	ParagraphSpacingIcon,
	Scissor01Icon,
	SeparatorHorizontalIcon,
	Tag01Icon,
	TextNumberSignIcon,
	UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import type { DocBrand } from "@everyfield/contracts/documents";
import type { Editor } from "@tiptap/react";
import { Fragment, useEffect, useReducer } from "react";
import { useEditorState } from "@tiptap/react";
import {
	canInsert,
	canInsertField,
	canMove,
	hasSlot,
	insertField,
	canNumber,
	canSetTextStyle,
	currentBlock,
	deleteBlock,
	IMAGE_KINDS,
	INSERT_KINDS,
	insertBlock,
	insertPageNumber,
	regionAt,
	type ImageKind,
	isNumbered,
	moveBlock,
	setTextStyle,
	TEXT_STYLES,
	toggleNumbered,
	currentTextStyle,
	type InsertKind,
} from "./blocks.ts";
import { INSERTABLE_FIELDS } from "@everyfield/domain/documents/values";
import { liveValues } from "./extensions.ts";
import { Button } from "./tiptap/primitives/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./tiptap/primitives/dropdown-menu.tsx";
import { Toolbar, ToolbarGroup, ToolbarSeparator } from "./tiptap/primitives/toolbar.tsx";
import { BlockquoteButton } from "./tiptap/ui/blockquote-button.tsx";
import { ListButton } from "./tiptap/ui/list-button.tsx";
import { LinkPopover } from "./tiptap/ui/link-popover.tsx";
import { MarkButton } from "./tiptap/ui/mark-button.tsx";
import { UndoRedoButton } from "./tiptap/ui/undo-redo-button.tsx";
import { BUTTON_ICON, MENU_ITEM } from "./tiptap/styles.ts";

// The main toolbar. The primitives, the mark buttons, the Undo and Redo buttons and the link popover are Tiptap's free
// ready-made parts (see tiptap/README.md); the text-style, list, block and insert controls use the same primitives.
// Every control has a name and a tooltip. A control that cannot apply is disabled, not hidden. A plain document (no
// `church` prop) gets the prose controls only: text style, marks, link, lists, quote, divider, move and delete block.

const glyph = (icon: IconSvgElement) => <Icon icon={icon} size={18} className={BUTTON_ICON} />;

function Action({
	editor,
	label,
	icon,
	run,
	active,
	disabled,
	shortcutKeys,
	children,
}: {
	editor: Editor;
	label: string;
	icon: IconSvgElement;
	run: () => void;
	active?: boolean;
	disabled?: boolean;
	shortcutKeys?: string;
	children?: React.ReactNode;
}) {
	return (
		<Button
			type="button"
			data-style="ghost"
			data-active-state={active ? "on" : "off"}
			aria-label={label}
			aria-pressed={active === undefined ? undefined : active}
			tooltip={label}
			shortcutKeys={shortcutKeys}
			disabled={disabled}
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => {
				run();
				editor.view.focus();
			}}
		>
			{glyph(icon)}
			{children}
		</Button>
	);
}

const GROUP_LABEL = {
	text: "Text",
	rules: "Rules and spacing",
	layout: "Layout",
	lines: "Lines to fill in",
	images: "Brand kit images",
	sections: "Sections",
} as const;

/** A heading over a group of Insert menu items. */
function MenuLabel({ children }: { children: string }) {
	return (
		<div
			role="presentation"
			className="px-2.5 pt-2 pb-1 text-xs font-semibold tracking-wide text-text-3 uppercase first:pt-1"
		>
			{children}
		</div>
	);
}

const PAGE_NUMBERS = [
	{ format: "page", label: "Page N" },
	{ format: "page-of-total", label: "Page N of M" },
] as const;

/** The text styles a plain document offers: body text and the three heading levels. */
const NATIVE_STYLES = new Set<string>(["body", "h1", "h2", "h3"]);

export function EditorToolbar({
	editor,
	church,
}: {
	editor: Editor;
	/** The template parts of a Church Document; a plain native document has none. */
	church?: {
		brand: DocBrand;
		/** The church's current value of each merge field Insert offers, by key. */
		mergeValues: Record<string, string>;
		pageSetup: { open: boolean; controls: string; toggle: () => void };
	};
}) {
	// The view mounts after the first render and `editor.isEditable` is false until then. Draw again when it mounts, so
	// Bold, Italic, Underline and Link show on load, not after the first click.
	const [, drawAgain] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		editor.on("mount", drawAgain);
		if (editor.isEditable) drawAgain();
		return () => {
			editor.off("mount", drawAgain);
		};
	}, [editor]);
	const s = useEditorState({
		editor,
		selector: ({ editor: e }) => {
			const state = e.state;
			const empty = currentBlock(state) === null;
			// A plain document's schema has no layout, slot or field nodes, so only the divider can be inserted.
			const insertable = (
				church
					? Object.fromEntries(INSERT_KINDS.map((k) => [k.kind, canInsert(state, k.kind)]))
					: { divider: canInsert(state, "divider") }
			) as Record<InsertKind, boolean>;
			return {
				style: currentTextStyle(state),
				numbered: isNumbered(state),
				canNumber: canNumber(state),
				up: canMove(state, -1),
				down: canMove(state, 1),
				hasBlock: !empty,
				tag: church ? e.isActive("tag") : false,
				canTag: church ? e.can().toggleMark("tag") : false,
				styles: Object.fromEntries(TEXT_STYLES.map((t) => [t.style, canSetTextStyle(e, t.style)])),
				region: regionAt(state),
				canField: canInsertField(state),
				hasSlot: hasSlot(state.doc),
				values: liveValues(state.doc),
				insertable,
			};
		},
	});
	const current = TEXT_STYLES.find((t) => t.style === s.style);
	const styles = church ? TEXT_STYLES : TEXT_STYLES.filter((t) => NATIVE_STYLES.has(t.style));
	return (
		<Toolbar aria-label="Document formatting">
			<ToolbarGroup>
				<UndoRedoButton editor={editor} action="undo" />
				<UndoRedoButton editor={editor} action="redo" />
			</ToolbarGroup>
			<ToolbarSeparator />
			<ToolbarGroup>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							data-style="ghost"
							aria-label="Text style"
							tooltip="Text style"
							disabled={s.style === null}
							onMouseDown={(event) => event.preventDefault()}
							className="min-w-[104px] justify-between"
						>
							<span>{current?.label ?? "Text style"}</span>
							<Icon icon={UnfoldMoreIcon} size={16} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent portal align="start" aria-label="Text style">
						{styles.map((t) => (
							<DropdownMenuItem
								key={t.style}
								className={MENU_ITEM}
								disabled={!s.styles[t.style]}
								data-state={s.style === t.style ? "checked" : undefined}
								onSelect={() => {
									setTextStyle(editor, t.style);
								}}
							>
								{t.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				{church ? (
					<Action
						editor={editor}
						label="Numbered heading"
						icon={TextNumberSignIcon}
						active={s.numbered}
						disabled={!s.canNumber}
						run={() => toggleNumbered(editor)}
					/>
				) : null}
			</ToolbarGroup>
			<ToolbarSeparator />
			<ToolbarGroup>
				<MarkButton editor={editor} type="bold" />
				<MarkButton editor={editor} type="italic" />
				<MarkButton editor={editor} type="underline" />
				{church ? (
					<Action
						editor={editor}
						label="Tag"
						icon={Tag01Icon}
						active={s.tag}
						disabled={!s.canTag}
						run={() => editor.chain().setMeta("closeHistory", true).focus().toggleMark("tag").run()}
					/>
				) : null}
				<LinkPopover editor={editor} />
			</ToolbarGroup>
			<ToolbarSeparator />
			<ToolbarGroup>
				<ListButton editor={editor} type="bulletList" />
				<ListButton editor={editor} type="orderedList" />
				<BlockquoteButton editor={editor} />
			</ToolbarGroup>
			<ToolbarSeparator />
			<ToolbarGroup>
				<Action
					editor={editor}
					label="Divider"
					icon={SeparatorHorizontalIcon}
					disabled={!s.insertable.divider}
					run={() => insertBlock(editor, "divider")}
				/>
				{church ? (
					<>
						<Action
							editor={editor}
							label="Spacer"
							icon={ParagraphSpacingIcon}
							disabled={!s.insertable.spacer}
							run={() => insertBlock(editor, "spacer")}
						/>
						<Action
							editor={editor}
							label="Page break"
							icon={Scissor01Icon}
							disabled={!s.insertable.pageBreak}
							run={() => insertBlock(editor, "pageBreak")}
						/>
					</>
				) : null}
			</ToolbarGroup>
			<ToolbarSeparator />
			<ToolbarGroup>
				{church ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								data-style="ghost"
								aria-label="Insert block"
								tooltip="Insert block after this one"
								onMouseDown={(event) => event.preventDefault()}
							>
								{glyph(Add01Icon)}
								<span>Insert</span>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							portal
							align="start"
							aria-label="Insert block"
							className="max-h-[min(75vh,560px)] overflow-y-auto"
						>
							{INSERT_KINDS.filter((k) => k.kind !== "slot" && s.insertable[k.kind]).map((k, i, shown) => {
								const image = k.group === "images" ? (k.kind as ImageKind) : null;
								const asset = image ? church.brand.assets[image] : null;
								const divide = i > 0 && shown[i - 1]?.group !== k.group;
								return (
									<Fragment key={k.kind}>
										{i === 0 || divide ? <MenuLabel>{GROUP_LABEL[k.group]}</MenuLabel> : null}
										<DropdownMenuItem
											className={MENU_ITEM}
											disabled={image !== null && !asset}
											onSelect={() => insertBlock(editor, k.kind, asset?.alt ?? "")}
										>
											{k.label}
										</DropdownMenuItem>
										{image && !asset ? (
											<div className="px-2.5 pb-1.5 text-sm text-text-2">
												<p>
													{church.brand.palette.themed
														? `Your brand kit has no ${IMAGE_KINDS[image]}.`
														: "This document uses the Everyfield theme, which prints no church images."}
												</p>
												<DropdownMenuItem
													asChild
													className={cn(MENU_ITEM, "inline-flex px-0 py-0.5 text-sm font-medium underline")}
												>
													<a href="/settings/brand" target="_blank" rel="noreferrer">
														Open the brand kit
													</a>
												</DropdownMenuItem>
											</div>
										) : null}
									</Fragment>
								);
							})}
							<MenuLabel>Doctrinal section</MenuLabel>
							<DropdownMenuItem
								className={MENU_ITEM}
								disabled={!s.insertable.slot}
								onSelect={() => insertBlock(editor, "slot")}
							>
								Doctrinal section
							</DropdownMenuItem>
							{!s.insertable.slot ? (
								<p className="max-w-[260px] px-2.5 pb-1.5 text-sm text-pretty text-text-2">
									{s.hasSlot
										? "This document already has one. Delete it first to add a new one."
										: "Put the cursor in the body to add one."}
								</p>
							) : null}
							<MenuLabel>Merge fields</MenuLabel>
							{INSERTABLE_FIELDS.map((field) => {
								const shown = s.values[field.key] ?? church.mergeValues[field.key] ?? `[${field.label.toLowerCase()}]`;
								return (
									<DropdownMenuItem
										key={field.key}
										className={cn(MENU_ITEM, "flex-col items-start gap-0")}
										disabled={!s.canField}
										onSelect={() => insertField(editor, field, church.mergeValues[field.key])}
									>
										<span>{field.label}</span>
										<span className="max-w-[240px] truncate text-sm text-text-2">{shown || "Prints nothing"}</span>
									</DropdownMenuItem>
								);
							})}
							{!s.canField ? (
								<p className="max-w-[260px] px-2.5 pb-1.5 text-sm text-pretty text-text-2">
									Put the cursor in a line of text to add a field.
								</p>
							) : null}
							{s.region ? (
								<>
									<MenuLabel>Page number</MenuLabel>
									{PAGE_NUMBERS.map((p) => (
										<DropdownMenuItem
											key={p.format}
											className={MENU_ITEM}
											onSelect={() => insertPageNumber(editor, p.format)}
										>
											{p.label}
										</DropdownMenuItem>
									))}
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
				<Action
					editor={editor}
					label="Move block up"
					icon={ArrowUp01Icon}
					shortcutKeys="mod+alt+up"
					disabled={!s.up}
					run={() => moveBlock(editor, -1)}
				/>
				<Action
					editor={editor}
					label="Move block down"
					icon={ArrowDown01Icon}
					shortcutKeys="mod+alt+down"
					disabled={!s.down}
					run={() => moveBlock(editor, 1)}
				/>
				<Action
					editor={editor}
					label="Delete block"
					icon={Delete02Icon}
					shortcutKeys="mod+alt+backspace"
					disabled={!s.hasBlock}
					run={() => deleteBlock(editor)}
				/>
			</ToolbarGroup>
			{church ? (
				<>
					<ToolbarSeparator />
					<ToolbarGroup>
						<Button
							type="button"
							data-style="ghost"
							data-active-state={church.pageSetup.open ? "on" : "off"}
							aria-label="Page setup"
							aria-expanded={church.pageSetup.open}
							aria-controls={church.pageSetup.controls}
							tooltip="Page setup: paper, margins, cards per sheet, header and footer"
							onClick={church.pageSetup.toggle}
						>
							{glyph(File02Icon)}
							<span>Page setup</span>
						</Button>
					</ToolbarGroup>
				</>
			) : null}
		</Toolbar>
	);
}
