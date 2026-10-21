"use client";

import {
	Add01Icon,
	Clock01Icon,
	Link01Icon,
	SentIcon,
	StopIcon,
	Unlink01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { Button, IconButton, SearchInput, Sheet, Skeleton, StatePanel, Tooltip } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn, EvryBot, Icon, type EvryMood } from "@everyfield/ui/foundations";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import * as api from "./api.ts";
import {
	answerText,
	endNotice,
	MAX_MESSAGE,
	pageReferences,
	resendable,
	retryable,
	sendNotice,
	type Conversation,
	type Send,
	type Turn,
} from "./model.ts";
import { ResultCard, ReviewSlot } from "./ResultCard.tsx";
import { useConversation } from "./useConversation.ts";

// The Evry panel (WP-051/ui; design/everyfield-ui.html, Evry panel): one private conversation beside any product page,
// opened from Ask Evry or with Cmd+J (Ctrl+J). It is non-modal, so the page stays usable and the conversation stays the
// same while the person moves between pages. Esc closes it and focus returns to what opened it.

/** The panel and its opener. Cmd+J or Ctrl+J opens and closes it from anywhere in the product frame. */
export function useEvryPanel({ inPlant }: { inPlant: boolean }) {
	const [open, setOpen] = useState(false);
	const c = useConversation(open);
	// The latest conversation loads the first time the panel opens; later opens keep what the panel already has.
	const show = (next: boolean) => {
		setOpen(next);
		if (next) c.ensureLoaded();
	};
	const toggle = useRef(() => show(!open));
	useEffect(() => {
		toggle.current = () => show(!open);
	});
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
				e.preventDefault();
				toggle.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return {
		open: () => show(true),
		element: <EvryPanel c={c} open={open} onOpenChange={show} inPlant={inPlant} />,
	};
}

function EvryPanel({
	c,
	open,
	onOpenChange,
	inPlant,
}: {
	c: Model;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	inPlant: boolean;
}) {
	const [view, setView] = useState<"chat" | "history">("chat");
	const [draft, setDraft] = useState("");
	const composer = useRef<HTMLTextAreaElement>(null);
	const last = c.turns.at(-1);
	const streaming = c.state.activeTurnId !== null && last?.id === c.state.activeTurnId;
	const mood: EvryMood = streaming ? (last.blocks.some((b) => b.kind === "text") ? "talking" : "thinking") : "idle";

	// Focus the composer once the panel has opened (the sheet first records what opened it, for focus return).
	useEffect(() => {
		if (!open || view !== "chat") return;
		const t = setTimeout(() => composer.current?.focus(), 0);
		return () => clearTimeout(t);
	}, [open, view]);

	const toChat = () => setView("chat");

	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
			modal={false}
			className="w-[560px] max-w-[calc(100vw-24px)]"
			title={
				<span className="flex items-center gap-3">
					<EvryBot size="md" mood={mood} />
					Evry
				</span>
			}
			description="Reads and drafts. You approve every change."
			actions={
				<Tooltip content={view === "history" ? "Back to chat" : "History"}>
					<IconButton
						icon={Clock01Icon}
						label="History"
						size="sm"
						aria-pressed={view === "history"}
						onClick={() => setView((v) => (v === "history" ? "chat" : "history"))}
					/>
				</Tooltip>
			}
			footer={
				view === "chat" ? (
					<Composer
						ref={composer}
						draft={draft}
						setDraft={setDraft}
						busy={c.state.activeTurnId !== null}
						stopping={c.state.stopping}
						disabled={c.load !== "ready"}
						onSend={(text, references) => c.send(text, references)}
						onStop={() => void c.cancel()}
						suggestions={c.state.conversation || c.state.sends.length ? [] : suggestionsFor(inPlant)}
					/>
				) : undefined
			}
		>
			{view === "history" ? (
				<History
					current={c.state.conversation?.id ?? null}
					onNew={() => {
						c.newChat();
						toChat();
					}}
					onSelect={(id) => {
						toChat();
						void c.select(id);
					}}
				/>
			) : (
				<Chat c={c} onEdit={(s) => (c.discard(s.key), setDraft(s.text), composer.current?.focus())} />
			)}
		</Sheet>
	);
}

const suggestionsFor = (inPlant: boolean) =>
	inPlant ? ["Who is in this church?", "What can you help with?"] : ["What can you help with?"];

// ---------------------------------------------------------------------------------------------------------------
// Chat

type Model = ReturnType<typeof useConversation>;

function Chat({ c, onEdit }: { c: Model; onEdit: (send: Send) => void }) {
	const end = useRef<HTMLDivElement>(null);
	const { turns, state } = c;
	const lastTurn = turns.at(-1);

	// Keep the newest message in view while Evry answers, unless the person scrolled up to read.
	const size = state.events.length + state.sends.length;
	useEffect(() => {
		const el = end.current;
		const box = el?.parentElement?.parentElement;
		if (!el || !box) return;
		if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) el.scrollIntoView({ block: "end" });
	}, [size]);

	if (c.load === "idle" || c.load === "loading")
		return (
			<div aria-busy="true" className="flex flex-col gap-4">
				<span className="sr-only">Loading your conversation</span>
				<Skeleton width="60%" height={40} className="self-end" />
				<Skeleton width="85%" />
				<Skeleton width="70%" />
			</div>
		);
	if (c.load === "failed")
		return (
			<StatePanel
				tone="error"
				title="Evry could not open your conversation"
				headingLevel="h3"
				actions={
					<Button size="sm" onClick={() => void c.reload()}>
						Try again
					</Button>
				}
			>
				Check your connection and try again.
			</StatePanel>
		);
	if (!turns.length && !state.sends.length)
		return (
			<div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
				<EvryBot size="lg" />
				<h3 className="font-title text-title-sm leading-[1.2] tracking-[-0.02em] text-ink">Ask Evry</h3>
				<p className="max-w-[340px] text-pretty text-text-2">
					Evry reads the records you can see and answers with the sources it used. It never changes anything
					without your approval.
				</p>
			</div>
		);

	return (
		<div className="flex flex-col gap-4">
			<ol className="flex flex-col gap-4" aria-label="Messages">
				{turns.map((turn) => (
					<TurnView
						key={turn.id}
						turn={turn}
						active={turn.id === state.activeTurnId}
						stopping={state.stopping}
						canRetry={turn === lastTurn && retryable(state, turns)}
						retrying={c.retrying}
						onRetry={() => void c.retry(turn.id)}
					/>
				))}
				{state.sends.map((s) => (
					<SendView key={s.key} send={s} onResend={() => c.resend(s)} onEdit={() => onEdit(s)} />
				))}
			</ol>
			{c.stream === "reconnecting" ? (
				<p role="status" className="text-center text-sm text-text-3">
					Reconnecting…
				</p>
			) : null}
			{c.stream === "lost" && state.activeTurnId ? (
				<div role="alert" className="flex items-center gap-3 rounded-md bg-surface-2 px-4 py-3 text-sm text-text-2">
					<Icon icon={WifiDisconnected01Icon} size={16} className="flex-none text-text-3" />
					<span className="flex-1">The connection to Evry was lost. Evry keeps working on the answer.</span>
					<Button size="sm" variant="outline" onClick={c.reconnect}>
						Reconnect
					</Button>
				</div>
			) : null}
			{c.problem ? (
				<p role="alert" className="text-sm text-magenta-600">
					{c.problem}
				</p>
			) : null}
			<Announcer turns={turns} active={state.activeTurnId} />
			<div ref={end} />
		</div>
	);
}

function UserBubble({ children, muted }: { children: ReactNode; muted?: boolean }) {
	return (
		<div
			className={cn(
				"max-w-[85%] self-end rounded-card bg-ink px-[15px] py-[11px] whitespace-pre-wrap text-on-ink",
				muted && "opacity-70",
			)}
		>
			{children}
		</div>
	);
}

function TurnView({
	turn,
	active,
	stopping,
	canRetry,
	retrying,
	onRetry,
}: {
	turn: Turn;
	active: boolean;
	stopping: boolean;
	canRetry: boolean;
	retrying: boolean;
	onRetry: () => void;
}) {
	const notice = endNotice(turn.end);
	const waiting = active && !turn.blocks.length;
	const hasAnswer = turn.blocks.length > 0 || waiting || notice;
	return (
		<li className="flex flex-col gap-4">
			{turn.ask ? (
				turn.ask.retried ? (
					<p className="self-center text-xs text-text-3">You tried again</p>
				) : (
					<UserBubble>
						<span className="sr-only">You: </span>
						{turn.ask.text}
					</UserBubble>
				)
			) : null}
			{hasAnswer ? (
				<div className="flex gap-2.5">
					<span className="grid size-[30px] flex-none place-items-center">
						<EvryBot size="md" mood={waiting ? "thinking" : active ? "talking" : "idle"} />
					</span>
					<div className="flex min-w-0 flex-1 flex-col gap-3 pt-1 leading-[1.55] text-ink-2">
						<span className="sr-only">Evry: </span>
						{turn.blocks.map((block) =>
							block.kind === "text" ? (
								block.withheld ? (
									<p key={block.sequence} className="text-sm text-text-3 italic">
										This part of the answer used a record that is no longer available.
									</p>
								) : (
									<p key={block.sequence} className="whitespace-pre-wrap">
										{block.text}
									</p>
								)
							) : block.kind === "result" ? (
								<ResultCard
									key={block.sequence}
									operation={block.operation}
									result={block.result}
									originalTotal={block.originalTotal}
								/>
							) : (
								<ReviewSlot key={block.sequence} proposalId={block.proposalId} target={block.target} />
							),
						)}
						{waiting ? (
							<p className="text-text-3">{stopping ? "Stopping…" : "Reading…"}</p>
						) : active && stopping ? (
							<p className="text-sm text-text-3">Stopping…</p>
						) : null}
						{notice ? (
							<div
								className={cn(
									"flex flex-col gap-1 rounded-md px-4 py-3 text-sm",
									notice.tone === "error" ? "bg-magenta-50 text-magenta-600" : "bg-surface-2 text-text-2",
								)}
							>
								<p className="font-semibold text-ink">{notice.title}</p>
								<p>{notice.text}</p>
								{turn.end?.error ? (
									<p className="text-xs text-text-3">Reference {turn.end.error.correlationId.slice(0, 8)}</p>
								) : null}
								{canRetry ? (
									<Button size="sm" variant="outline" className="mt-2 self-start" loading={retrying} onClick={onRetry}>
										Try again
									</Button>
								) : null}
							</div>
						) : null}
					</div>
				</div>
			) : null}
		</li>
	);
}

function SendView({ send, onResend, onEdit }: { send: Send; onResend: () => void; onEdit: () => void }) {
	const notice = sendNotice(send);
	return (
		<li className="flex flex-col items-end gap-2">
			<UserBubble muted={send.state === "sending"}>
				<span className="sr-only">You: </span>
				{send.text}
			</UserBubble>
			{notice ? (
				<div role="alert" className="flex max-w-[85%] flex-col items-end gap-2 text-right text-sm text-magenta-600">
					<p>{notice}</p>
					<div className="flex gap-2">
						<Button size="sm" variant="ghost" onClick={onEdit}>
							Edit
						</Button>
						{resendable(send) ? (
							<Button size="sm" variant="outline" onClick={onResend}>
								Send again
							</Button>
						) : null}
					</div>
				</div>
			) : (
				<p className="text-xs text-text-3">Sending…</p>
			)}
		</li>
	);
}

/**
 * Screen readers hear when Evry starts and the whole answer once it ends, not every streamed piece. The streamed text
 * itself is not a live region.
 */
function Announcer({ turns, active }: { turns: Turn[]; active: string | null }) {
	const [message, setMessage] = useState("");
	const said = useRef<string | null>(null);
	const last = turns.at(-1);
	useEffect(() => {
		if (active) {
			if (said.current !== `start:${active}`) setMessage("Evry is answering.");
			said.current = `start:${active}`;
			return;
		}
		if (!last?.end || said.current === `end:${last.id}`) return;
		// Only a turn that ended while the panel watched is announced, not the history it opened with.
		if (said.current === `start:${last.id}`) {
			const notice = endNotice(last.end);
			setMessage(notice ? `${notice.title}. ${notice.text}` : `Evry answered: ${answerText(last)}`);
		}
		said.current = `end:${last.id}`;
	}, [active, last]);
	return (
		<div aria-live="polite" className="sr-only">
			{message}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Composer

function Composer({
	ref,
	draft,
	setDraft,
	busy,
	stopping,
	disabled,
	onSend,
	onStop,
	suggestions,
}: {
	ref: Ref<HTMLTextAreaElement>;
	draft: string;
	setDraft: (text: string) => void;
	busy: boolean;
	stopping: boolean;
	disabled: boolean;
	onSend: (text: string, references: ReturnType<typeof pageReferences>) => void;
	onStop: () => void;
	suggestions: string[];
}) {
	const pathname = usePathname();
	const [usePage, setUsePage] = useState(true);
	const page = pageReferences(pathname);
	const hint = useId();
	const text = draft.trim();
	const tooLong = draft.length > MAX_MESSAGE;
	const canSend = !disabled && !busy && text.length > 0 && !tooLong;

	const submit = (value = text) => {
		if (disabled || busy || !value || value.length > MAX_MESSAGE) return;
		onSend(value, usePage ? page : []);
		setDraft("");
	};
	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		submit();
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<form onSubmit={onSubmit} className="flex w-full flex-col gap-2.5">
			{suggestions.length ? (
				<div className="flex flex-wrap gap-2">
					{suggestions.map((s) => (
						<button
							key={s}
							type="button"
							disabled={disabled}
							onClick={() => submit(s)}
							className="min-h-[34px] rounded-pill bg-surface-2 px-3 text-sm text-ink-2 transition-[background-color] hover:bg-surface-3 disabled:opacity-45"
						>
							{s}
						</button>
					))}
				</div>
			) : null}
			{page.length ? (
				<div className="flex items-center gap-2">
					{usePage ? (
						<Tag tone="green" icon={Link01Icon}>
							Using the person on this page
						</Tag>
					) : (
						<Tag icon={Unlink01Icon}>Page not shared</Tag>
					)}
					<Button
						size="sm"
						variant="ghost"
						aria-pressed={usePage}
						onClick={() => setUsePage((v) => !v)}
						className="h-[26px] px-2 text-text-2"
					>
						{usePage ? "Don't use" : "Use page"}
					</Button>
				</div>
			) : null}
			<div className="rounded-card bg-surface-raised px-4 pt-3 pb-2.5 shadow-[0_0_0_1px_var(--ef-line-2)] focus-within:shadow-[0_0_0_2px_var(--ef-ink)]">
				<label className="sr-only" htmlFor={`${hint}-input`}>
					Message Evry
				</label>
				<textarea
					ref={ref}
					id={`${hint}-input`}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={onKeyDown}
					rows={2}
					placeholder="Ask Evry…"
					aria-describedby={hint}
					aria-invalid={tooLong || undefined}
					className="block max-h-40 min-h-12 w-full resize-none bg-transparent text-md text-ink outline-none [field-sizing:content] placeholder:text-text-3"
				/>
				<div className="mt-1 flex items-center justify-between gap-3">
					<p id={hint} className={cn("text-xs", tooLong ? "text-magenta-600" : "text-text-3")}>
						{tooLong
							? `Shorten this message to ${MAX_MESSAGE.toLocaleString()} characters (now ${draft.length.toLocaleString()}).`
							: busy
								? "Evry is answering. You can stop it."
								: "Enter sends. Shift+Enter adds a line."}
					</p>
					{busy ? (
						<Button size="sm" variant="secondary" icon={StopIcon} loading={stopping} onClick={onStop}>
							Stop
						</Button>
					) : (
						<Button
							type="submit"
							size="sm"
							variant="primary"
							icon={SentIcon}
							disabled={!canSend}
							className="w-[34px] px-0"
						>
							<span className="sr-only">Send</span>
						</Button>
					)}
				</div>
			</div>
		</form>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// History

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function when(iso: string) {
	const d = new Date(iso);
	return d.toDateString() === new Date().toDateString() ? `Today, ${TIME.format(d)}` : DAY.format(d);
}

function History({
	current,
	onNew,
	onSelect,
}: {
	current: string | null;
	onNew: () => void;
	onSelect: (id: string) => void;
}) {
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<Conversation[] | null>(null);
	const [next, setNext] = useState<number | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "failed" | "more">("loading");
	const [attempt, setAttempt] = useState(0);

	// A search waits until typing pauses, so each pause sends one request.
	useEffect(() => {
		let live = true;
		const q = search.trim();
		const t = setTimeout(
			async () => {
				setState("loading");
				const r = await api.listConversations(q, 1);
				if (!live) return;
				if (r.status !== "ok") return setState("failed");
				setQuery(q);
				setItems(r.value.items);
				setNext(r.value.next);
				setState("ready");
			},
			q === query ? 0 : 250,
		);
		return () => {
			live = false;
			clearTimeout(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [search, attempt]);

	const more = async () => {
		if (next === null) return;
		setState("more");
		const r = await api.listConversations(query, next);
		if (r.status !== "ok") return setState("failed");
		setItems((list) => [...(list ?? []), ...r.value.items]);
		setNext(r.value.next);
		setState("ready");
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<h3 className="font-semibold text-ink">History</h3>
				<Button size="sm" variant="ghost" icon={Add01Icon} onClick={onNew}>
					New chat
				</Button>
			</div>
			<SearchInput
				aria-label="Search conversations"
				placeholder="Search conversations"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
			/>
			{state === "failed" ? (
				<StatePanel
					tone="error"
					title="History could not load"
					headingLevel="h3"
					actions={
						<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
							Try again
						</Button>
					}
				>
					Check your connection and try again.
				</StatePanel>
			) : state === "loading" && !items ? (
				<div aria-busy="true" className="flex flex-col gap-3 py-2">
					<span className="sr-only">Loading history</span>
					<Skeleton width="70%" />
					<Skeleton width="55%" />
					<Skeleton width="62%" />
				</div>
			) : items && items.length === 0 ? (
				<p className="py-8 text-center text-text-2">
					{query ? `No conversations match "${query}".` : "No conversations yet. Ask Evry something to start one."}
				</p>
			) : (
				<ul aria-busy={state === "loading" || undefined} className="-mx-2 flex flex-col">
					{(items ?? []).map((item) => (
						<li key={item.id}>
							<button
								type="button"
								aria-current={item.id === current ? "true" : undefined}
								data-focus-inset=""
								onClick={() => onSelect(item.id)}
								className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-[background-color] hover:bg-hover aria-[current=true]:bg-surface-2"
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium text-ink">{item.title}</span>
									<span className="block text-xs text-text-3">{when(item.updatedAt)}</span>
								</span>
								{item.activeTurnId ? (
									<span className="flex-none text-xs text-text-3">Answering</span>
								) : null}
							</button>
						</li>
					))}
				</ul>
			)}
			{next !== null && state !== "failed" ? (
				<Button size="sm" variant="outline" className="self-center" loading={state === "more"} onClick={() => void more()}>
					Show more
				</Button>
			) : null}
		</div>
	);
}
