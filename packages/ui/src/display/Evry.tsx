"use client";

import {
	Alert02Icon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Edit02Icon,
	SentIcon,
	Task01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, IconButton } from "../controls";
import { usePortalContainer, useReturnFocus } from "../controls/overlay-portal";
import { cn, EvryBot, Icon, type EvryMood, type IconSvgElement } from "../foundations";

/**
 * EvryPanel (components.md, Companion panel): Header, Context, Messages, Suggestions and Composer. A non-modal panel
 * from the right edge: the page stays usable beside it, Esc closes it and focus returns to what opened it. The chat
 * itself (sending, streaming, tools) belongs to the Evry feature; this is its frame.
 */
export function EvryPanel({
	open,
	onOpenChange,
	mood = "idle",
	view = "chat",
	onViewChange,
	context,
	history,
	suggestions = [],
	onSuggest,
	composer,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mood?: EvryMood;
	view?: "chat" | "history";
	onViewChange?: (view: "chat" | "history") => void;
	/** Tags for what Evry can see: the page, a meeting, "Page context on". */
	context?: ReactNode;
	/** The past conversations, shown in the history view. */
	history?: ReactNode;
	suggestions?: string[];
	onSuggest?: (text: string) => void;
	/** The EvryComposer. */
	composer?: ReactNode;
	/** The messages. */
	children: ReactNode;
}) {
	const container = usePortalContainer();
	const focus = useReturnFocus();
	const eyes = useRef<HTMLSpanElement>(null);
	useEyeFollow(eyes, open);
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<DialogPrimitive.Portal container={container}>
				<DialogPrimitive.Content
					{...focus}
					onInteractOutside={(e) => e.preventDefault()}
					className="ef-sheet fixed top-5 right-5 bottom-5 z-50 flex w-[min(560px,calc(100vw-40px))] flex-col overflow-hidden rounded-[30px] bg-surface text-md text-ink shadow-[var(--ef-shadow-pop),inset_0_0_0_1px_var(--ef-card-edge)] outline-none max-app-sm:inset-0 max-app-sm:w-full max-app-sm:rounded-none"
				>
					<div className="flex flex-none items-center gap-3 border-b border-line pt-[18px] pr-[18px] pb-3.5 pl-5">
						<span ref={eyes} className="contents">
							<EvryBot size="lg" mood={mood} />
						</span>
						<div className="min-w-0 flex-1">
							<DialogPrimitive.Title className="font-display text-[19px] leading-[1.2] font-medium text-ink">
								Evry
							</DialogPrimitive.Title>
							<DialogPrimitive.Description className="text-xs text-text-3">
								Reads and drafts. You approve every change.
							</DialogPrimitive.Description>
						</div>
						{onViewChange ? (
							<IconButton
								icon={view === "history" ? Cancel01Icon : Clock01Icon}
								label={view === "history" ? "Back to the chat" : "History"}
								size="sm"
								aria-pressed={view === "history"}
								onClick={() => onViewChange(view === "history" ? "chat" : "history")}
							/>
						) : null}
						<DialogPrimitive.Close asChild>
							<IconButton icon={Cancel01Icon} label="Close Evry" size="sm" />
						</DialogPrimitive.Close>
					</div>
					{view === "history" ? (
						<div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-3.5">{history}</div>
					) : (
						<>
							{context ? (
								<div className="flex flex-none flex-wrap gap-2 border-b border-line px-[18px] py-3">{context}</div>
							) : null}
							<div
								role="log"
								aria-label="Conversation with Evry"
								aria-live="polite"
								className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-[18px]"
							>
								{children}
							</div>
							<div className="flex-none border-t border-line p-3.5">
								{suggestions.length && onSuggest ? (
									<div className="mb-2.5 flex flex-wrap gap-2">
										{suggestions.map((s) => (
											<button
												key={s}
												type="button"
												onClick={() => onSuggest(s)}
												className="cursor-pointer rounded-full bg-surface-2 px-3 py-[7px] text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
											>
												{s}
											</button>
										))}
									</div>
								) : null}
								{composer}
							</div>
						</>
					)}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

/**
 * In the open panel the character's eyes follow the pointer (foundations.md, Evry character). They move at most 8% of
 * the character's size; reduced motion keeps them still.
 */
function useEyeFollow(ref: RefObject<HTMLSpanElement | null>, open: boolean) {
	useEffect(() => {
		if (!open || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		let frame = 0;
		const move = (e: PointerEvent) => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const bot = ref.current?.querySelector<HTMLElement>(".evry-bot");
				if (!bot) return;
				const r = bot.getBoundingClientRect();
				const dx = e.clientX - (r.left + r.width / 2);
				const dy = e.clientY - (r.top + r.height / 2);
				const d = Math.max(1, Math.hypot(dx, dy));
				const reach = r.width * 0.08 * Math.min(1, d / 200);
				bot.style.setProperty("--lx", `${((dx / d) * reach).toFixed(2)}px`);
				bot.style.setProperty("--ly", `${((dy / d) * reach).toFixed(2)}px`);
			});
		};
		addEventListener("pointermove", move);
		return () => {
			cancelAnimationFrame(frame);
			removeEventListener("pointermove", move);
		};
	}, [ref, open]);
}

/**
 * The Evry message box: Enter sends, Shift+Enter adds a line. `busy` disables sending while Evry answers; the text
 * stays so nothing typed is lost.
 */
export function EvryComposer({
	onSend,
	busy,
	tools,
	placeholder = "Ask Evry or describe a change…",
}: {
	onSend: (text: string) => void;
	busy?: boolean;
	/** Icon buttons left of Send: attach, link the page. */
	tools?: ReactNode;
	placeholder?: string;
}) {
	const [text, setText] = useState("");
	const id = useId();
	const send = () => {
		const t = text.trim();
		if (!t || busy) return;
		onSend(t);
		setText("");
	};
	return (
		<div className="rounded-[18px] bg-surface-raised pt-3 pr-3 pb-2.5 pl-4 shadow-[0_0_0_1px_var(--ef-line-2)] focus-within:shadow-[0_0_0_1.5px_var(--ef-ink-2)]">
			<label htmlFor={id} className="sr-only">
				Message to Evry
			</label>
			<textarea
				id={id}
				rows={1}
				value={text}
				placeholder={placeholder}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						send();
					}
				}}
				className="field-sizing-content max-h-40 min-h-6 w-full resize-none bg-transparent text-ink outline-none placeholder:text-text-3"
			/>
			<div className="mt-2 flex items-center justify-between">
				<div className="flex gap-1">{tools}</div>
				<Button
					variant="primary"
					size="sm"
					aria-label="Send"
					disabled={busy || text.trim() === ""}
					onClick={send}
					className="w-[34px] px-0"
				>
					<Icon icon={SentIcon} size={16} />
				</Button>
			</div>
		</div>
	);
}

/**
 * EvryMessage (components.md, Message): Avatar, Bubble and Citation; role user or evry. A user message is an ink
 * bubble on the right; Evry's answer is plain text beside the character, which takes the message's mood.
 */
export function EvryMessage({
	role,
	mood = "idle",
	children,
}: {
	role: "user" | "evry";
	mood?: EvryMood;
	children: ReactNode;
}) {
	if (role === "user") {
		return (
			<div className="max-w-[85%] self-end rounded-[18px_18px_6px_18px] bg-ink px-[15px] py-[11px] text-on-ink">
				<span className="sr-only">You: </span>
				{children}
			</div>
		);
	}
	return (
		<div className="flex max-w-full gap-2.5">
			<span className="grid size-[30px] flex-none place-items-center">
				<EvryBot size="md" mood={mood} />
			</span>
			<div className="min-w-0 flex-1 leading-[1.55] text-ink-2">
				<span className="sr-only">Evry: </span>
				{children}
			</div>
		</div>
	);
}

/** Evry is working on an answer: the thinking character and a status line. */
export function EvryThinking({ children = "Evry is thinking" }: { children?: ReactNode }) {
	return (
		<div role="status" className="flex items-center gap-2.5 text-sm text-text-3">
			<span className="grid size-[30px] flex-none place-items-center">
				<EvryBot size="md" mood="thinking" />
			</span>
			{children}
		</div>
	);
}

/** Citation: where a statement comes from ("Attendance · #11"), as a link when the source has a page. */
export function Cite({ href, children }: { href?: string; children: ReactNode }) {
	const look =
		"inline-flex h-[22px] items-center gap-1 rounded-[6px] bg-blue-100 px-2 align-[1px] text-xs font-semibold whitespace-nowrap text-blue-600";
	return href ? (
		<a href={href} className={cn(look, "hover:underline")}>
			<span className="sr-only">Source: </span>
			{children}
		</a>
	) : (
		<span className={look}>
			<span className="sr-only">Source: </span>
			{children}
		</span>
	);
}

export type ReviewState = "pending" | "revised" | "approved" | "failed" | "expired";

const HEAD: Record<ReviewState, { icon: IconSvgElement; look: string }> = {
	pending: {
		icon: Edit02Icon,
		look: "bg-amber-50 text-amber-600 border-[color-mix(in_srgb,var(--ef-amber-500)_18%,transparent)]",
	},
	revised: {
		icon: Edit02Icon,
		look: "bg-amber-50 text-amber-600 border-[color-mix(in_srgb,var(--ef-amber-500)_18%,transparent)]",
	},
	approved: {
		icon: CheckmarkCircle02Icon,
		look: "bg-green-50 text-green-700 border-[color-mix(in_srgb,var(--ef-green-500)_20%,transparent)]",
	},
	failed: {
		icon: Alert02Icon,
		look: "bg-magenta-50 text-magenta-600 border-[color-mix(in_srgb,var(--ef-magenta-500)_20%,transparent)]",
	},
	expired: { icon: Clock01Icon, look: "bg-surface-2 text-text-2 border-line" },
};

export type ReviewLine = { content: ReactNode; icon?: IconSvgElement; result?: "saved" | "failed"; muted?: boolean };

/**
 * ReviewCard (components.md): Header, Note, Lines and Footer; pending, revised, approved, failed or expired. Every
 * change Evry prepares waits for approval of the exact revision shown, so Approve names the revision. A failed card
 * says which lines were not saved; an expired one says nothing was saved.
 */
export function ReviewCard({
	state,
	title,
	meta,
	note,
	lines,
	actions,
	footnote,
	className,
}: {
	state: ReviewState;
	/** "Review 2 changes", "Saved", "1 of 2 not saved", "Expired". */
	title: string;
	/** "Revision 2", "9:14 am". */
	meta?: string;
	/** "Revision 1 was replaced because you changed the due date." */
	note?: ReactNode;
	lines: ReviewLine[];
	/** ReviewActions for pending and revised; a follow-up for the other states. */
	actions?: ReactNode;
	/** "Approved by Daniel". */
	footnote?: ReactNode;
	className?: string;
}) {
	const headId = useId();
	const head = HEAD[state];
	return (
		<section
			aria-labelledby={headId}
			data-state={state}
			className={cn(
				"overflow-hidden rounded-[20px] bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line),var(--ef-shadow-raised)]",
				className,
			)}
		>
			<div
				role={state === "failed" ? "alert" : undefined}
				className={cn("flex items-center gap-2.5 border-b px-4 py-3.5 text-sm font-semibold", head.look)}
			>
				<Icon icon={head.icon} size={16} />
				<h3 id={headId} className="min-w-0 flex-1 font-body text-sm font-semibold tracking-normal">
					{title}
				</h3>
				{meta ? <span className="font-medium">{meta}</span> : null}
			</div>
			{note ? <div className="bg-surface-2 px-4 py-2.5 text-sm text-text-2">{note}</div> : null}
			<ul className={cn("flex flex-col gap-2.5 px-4 py-3.5", state === "expired" && "opacity-55")}>
				{lines.map((l, i) => (
					<li key={i} className="flex items-start gap-2.5 text-md">
						<Icon
							icon={l.result === "saved" ? Tick02Icon : l.result === "failed" ? Cancel01Icon : (l.icon ?? Task01Icon)}
							size={16}
							className={cn("mt-0.5", l.result === "failed" ? "text-magenta-500" : "text-text-3")}
						/>
						<span className={cn("min-w-0", l.muted ? "text-text-2" : "text-ink")}>
							{l.result === "failed" ? <span className="sr-only">Not saved: </span> : null}
							{l.result === "saved" ? <span className="sr-only">Saved: </span> : null}
							{l.content}
						</span>
					</li>
				))}
			</ul>
			{actions || footnote ? (
				<div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
					{footnote ? <span className="min-w-0 flex-1 text-xs text-text-3">{footnote}</span> : null}
					{actions}
				</div>
			) : null}
		</section>
	);
}

/** The pending footer: Approve (this exact revision), Edit and Cancel. */
export function ReviewActions({
	revision,
	onApprove,
	onEdit,
	onCancel,
	approving,
}: {
	revision: number;
	onApprove: () => void;
	onEdit?: () => void;
	onCancel?: () => void;
	approving?: boolean;
}) {
	return (
		<>
			<Button
				variant="primary"
				size="sm"
				icon={Tick02Icon}
				loading={approving}
				onClick={onApprove}
				aria-label={`Approve revision ${revision}`}
			>
				Approve
			</Button>
			{onEdit ? (
				<Button variant="secondary" size="sm" onClick={onEdit} disabled={approving}>
					Edit
				</Button>
			) : null}
			{onCancel ? (
				<Button variant="ghost" size="sm" onClick={onCancel} disabled={approving} className="ml-auto">
					Cancel
				</Button>
			) : null}
		</>
	);
}
