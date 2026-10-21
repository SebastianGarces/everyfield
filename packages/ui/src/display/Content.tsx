"use client";

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowTurnBackwardIcon,
	ArrowTurnForwardIcon,
	Building03Icon,
	Heading02Icon,
	Image01Icon,
	InformationCircleIcon,
	LeftToRightListBulletIcon,
	LeftToRightListNumberIcon,
	Link01Icon,
	QuoteDownIcon,
	TextBoldIcon,
	TextItalicIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Accordion, DropdownMenu, Toolbar } from "radix-ui";
import { useEffect, useState, type ComponentPropsWithRef, type ElementType, type ReactNode } from "react";
import { Button, MenuContent, MenuLabel, MenuSeparator, Menu, MenuTrigger } from "../controls";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { StatusBadge } from "./Badges";

export type SetupStep = { title: ReactNode; hint?: ReactNode; done: boolean; action?: ReactNode };

/**
 * SetupChecklist (components.md): numbered steps with a title, a hint and an action. A done step shows a tick, is
 * struck through and drops its action; screen readers hear "Done" before it.
 */
export function SetupChecklist({ steps, label, className }: { steps: SetupStep[]; label: string; className?: string }) {
	return (
		<ol aria-label={label} className={cn("flex flex-col", className)}>
			{steps.map((s, i) => (
				<li
					key={i}
					data-done={s.done ? "" : undefined}
					className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-line py-3.5 first:border-t-0"
				>
					<span
						aria-hidden="true"
						className={cn(
							"grid size-7 place-items-center rounded-full text-[13px] font-semibold",
							s.done ? "bg-green-500 text-ink-fixed" : "bg-surface-2 text-ink",
						)}
					>
						{s.done ? <Icon icon={Tick02Icon} size={16} /> : i + 1}
					</span>
					<div className="min-w-0">
						{s.done ? <span className="sr-only">Done: </span> : null}
						<div className={cn("font-medium", s.done ? "text-text-3 line-through" : "text-ink")}>{s.title}</div>
						{s.hint && !s.done ? <div className="mt-0.5 text-sm text-text-2">{s.hint}</div> : null}
					</div>
					<span>{s.done ? null : s.action}</span>
				</li>
			))}
		</ol>
	);
}

/** UiRef (components.md, How-to steps: UI reference): the name of a button or page, written as it looks in the app. */
export function UiRef({ icon, children }: { icon?: IconSvgElement; children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-[5px] rounded-[7px] bg-surface-2 px-2 py-px align-baseline text-[13px] font-medium whitespace-nowrap text-ink">
			{icon ? <Icon icon={icon} size={16} className="size-[13px]" /> : null}
			{children}
		</span>
	);
}

/** HowTo.Steps (components.md): numbered steps of a help article, each with a bold lead and a sentence or two. */
export function HowToSteps({
	steps,
	className,
}: {
	steps: { title: ReactNode; body: ReactNode }[];
	className?: string;
}) {
	return (
		<ol className={cn("flex max-w-[700px] flex-col gap-1", className)}>
			{steps.map((s, i) => (
				<li key={i} className="relative border-t border-line pt-3.5 pr-0 pb-[18px] pl-[54px] first:border-t-0">
					<span
						aria-hidden="true"
						className="absolute top-3 left-0 grid size-[34px] place-items-center rounded-[11px] bg-surface-2 font-title tracking-[-0.02em] text-ink"
					>
						{i + 1}
					</span>
					<b className="font-semibold text-ink">{s.title}</b>
					<p className="mt-1 leading-[1.6] text-ink-2">{s.body}</p>
				</li>
			))}
		</ol>
	);
}
/**
 * Faq (components.md, FAQ item): Question and Answer on the Accordion primitive. Several can be open at once; each
 * question is a button with aria-expanded, and the plus turns into a cross when open.
 */
export function FaqList({
	items,
	defaultOpen = [],
	headingLevel = "h3",
	className,
}: {
	items: { id: string; question: string; answer: ReactNode }[];
	defaultOpen?: string[];
	headingLevel?: "h2" | "h3" | "h4";
	className?: string;
}) {
	return (
		<Accordion.Root type="multiple" defaultValue={defaultOpen} className={className}>
			{items.map((item) => (
				<Accordion.Item key={item.id} value={item.id} className="border-t border-line first:border-t-0">
					<Accordion.Header asChild>
						<FaqHeading level={headingLevel}>
							<Accordion.Trigger className="group/faq flex w-full cursor-pointer items-center gap-3 py-[15px] text-left font-sans font-medium tracking-normal text-ink">
								<span className="min-w-0 flex-1">{item.question}</span>
								<Icon
									icon={Add01Icon}
									size={18}
									className="text-text-3 transition-transform duration-200 group-data-[state=open]/faq:rotate-45 motion-reduce:transition-none"
								/>
							</Accordion.Trigger>
						</FaqHeading>
					</Accordion.Header>
					<Accordion.Content className="pr-7 pb-4 leading-[1.6] text-ink-2">{item.answer}</Accordion.Content>
				</Accordion.Item>
			))}
		</Accordion.Root>
	);
}

function FaqHeading({ level, ...props }: { level: "h2" | "h3" | "h4" } & ComponentPropsWithRef<"h3">) {
	const H = level;
	return <H className="font-body text-base font-medium tracking-normal" {...props} />;
}

/**
 * Prose (components.md, Wiki tree / TOC / prose): article typography for Wiki and Help bodies. A 700px measure,
 * headings in the display face, quotes in a tinted block and links underlined in green.
 */
export function Prose({ size = "md", className, ...props }: { size?: "md" | "sm" } & ComponentPropsWithRef<"div">) {
	return (
		<div
			className={cn(
				"mx-auto w-full text-ink-2",
				size === "md" ? "max-w-[700px] text-base leading-[1.7]" : "text-[15px] leading-[1.65]",
				"[&_h2]:mt-[34px] [&_h2]:mb-2.5 [&_h2]:text-[26px] [&_h2]:text-ink [&_h2]:scroll-mt-28",
				"[&_h3]:mt-[26px] [&_h3]:mb-2 [&_h3]:text-[19px] [&_h3]:text-ink [&_h3]:scroll-mt-28",
				size === "sm" && "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:font-title [&_h2]:text-[21px] [&_h3]:text-[17px]",
				"[&_p]:mb-3.5 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-[22px] [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-[22px] [&_li]:my-1.5",
				"[&_blockquote]:my-5 [&_blockquote]:rounded-[18px] [&_blockquote]:bg-surface-2 [&_blockquote]:px-5 [&_blockquote]:py-4 [&_blockquote]:font-title [&_blockquote]:tracking-[-0.02em] [&_blockquote]:text-[19px] [&_blockquote]:leading-[1.45] [&_blockquote]:text-ink",
				"[&_cite]:mt-2 [&_cite]:block [&_cite]:font-body [&_cite]:tracking-normal [&_cite]:text-[13px] [&_cite]:text-text-3 [&_cite]:not-italic",
				"[&_a]:text-ink [&_a]:underline [&_a]:decoration-green-500 [&_a]:decoration-2 [&_a]:underline-offset-[3px]",
				className,
			)}
			{...props}
		/>
	);
}

export type WikiPhase = {
	number: number;
	name: string;
	items: { id: string; title: string; href: string; read?: boolean }[];
};

/**
 * WikiTree (components.md): Phase, Item and Read marker on the Accordion primitive. The phase that holds the current
 * article starts open; the current article has aria-current="page"; a read article says so to screen readers.
 */
export function WikiTree({
	phases,
	currentId,
	linkAs: Link = "a",
	label = "Wiki articles by phase",
	className,
}: {
	phases: WikiPhase[];
	currentId?: string;
	linkAs?: ElementType;
	label?: string;
	className?: string;
}) {
	const holding = phases.find((p) => p.items.some((i) => i.id === currentId));
	return (
		<nav aria-label={label} className={className}>
			<Accordion.Root
				type="multiple"
				defaultValue={holding ? [String(holding.number)] : []}
				className="flex flex-col gap-0.5"
			>
				{phases.map((p) => (
					<Accordion.Item key={p.number} value={String(p.number)}>
						<Accordion.Header>
							<Accordion.Trigger
								data-focus-inset=""
								className="group/ph flex w-full cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 py-[9px] text-left font-medium text-ink transition-colors hover:bg-surface-2"
							>
								<span
									aria-hidden="true"
									className="grid size-6 flex-none place-items-center rounded-[7px] bg-surface-2 font-title tracking-[-0.02em] text-xs text-text-2 group-data-[state=open]/ph:bg-ink group-data-[state=open]/ph:text-on-ink"
								>
									{p.number}
								</span>
								<span className="sr-only">Phase {p.number}: </span>
								{p.name}
							</Accordion.Trigger>
						</Accordion.Header>
						<Accordion.Content>
							<ul className="flex flex-col gap-0.5">
								{p.items.map((item) => (
									<li key={item.id}>
										<Link
											href={item.href}
											aria-current={item.id === currentId ? "page" : undefined}
											data-focus-inset=""
											className="flex items-center gap-2 rounded-[10px] py-[7px] pr-2.5 pl-11 text-md text-text-2 transition-colors hover:bg-surface-2 hover:text-ink aria-[current=page]:font-medium aria-[current=page]:text-ink"
										>
											{item.title}
											{item.read ? (
												<>
													<span aria-hidden="true" className="ml-auto size-1.5 flex-none rounded-full bg-green-500" />
													<span className="sr-only">, read</span>
												</>
											) : null}
										</Link>
									</li>
								))}
							</ul>
						</Accordion.Content>
					</Accordion.Item>
				))}
			</Accordion.Root>
		</nav>
	);
}

/**
 * The id of the heading nearest the top of the viewport, for Toc. It watches the given heading ids with an
 * IntersectionObserver and returns the last one that crossed the reading line.
 */
export function useActiveHeading(ids: string[]): string | undefined {
	const [active, setActive] = useState<string | undefined>(ids[0]);
	const key = ids.join("|");
	useEffect(() => {
		const els = key
			.split("|")
			.map((id) => document.getElementById(id))
			.filter((el): el is HTMLElement => el !== null);
		if (els.length === 0) return;
		const observer = new IntersectionObserver(
			(entries) => {
				const above = entries.filter((e) => e.isIntersecting).map((e) => e.target.id);
				if (above.length) setActive(above[0]);
			},
			{ rootMargin: "-96px 0px -66% 0px" },
		);
		els.forEach((el) => observer.observe(el));
		return () => observer.disconnect();
	}, [key]);
	return active;
}

/** Toc (components.md): "On this page" links to the article's headings; the current section is marked. */
export function Toc({
	items,
	current,
	label = "On this page",
	className,
}: {
	items: { id: string; label: string; level?: 2 | 3 }[];
	current?: string;
	label?: string;
	className?: string;
}) {
	return (
		<nav aria-label={label} className={className}>
			<p className="mb-2.5 text-sm text-text-3">{label}</p>
			<ul className="flex flex-col gap-0.5 border-l-[1.5px] border-line">
				{items.map((item) => (
					<li key={item.id}>
						<a
							href={`#${item.id}`}
							aria-current={item.id === current ? "location" : undefined}
							className={cn(
								"-ml-[1.5px] block border-l-[1.5px] border-transparent py-1.5 pr-3.5 text-md text-text-3 transition-colors hover:text-ink aria-[current=location]:border-ink aria-[current=location]:font-medium aria-[current=location]:text-ink",
								item.level === 3 ? "pl-[26px]" : "pl-3.5",
							)}
						>
							{item.label}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}

export type WikiSource = {
	id: string;
	/** Two letters for the badge: "AS". */
	short: string;
	name: string;
	/** "Edited version 3 · Sep 12". */
	meta: string;
	kind: "network" | "global";
};

function OrgBadge({ source, size = "sm" }: { source: WikiSource; size?: "sm" | "md" }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid flex-none place-items-center text-[11px] font-bold",
				size === "sm" ? "size-[26px] rounded-[8px]" : "size-[30px] rounded-[9px]",
				source.kind === "global" ? "bg-green-100 text-green-700" : "bg-violet-100 text-violet-600",
			)}
		>
			{source.short}
		</span>
	);
}

/**
 * WikiSourceBar (components.md): Source menu, Meta, Back to preferred and Admin tools. Choosing a source changes only
 * what this reader sees now; reading a named source that is not the preferred one outlines the bar in blue and
 * offers the way back. `admin` holds the Hide and Edit actions, shown only to editors.
 */
export function WikiSourceBar({
	sources,
	currentId,
	preferredId,
	onChoose,
	settingsHref,
	admin,
	adminLabel = "Network admin",
	className,
}: {
	sources: WikiSource[];
	currentId: string;
	preferredId: string;
	onChoose: (id: string) => void;
	settingsHref?: string;
	admin?: ReactNode;
	adminLabel?: string;
	className?: string;
}) {
	const current = sources.find((s) => s.id === currentId) ?? sources[0];
	if (!current) return null;
	const named = currentId !== preferredId;
	return (
		<div
			data-view={named ? "named" : "default"}
			className={cn(
				"flex flex-wrap items-center gap-3 rounded-[18px] bg-surface py-2.5 pr-3 pl-2.5 shadow-card",
				named && "shadow-[var(--ef-shadow-card),inset_0_0_0_1.5px_var(--ef-blue-300)]",
				className,
			)}
		>
			<Menu>
				<MenuTrigger asChild>
					<button
						type="button"
						className="inline-flex h-10 cursor-pointer items-center gap-2.5 rounded-[13px] bg-surface-2 pr-3 pl-2 text-ink transition-colors hover:bg-surface-3"
					>
						<OrgBadge source={current} />
						<span>
							<span className="text-sm text-text-2">Source</span> <b className="font-semibold">{current.name}</b>
						</span>
						<Icon icon={ArrowDown01Icon} size={16} className="text-text-3" />
					</button>
				</MenuTrigger>
				<MenuContent className="w-[380px] max-w-[calc(100vw-24px)]">
					<MenuLabel className="text-sm font-semibold text-ink">Read this article from</MenuLabel>
					<DropdownMenu.RadioGroup value={currentId} onValueChange={onChoose}>
						{sources.map((s) => (
							<DropdownMenu.RadioItem
								key={s.id}
								value={s.id}
								className="grid cursor-pointer grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[12px] p-2.5 outline-none data-[highlighted]:bg-surface-2"
							>
								<OrgBadge source={s} size="md" />
								<span className="min-w-0">
									<span className="block font-medium text-ink">{s.name}</span>
									<span className="block text-xs text-text-2">
										{s.meta}
										{s.id === preferredId ? " · your preferred source" : ""}
									</span>
								</span>
								<DropdownMenu.ItemIndicator>
									<Icon icon={Tick02Icon} size={18} className="text-ink" />
								</DropdownMenu.ItemIndicator>
							</DropdownMenu.RadioItem>
						))}
					</DropdownMenu.RadioGroup>
					<MenuSeparator />
					<MenuLabel className="text-xs font-normal">
						Choosing a source changes only what you read now. Your church&apos;s preferred source is set in Settings.
					</MenuLabel>
					{settingsHref ? (
						<DropdownMenu.Item asChild>
							<a
								href={settingsHref}
								className="flex h-[38px] items-center rounded-[10px] px-2.5 text-md text-ink outline-none data-[highlighted]:bg-surface-2"
							>
								Change the preferred source
							</a>
						</DropdownMenu.Item>
					) : null}
				</MenuContent>
			</Menu>
			<span className="min-w-[220px] flex-1 text-sm text-text-2 max-app-sm:min-w-full">
				{current.meta}
				{named ? "" : " · your preferred source"}
			</span>
			{named ? (
				<Button variant="ghost" size="sm" onClick={() => onChoose(preferredId)}>
					Back to your preferred source
				</Button>
			) : null}
			{admin ? (
				<span className="flex flex-wrap items-center gap-2">
					<StatusBadge plain size="sm">
						<Icon icon={Building03Icon} size={16} className="size-3" />
						{adminLabel}
					</StatusBadge>
					{admin}
				</span>
			) : null}
		</div>
	);
}

export type EditorCommand =
	"block" | "bold" | "italic" | "link" | "bulletList" | "orderedList" | "quote" | "callout" | "image" | "undo" | "redo";

const TOOLS: ({ cmd: EditorCommand; label: string; icon: IconSvgElement; toggle?: boolean } | "sep")[] = [
	{ cmd: "bold", label: "Bold (⌘B)", icon: TextBoldIcon, toggle: true },
	{ cmd: "italic", label: "Italic (⌘I)", icon: TextItalicIcon, toggle: true },
	{ cmd: "link", label: "Link (⌘K)", icon: Link01Icon, toggle: true },
	"sep",
	{ cmd: "bulletList", label: "Bulleted list", icon: LeftToRightListBulletIcon, toggle: true },
	{ cmd: "orderedList", label: "Numbered list", icon: LeftToRightListNumberIcon, toggle: true },
	{ cmd: "quote", label: "Quote", icon: QuoteDownIcon, toggle: true },
	{ cmd: "callout", label: "Callout", icon: InformationCircleIcon },
	{ cmd: "image", label: "Image", icon: Image01Icon },
	"sep",
	{ cmd: "undo", label: "Undo (⌘Z)", icon: ArrowTurnBackwardIcon },
	{ cmd: "redo", label: "Redo (⇧⌘Z)", icon: ArrowTurnForwardIcon },
];

const TOOL =
	"grid size-9 cursor-pointer place-items-center rounded-[10px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-surface-2 aria-pressed:text-ink data-[state=on]:bg-surface-2 data-[state=on]:text-ink";

/**
 * WikiEditor (components.md): Toolbar, Title, Body blocks, Change marks and the side panel. This is the frame only:
 * the editing engine comes from the editor contract (C-EDITOR, WP-032) and renders into `children`; the toolbar
 * reports commands and shows the engine's active marks. Body blocks marked data-change="changed" or "added" get a
 * blue or green bar in the margin, explained by the key in the toolbar.
 */
export function WikiEditor({
	title,
	onTitleChange,
	blockLabel = "Paragraph",
	active = [],
	disabled = [],
	onCommand,
	changeKey = true,
	aside,
	children,
	className,
}: {
	title: string;
	onTitleChange: (title: string) => void;
	/** The current block style shown on the first toolbar button: "Heading 2". */
	blockLabel?: string;
	active?: EditorCommand[];
	disabled?: EditorCommand[];
	onCommand: (cmd: EditorCommand) => void;
	changeKey?: boolean;
	/** The side panel: version, readers, history and hide cards. */
	aside?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid grid-cols-[minmax(0,1fr)_320px] items-start gap-5 max-app-md:grid-cols-1", className)}>
			<article className="min-w-0 rounded-card border border-[var(--ef-card-edge)] bg-surface px-11 pt-[22px] pb-11 shadow-card max-app-sm:px-5">
				<Toolbar.Root
					aria-label="Formatting"
					className="sticky top-24 z-[3] mb-[18px] flex flex-wrap items-center gap-0.5 rounded-[16px] bg-surface-raised p-1.5 shadow-[var(--ef-shadow-raised),inset_0_0_0_1px_var(--ef-line)]"
				>
					<Toolbar.Button
						onClick={() => onCommand("block")}
						aria-haspopup="menu"
						className={cn(TOOL, "inline-flex w-auto gap-1.5 px-2.5 text-sm font-medium")}
					>
						<Icon icon={Heading02Icon} size={18} />
						{blockLabel}
						<Icon icon={ArrowDown01Icon} size={16} className="size-3.5" />
					</Toolbar.Button>
					<Toolbar.Separator className="mx-1.5 h-[22px] w-px bg-line-2" />
					{TOOLS.map((t, i) =>
						t === "sep" ? (
							<Toolbar.Separator key={i} className="mx-1.5 h-[22px] w-px bg-line-2" />
						) : (
							<Toolbar.Button
								key={t.cmd}
								aria-label={t.label}
								title={t.label}
								aria-pressed={t.toggle ? active.includes(t.cmd) : undefined}
								disabled={disabled.includes(t.cmd)}
								onClick={() => onCommand(t.cmd)}
								className={TOOL}
							>
								<Icon icon={t.icon} size={18} />
							</Toolbar.Button>
						),
					)}
					{changeKey ? (
						<span className="ml-auto flex flex-wrap gap-3.5 pr-2 text-xs text-text-2">
							<span className="inline-flex items-center gap-1.5">
								<i aria-hidden="true" className="inline-block h-3 w-[3px] rounded-[2px] bg-blue-500" />
								Changed from global
							</span>
							<span className="inline-flex items-center gap-1.5">
								<i aria-hidden="true" className="inline-block h-3 w-[3px] rounded-[2px] bg-green-500" />
								Added by your network
							</span>
						</span>
					) : null}
				</Toolbar.Root>
				<textarea
					rows={1}
					value={title}
					onChange={(e) => onTitleChange(e.target.value.replace(/\n/g, " "))}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.preventDefault();
					}}
					aria-label="Article title"
					className="mb-3.5 field-sizing-content w-full resize-none border-0 bg-transparent p-0 font-display text-[38px] leading-[1.12] tracking-[-0.02em] text-ink outline-none max-app-sm:text-[28px]"
				/>
				<Prose
					className={cn(
						"m-0 min-h-[520px]",
						"[&_[data-change]]:relative [&_[data-change]]:before:absolute [&_[data-change]]:before:top-1 [&_[data-change]]:before:bottom-1 [&_[data-change]]:before:-left-[22px] [&_[data-change]]:before:w-[3px] [&_[data-change]]:before:rounded-[3px] [&_[data-change]]:before:content-[''] [&_[data-change=changed]]:before:bg-blue-500 [&_[data-change=added]]:before:bg-green-500",
						"max-app-sm:[&_[data-change]]:before:-left-3",
					)}
				>
					{children}
				</Prose>
			</article>
			{aside ? <div className="sticky top-24 flex flex-col gap-4 max-app-md:static">{aside}</div> : null}
		</div>
	);
}

/** The "Type / to add a block" hint inside an editor body. */
export function InsertHint({
	children = "Type / to add a heading, list, quote, callout or image",
}: {
	children?: ReactNode;
}) {
	return (
		<div contentEditable={false} className="flex items-center gap-2 py-2 text-sm text-text-3">
			<Icon icon={Add01Icon} size={16} />
			{children}
		</div>
	);
}

export type Revision = {
	id: string;
	title: string;
	meta: string;
	state?: "draft" | "current";
	action?: ReactNode;
};

/** The History card of the editor side panel: a draft (amber), the published version (green) and older ones. */
export function RevisionList({ revisions, className }: { revisions: Revision[]; className?: string }) {
	return (
		<ol className={cn("flex flex-col", className)}>
			{revisions.map((r) => (
				<li
					key={r.id}
					className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-line py-2.5 text-sm first:border-t-0"
				>
					<span
						aria-hidden="true"
						className={cn(
							"mt-1.5 size-2 rounded-full",
							r.state === "draft" ? "bg-amber-500" : r.state === "current" ? "bg-green-500" : "bg-text-3",
						)}
					/>
					<div className="min-w-0">
						<div className="font-medium text-ink">
							{r.title}
							{r.state === "current" ? <span className="sr-only"> (published)</span> : null}
						</div>
						<div className="text-xs text-text-3">{r.meta}</div>
					</div>
					{r.state === "draft" ? (
						<StatusBadge status="attention" size="sm">
							Draft
						</StatusBadge>
					) : (
						r.action
					)}
				</li>
			))}
		</ol>
	);
}
