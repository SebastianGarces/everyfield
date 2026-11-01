"use client";

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete02Icon,
	ParagraphSpacingIcon,
	Scissor01Icon,
	SeparatorHorizontalIcon,
	Tag01Icon,
	TextNumberSignIcon,
	UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import type { Editor } from "@tiptap/react";
import { useEffect, useReducer } from "react";
import { useEditorState } from "@tiptap/react";
import {
	canMove,
	canNumber,
	canSetTextStyle,
	currentBlock,
	deleteBlock,
	INSERT_KINDS,
	insertBlock,
	isNumbered,
	moveBlock,
	setTextStyle,
	TEXT_STYLES,
	toggleNumbered,
	currentTextStyle,
	type InsertKind,
} from "./blocks.ts";
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
// Every control has a name and a tooltip. A control that cannot apply is disabled, not hidden.

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

export function EditorToolbar({ editor }: { editor: Editor }) {
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
			return {
				style: currentTextStyle(state),
				numbered: isNumbered(state),
				canNumber: canNumber(state),
				up: canMove(state, -1),
				down: canMove(state, 1),
				hasBlock: !empty,
				tag: e.isActive("tag"),
				canTag: e.can().toggleMark("tag"),
				styles: Object.fromEntries(TEXT_STYLES.map((t) => [t.style, canSetTextStyle(e, t.style)])),
			};
		},
	});
	const current = TEXT_STYLES.find((t) => t.style === s.style);
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
						{TEXT_STYLES.map((t) => (
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
				<Action
					editor={editor}
					label="Numbered heading"
					icon={TextNumberSignIcon}
					active={s.numbered}
					disabled={!s.canNumber}
					run={() => toggleNumbered(editor)}
				/>
			</ToolbarGroup>
			<ToolbarSeparator />
			<ToolbarGroup>
				<MarkButton editor={editor} type="bold" />
				<MarkButton editor={editor} type="italic" />
				<MarkButton editor={editor} type="underline" />
				<Action
					editor={editor}
					label="Tag"
					icon={Tag01Icon}
					active={s.tag}
					disabled={!s.canTag}
					run={() => editor.chain().setMeta("closeHistory", true).focus().toggleMark("tag").run()}
				/>
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
					run={() => insertBlock(editor, "divider")}
				/>
				<Action editor={editor} label="Spacer" icon={ParagraphSpacingIcon} run={() => insertBlock(editor, "spacer")} />
				<Action editor={editor} label="Page break" icon={Scissor01Icon} run={() => insertBlock(editor, "pageBreak")} />
			</ToolbarGroup>
			<ToolbarSeparator />
			<ToolbarGroup>
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
					<DropdownMenuContent portal align="start" aria-label="Insert block">
						{INSERT_KINDS.map((k: { kind: InsertKind; label: string }) => (
							<DropdownMenuItem key={k.kind} className={MENU_ITEM} onSelect={() => insertBlock(editor, k.kind)}>
								{k.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
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
		</Toolbar>
	);
}
