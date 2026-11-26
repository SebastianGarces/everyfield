"use client";

import type { AppAssetPath } from "@everyfield/contracts/common";
import {
	Add01Icon,
	Cancel01Icon,
	Clock01Icon,
	Csv01Icon,
	File02Icon,
	Image01Icon,
	Link01Icon,
	Pdf01Icon,
	SentIcon,
	StopIcon,
	Unlink01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import {
	Alert,
	Button,
	IconButton,
	ProblemText,
	RowButton,
	SearchInput,
	Sheet,
	Skeleton,
	StatePanel,
	Tooltip,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn, createDebouncer, EvryBot, Icon, useFocusRequest, type EvryMood } from "@everyfield/ui/foundations";
import { usePathname } from "next/navigation";
import {
	useCallback,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	useTransition,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
} from "react";
import { createRead, useRead } from "@/components/read";
import * as api from "./api.ts";
import { Panel } from "./panel.tsx";
import {
	churchChanged,
	DISCOVERY_STAYS,
	endNotice,
	MAX_MESSAGE,
	NOT_AVAILABLE,
	pageReferences,
	resendable,
	retryable,
	sendNotice,
	turnsOf,
	type Conversation,
	type Reference,
	type Send,
	type State,
	type Turn,
} from "./model.ts";
import { ReviewCard } from "../review/ReviewCard.tsx";
import { ChurchChanged } from "./ChurchChanged.tsx";
import { renderMarkdown } from "./view.ts";
import { ResultCard } from "./ResultCard.tsx";
import { useRowPhotos } from "./useRowPhotos.ts";
import { AttachButton, PhotoChip } from "./PhotoAttach.tsx";
import { ATTACH, fileSize, isCsv, isPdf, type Attaches, type Picked } from "./attachments.ts";
import type { Stream } from "./EvryPanel.store.ts";
import type { Church } from "../review/ReviewCard.store.ts";

const useActions = () => Panel.useSelect((s) => s.actions);

const conversations = createRead((search: string, page: number) => api.listConversations(search, page), {
	failed: () => ({ status: "lost" }) as const,
	fresh: 1_000,
});

function followEnd() {
	let stick = true;
	let pinned = -1;
	let box: HTMLElement | null = null;
	const toEnd = () => {
		if (!stick || !box) return;
		box.scrollTop = box.scrollHeight;
		pinned = box.scrollTop;
	};
	return {
		stick: () => {
			stick = true;
			toEnd();
		},
		box: (node: HTMLDivElement | null) => {
			if (!node) return;
			box = node;
			stick = true;
			const onScroll = () => {
				stick = node.scrollTop === pinned || node.scrollHeight - node.scrollTop - node.clientHeight < 80;
			};
			node.addEventListener("scroll", onScroll, { passive: true });
			const resized = new ResizeObserver(toEnd);
			resized.observe(node);
			return () => {
				node.removeEventListener("scroll", onScroll);
				resized.disconnect();
				if (box === node) box = null;
			};
		},
		content: (node: HTMLDivElement | null) => {
			if (!node) return;
			const grown = new ResizeObserver(toEnd);
			grown.observe(node);
			return () => grown.disconnect();
		},
	};
}

export function EvryPanel({
	inPlant,
	attaches,
	context,
	available,
}: {
	inPlant: boolean;
	attaches: Attaches;
	context: string;
	available: boolean;
}) {
	const actions = useActions();
	const open = Panel.useSelect((s) => s.open);
	const view = Panel.useSelect((s) => s.view);
	const chat = Panel.useSelect((s) => s.chat);
	const load = Panel.useSelect((s) => s.load);
	const pipeline = Panel.useSelect((s) => s.pipeline);
	const moved = Panel.useSelect((s) => s.churchChanged);
	const [chatVisits, setChatVisits] = useState(0);
	const [{ box, content, stick }] = useState(followEnd);
	const composer = useRef<HTMLTextAreaElement>(null);
	const requestFocus = useFocusRequest<HTMLElement>(chatVisits);
	const composerRef = useCallback(
		(node: HTMLTextAreaElement | null) => {
			composer.current = node;
			requestFocus(node);
		},
		[requestFocus],
	);
	const turns = useMemo(() => turnsOf(chat.events, chat.live), [chat.events, chat.live]);
	const last = turns.at(-1);
	const streaming = chat.activeTurnId !== null && last?.id === chat.activeTurnId;
	const mood: EvryMood = streaming ? (last.blocks.some((b) => b.kind === "text") ? "talking" : "thinking") : "idle";
	const focusComposer = () => composer.current?.focus();
	const fromDiscovery = chat.conversation?.discovery === true;

	const toChat = () => {
		actions.setView("chat");
		setChatVisits((n) => n + 1);
	};

	return (
		<Sheet
			open={open}
			onOpenChange={actions.show}
			modal={false}
			size="xl"
			bodyRef={view === "chat" ? box : undefined}
			onOpenAutoFocus={(e) => {
				if (view !== "chat") return;
				e.preventDefault();
				if (available) focusComposer();
				else if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
			}}
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
						className="aria-pressed:bg-surface-2"
						onClick={() => {
							if (view === "history") return toChat();
							conversations.prefetch("", 1);
							actions.setView("history");
						}}
					/>
				</Tooltip>
			}
			footer={
				view !== "chat" ? undefined : fromDiscovery ? (
					<div ref={requestFocus} tabIndex={-1} className="flex w-full flex-col items-start gap-3 outline-none">
						<div className="flex flex-col gap-1">
							<p className="font-medium text-ink">{DISCOVERY_STAYS.title}</p>
							<p className="text-pretty text-sm text-text-2">{DISCOVERY_STAYS.text}</p>
						</div>
						{available ? (
							<Button
								size="sm"
								variant="primary"
								icon={Add01Icon}
								onClick={() => {
									actions.newChat();
									toChat();
								}}
							>
								New chat
							</Button>
						) : null}
					</div>
				) : !available ? (
					chat.events.length ? (
						<div ref={requestFocus} tabIndex={-1} className="flex w-full flex-col gap-1 outline-none">
							<p className="font-medium text-ink">{NOT_AVAILABLE}</p>
							<p className="text-pretty text-sm text-text-2">
								You can still read past conversations and finish open reviews.
							</p>
						</div>
					) : undefined
				) : (
					<Composer
						ref={composerRef}
						busy={chat.activeTurnId !== null}
						stopping={chat.stopping}
						disabled={load !== "ready" || moved}
						conversationId={chat.conversation?.id ?? null}
						inPlant={inPlant}
						attaches={attaches}
						onSend={(text, references) => {
							stick();
							actions.send(text, references, context);
							focusComposer();
						}}
						onStop={() => {
							actions.cancel();
							focusComposer();
						}}
						suggestions={chat.conversation || chat.sends.length ? [] : suggestionsFor(inPlant, pipeline)}
					/>
				)
			}
		>
			<Following>
				{(stream) =>
					view === "history" ? (
						<History
							available={available}
							current={chat.conversation?.id ?? null}
							onNew={() => {
								actions.newChat();
								toChat();
							}}
							onSelect={(id) => {
								toChat();
								actions.select(id);
							}}
						/>
					) : (
						<Chat
							available={available}
							stream={stream}
							turns={turns}
							contentRef={content}
							focusComposer={focusComposer}
							onEdit={(s) => {
								actions.edit(s);
								focusComposer();
							}}
						/>
					)
				}
			</Following>
		</Sheet>
	);
}

const suggestionsFor = (inPlant: boolean, pipeline: boolean) =>
	inPlant
		? ["List the people in this church", "What can you help with?"]
		: pipeline
			? ["Who hasn't moved in six months?", "What can you help with?"]
			: ["What can you help with?"];

function Following({ children }: { children: (stream: Stream) => ReactNode }) {
	const actions = useActions();
	const panel = Panel.useStoreApi();
	const stream = useSyncExternalStore(
		actions.followStream,
		() => panel.getState().stream,
		() => "idle" as const,
	);
	return children(stream);
}

function Chat({
	available,
	stream,
	turns,
	contentRef,
	onEdit,
	focusComposer,
}: {
	available: boolean;
	stream: Stream;
	turns: Turn[];
	contentRef: (node: HTMLDivElement | null) => (() => void) | undefined;
	onEdit: (send: Send) => void;
	focusComposer: () => void;
}) {
	const actions = useActions();
	const state = Panel.useSelect((s) => s.chat);
	const load = Panel.useSelect((s) => s.load);
	const moved = Panel.useSelect((s) => s.churchChanged);
	const photos = useRowPhotos(turns, moved);
	const problem = Panel.useSelect((s) => s.problem);
	const churchNotice = Panel.useSelect((s) => s.churchNotice);
	const retrying = Panel.useSelect((s) => s.retrying);
	const announcement = Panel.useSelect((s) => s.announcement);
	const lastTurn = turns.at(-1);
	const hasMessages = turns.length > 0 || state.sends.length > 0;

	if (load === "idle" || load === "loading")
		return (
			<div aria-busy="true" className="flex flex-col gap-4">
				<span className="sr-only">Loading your conversation</span>
				<Skeleton width="60%" height={40} className="self-end" />
				<Skeleton width="85%" />
				<Skeleton width="70%" />
			</div>
		);
	if (load === "failed")
		return (
			<StatePanel
				tone="error"
				title="Evry could not open your conversation"
				headingLevel="h3"
				actions={
					<Button size="sm" onClick={actions.reload}>
						Try again
					</Button>
				}
			>
				Check your connection and try again.
			</StatePanel>
		);
	if (!hasMessages)
		return (
			<div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
				<EvryBot size="lg" />
				<h3 className="font-title text-title-sm leading-[1.2] tracking-[-0.02em] text-ink">
					{available ? "Ask Evry" : NOT_AVAILABLE}
				</h3>
				<p className="max-w-[340px] text-pretty text-text-2">
					{available
						? "Evry reads the records you can see and answers with the sources it used. It never changes anything without your approval."
						: "When it's ready, you can ask questions here."}
				</p>
				{problem ? <Alert role="alert">{problem}</Alert> : null}
				{churchNotice ? (
					<ChurchChanged className="w-full text-left" onReload={() => actions.reloadForChurch()}>
						{churchNotice}
					</ChurchChanged>
				) : null}
			</div>
		);

	return (
		<div ref={contentRef} className="flex flex-col gap-4">
			<ol className="flex flex-col gap-4" aria-label="Messages">
				{turns.map((turn) => (
					<TurnView
						key={turn.id}
						turn={turn}
						active={turn.id === state.activeTurnId}
						stopping={state.stopping}
						canRetry={
							available && turn === lastTurn && !moved && !state.conversation?.discovery && retryable(state, turns)
						}
						retrying={retrying}
						reviews={state.reviews}
						photos={photos}
						onRetry={() => {
							actions.retry(turn.id);
							focusComposer();
						}}
					/>
				))}
				{state.sends.map((s) => (
					<SendView
						key={s.key}
						send={s}
						onResend={() => {
							actions.resend(s);
							focusComposer();
						}}
						onEdit={() => onEdit(s)}
					/>
				))}
			</ol>
			{stream === "reconnecting" ? (
				<p role="status" className="text-center text-sm text-text-3">
					Reconnecting…
				</p>
			) : null}
			{stream === "lost" && state.activeTurnId ? (
				<Alert
					role="alert"
					tone="warning"
					icon={WifiDisconnected01Icon}
					actions={
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								actions.reconnect();
								focusComposer();
							}}
						>
							Reconnect
						</Button>
					}
				>
					The connection to Evry was lost. Evry keeps working on the answer.
				</Alert>
			) : null}
			{problem ? <Alert role="alert">{problem}</Alert> : null}
			{churchNotice ? <ChurchChanged onReload={() => actions.reloadForChurch()}>{churchNotice}</ChurchChanged> : null}
			<div aria-live="polite" className="sr-only">
				{announcement}
			</div>
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
	reviews,
	photos,
	onRetry,
}: {
	turn: Turn;
	active: boolean;
	stopping: boolean;
	canRetry: boolean;
	retrying: boolean;
	reviews: State["reviews"];
	photos: Readonly<Record<string, AppAssetPath>>;
	onRetry: () => void;
}) {
	const panel = Panel.useStoreApi();
	const [church] = useState<Church>(() => ({
		changed: () => panel.getState().churchChanged,
		refused: (id) => panel.getState().churchRefused === id,
		leave: (id) => panel.getState().actions.leaveChurch(id),
		reload: () => panel.getState().actions.reloadForChurch(),
		converted: () => panel.getState().actions.leaveDiscovery(),
	}));
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
						<SentFiles files={turn.ask.attachments} />
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
						{turn.blocks.map((block, index) =>
							block.kind === "text" ? (
								block.withheld ? (
									<p key={block.sequence} className="text-sm text-text-3 italic">
										This part of the answer used a record that is no longer available.
									</p>
								) : (
									<div key={block.sequence} className="flex flex-col gap-3">
										{renderMarkdown(block.text, active && !turn.end && index === turn.blocks.length - 1)}
									</div>
								)
							) : block.kind === "result" ? (
								<ResultCard
									key={block.sequence}
									operation={block.operation}
									result={block.result}
									originalTotal={block.originalTotal}
									photos={photos}
								/>
							) : (
								<ReviewCard
									key={block.sequence}
									proposalId={block.proposalId}
									target={block.target}
									seed={reviews[block.proposalId]}
									church={church}
								/>
							),
						)}
						{waiting ? (
							<p className="text-text-3">{stopping ? "Stopping…" : "Reading…"}</p>
						) : active && stopping ? (
							<p className="text-sm text-text-3">Stopping…</p>
						) : null}
						{notice ? (
							<Alert
								tone={notice.tone}
								title={notice.title}
								actions={
									canRetry ? (
										<Button size="sm" variant="outline" loading={retrying} onClick={onRetry}>
											Try again
										</Button>
									) : undefined
								}
							>
								<p>{notice.text}</p>
								{turn.end?.error ? (
									<p className="text-xs text-text-3">Reference {turn.end.error.correlationId.slice(0, 8)}</p>
								) : null}
							</Alert>
						) : null}
					</div>
				</div>
			) : null}
		</li>
	);
}

function SendView({ send, onResend, onEdit }: { send: Send; onResend: () => void; onEdit: () => void }) {
	const churchName = Panel.useSelect((s) => s.churchName);
	const actions = useActions();
	const notice = sendNotice(send, churchName);
	return (
		<li className="flex flex-col items-end gap-2">
			<UserBubble muted={send.state === "sending"}>
				<span className="sr-only">You: </span>
				{send.text}
				<SentFiles files={send.attachments} />
			</UserBubble>
			{churchChanged(send) ? (
				<ChurchChanged className="w-full" onReload={() => actions.reloadForChurch(send)}>
					Reload to use Evry for your new church. Your message comes with you, ready to send.
				</ChurchChanged>
			) : notice ? (
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

const USING: Record<Reference["kind"], string> = {
	article: "Using the article on this page",
	person: "Using the person on this page",
	photo: "Using this page",
	page: "Using this page",
};

function Composer({
	ref,
	busy,
	stopping,
	disabled,
	conversationId,
	inPlant,
	attaches,
	onSend,
	onStop,
	suggestions,
}: {
	ref: Ref<HTMLTextAreaElement>;
	busy: boolean;
	stopping: boolean;
	disabled: boolean;
	conversationId: string | null;
	inPlant: boolean;
	attaches: Attaches;
	onSend: (text: string, references: Reference[]) => void;
	onStop: () => void;
	suggestions: string[];
}) {
	const actions = useActions();
	const panel = Panel.useStoreApi();
	const draft = Panel.useSelect((s) => s.draft);
	const photo = Panel.useSelect((s) => s.photo);
	const files = Panel.useSelect((s) => s.files);
	const fileNotice = Panel.useSelect((s) => s.fileNotice);
	const pathname = usePathname();
	const [usePage, setUsePage] = useState(true);
	const page = pageReferences(pathname, inPlant);
	const hint = useId();
	const text = draft.trim();
	const tooLong = draft.length > MAX_MESSAGE;
	const shown = files.filter((p) => p.conversationId === null || p.conversationId === conversationId);
	const uploading = files.some((p) => p.state === "uploading");
	const canSend = !disabled && !busy && text.length > 0 && !tooLong && !uploading && photo?.status !== "uploading";

	const submit = (chosen?: string) => {
		const { draft: now, photo: attached, files: picked } = panel.getState();
		const value = chosen ?? now.trim();
		if (
			disabled ||
			busy ||
			!value ||
			value.length > MAX_MESSAGE ||
			attached?.status === "uploading" ||
			picked.some((p) => p.state === "uploading")
		)
			return;
		const photos =
			attached?.status === "ready" && attached.avatarId ? [{ kind: "photo" as const, id: attached.avatarId }] : [];
		onSend(value, [...(usePage ? page : []), ...photos]);
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
							{USING[page[0]?.kind ?? "page"]}
						</Tag>
					) : (
						<Tag icon={Unlink01Icon}>Page left out</Tag>
					)}
					<Button size="sm" variant="ghost" onClick={() => setUsePage((v) => !v)} className="text-text-2">
						{usePage ? "Leave out" : "Include page"}
					</Button>
				</div>
			) : null}
			<div
				onDragOver={(e) => {
					if (attaches !== "photo" && !disabled && !busy && e.dataTransfer.types.includes("Files")) e.preventDefault();
				}}
				onDrop={(e) => {
					if (attaches === "photo" || disabled || busy || !e.dataTransfer.files.length) return;
					e.preventDefault();
					actions.addFiles([...e.dataTransfer.files], attaches);
				}}
				className={cn(
					"rounded-card bg-surface-raised px-4 pt-3 pb-2.5 shadow-[0_0_0_1px_var(--ef-line-2)] transition-[box-shadow] duration-150",
					tooLong
						? "shadow-[0_0_0_1px_var(--ef-magenta-500)]"
						: "focus-within:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]",
				)}
			>
				{shown.length || photo ? (
					<ul aria-label="Attached files" className="mb-2 flex flex-wrap gap-2">
						{photo ? <PhotoChip photo={photo} onRemove={actions.clearPhoto} /> : null}
						{shown.map((p) => (
							<FileChip key={p.key} file={p} onRemove={() => actions.removeFile(p.key)} />
						))}
					</ul>
				) : null}
				<label className="sr-only" htmlFor={`${hint}-input`}>
					Message Evry
				</label>
				<textarea
					ref={ref}
					id={`${hint}-input`}
					value={draft}
					onChange={(e) => actions.write(e.target.value)}
					onKeyDown={onKeyDown}
					rows={2}
					placeholder="Ask Evry…"
					aria-describedby={hint}
					aria-invalid={tooLong || undefined}
					className="block max-h-40 min-h-12 w-full resize-none bg-transparent text-md text-ink outline-none [field-sizing:content] placeholder:text-text-3"
				/>
				<div className="mt-1 flex items-center justify-between gap-3">
					{tooLong || fileNotice ? (
						<ProblemText id={hint} live={fileNotice ? "alert" : "region"}>
							{tooLong
								? `Shorten this message to ${MAX_MESSAGE.toLocaleString()} characters (now ${draft.length.toLocaleString()}).`
								: fileNotice}
						</ProblemText>
					) : (
						<p id={hint} className="text-xs text-text-3">
							{busy
								? "Evry is answering. You can stop it."
								: uploading || photo?.status === "uploading"
									? "Attaching the file…"
									: shown.length
										? "Say what Evry should do with the file."
										: photo?.status === "ready"
											? "Say what Evry should do with the photo."
											: "Enter sends. Shift+Enter adds a line."}
						</p>
					)}
					<div className="flex flex-none items-center gap-1">
						<AttachButton
							disabled={disabled || busy}
							attaches={attaches}
							onFiles={(picked) => actions.addFiles(picked, attaches)}
						/>
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
								className="w-[34px]"
							>
								<span className="sr-only">Send</span>
							</Button>
						)}
					</div>
				</div>
			</div>
		</form>
	);
}

const fileIcon = (name: string) =>
	ATTACH.photoName.test(name) ? Image01Icon : isPdf(name) ? Pdf01Icon : isCsv(name) ? Csv01Icon : File02Icon;

function FileChip({ file, onRemove }: { file: Picked; onRemove: () => void }) {
	return (
		<li
			className={cn(
				"flex h-[34px] max-w-full items-center gap-2 rounded-pill bg-surface-2 py-1 pr-1 pl-3 text-sm",
				file.state === "failed" && "bg-magenta-50",
			)}
		>
			<Icon icon={fileIcon(file.name)} size={16} className="flex-none text-text-2" />
			<span className="min-w-0 truncate text-ink">{file.name}</span>
			<span className={cn("flex-none text-xs", file.state === "failed" ? "text-magenta-600" : "text-text-3")}>
				{file.state === "uploading" ? "Attaching…" : file.state === "failed" ? "Couldn't attach" : fileSize(file.size)}
			</span>
			<IconButton
				icon={Cancel01Icon}
				label={`Remove ${file.name}`}
				size="sm"
				className="size-[26px]"
				onClick={onRemove}
			/>
		</li>
	);
}

function SentFiles({ files }: { files: readonly { id: string; name: string }[] }) {
	if (!files.length) return null;
	return (
		<ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1.5">
			{files.map((f) => (
				<li key={f.id} className="flex items-center gap-1.5 rounded-pill bg-white/12 px-2.5 py-1 text-sm">
					<Icon icon={fileIcon(f.name)} size={16} className="flex-none" />
					<span className="min-w-0 truncate">{f.name}</span>
				</li>
			))}
		</ul>
	);
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function when(iso: string) {
	const d = new Date(iso);
	return d.toDateString() === new Date().toDateString() ? `Today, ${TIME.format(d)}` : DAY.format(d);
}

function History({
	available,
	current,
	onNew,
	onSelect,
}: {
	available: boolean;
	current: string | null;
	onNew: () => void;
	onSelect: (id: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [more, setMore] = useState<{
		items: Conversation[];
		next: number | null;
		status: "loading" | "ready" | "failed";
	} | null>(null);
	const [pause] = useState(() => createDebouncer(250));
	const [searching, startSearch] = useTransition();
	const asked = useRef("");
	const discoveryGroup = useId();
	const first = useRead(conversations, query, 1);
	const page = first.value?.status === "ok" ? first.value.value : null;
	const failed = (first.value !== undefined && page === null) || more?.status === "failed";
	const items = page ? [...page.items, ...(more?.items ?? [])] : null;
	const next = more ? more.next : (page?.next ?? null);
	const loading = first.status === "loading" || searching;

	const search = (value: string) => {
		const q = value.trim();
		asked.current = q;
		pause.run(() =>
			startSearch(async () => {
				await conversations.get(q, 1);
				if (asked.current !== q) return;
				startSearch(() => {
					setQuery(q);
					setMore(null);
				});
			}),
		);
	};

	const tryAgain = () => {
		setMore(null);
		if (page) first.reload();
		else first.retry();
	};

	const showMore = async () => {
		if (next === null || !items) return;
		const shown = more?.items ?? [];
		setMore({ items: shown, next, status: "loading" });
		const r = await api.listConversations(query, next);
		setMore(
			r.status === "ok"
				? { items: [...shown, ...r.value.items], next: r.value.next, status: "ready" }
				: { items: shown, next, status: "failed" },
		);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<h3 className="font-body text-md font-semibold text-ink">History</h3>
				{available ? (
					<Button size="sm" variant="ghost" icon={Add01Icon} onClick={onNew}>
						New chat
					</Button>
				) : null}
			</div>
			<SearchInput
				aria-label="Search conversations"
				placeholder="Search conversations"
				onChange={(e) => search(e.target.value)}
			/>
			{failed ? (
				<StatePanel
					tone="error"
					title="History could not load"
					headingLevel="h3"
					actions={
						<Button size="sm" onClick={tryAgain}>
							Try again
						</Button>
					}
				>
					Check your connection and try again.
				</StatePanel>
			) : !items ? (
				<div aria-busy="true" className="flex flex-col gap-3 py-2">
					<span className="sr-only">Loading history</span>
					<Skeleton width="70%" />
					<Skeleton width="55%" />
					<Skeleton width="62%" />
				</div>
			) : items && items.length === 0 ? (
				<p className="py-8 text-center text-text-2">
					{query
						? `No conversations match "${query}".`
						: available
							? "No conversations yet. Ask Evry something to start one."
							: "No conversations yet."}
				</p>
			) : (
				<>
					<Conversations
						items={items.filter((item) => !item.discovery)}
						current={current}
						busy={loading}
						onSelect={onSelect}
					/>
					{items.some((item) => item.discovery) ? (
						<section aria-labelledby={discoveryGroup} className="flex flex-col gap-1 pt-2">
							<h4 id={discoveryGroup} className="font-body text-sm font-semibold text-ink">
								From Discovery
							</h4>
							<p className="text-xs text-text-3">{"Read-only. New chats with Evry don't use them."}</p>
							<Conversations
								items={items.filter((item) => item.discovery)}
								current={current}
								busy={loading}
								onSelect={onSelect}
							/>
						</section>
					) : null}
				</>
			)}
			{next !== null && !failed ? (
				<Button
					size="sm"
					variant="outline"
					className="self-center"
					loading={more?.status === "loading"}
					onClick={() => void showMore()}
				>
					Show more
				</Button>
			) : null}
		</div>
	);
}

function Conversations({
	items,
	current,
	busy,
	onSelect,
}: {
	items: Conversation[];
	current: string | null;
	busy: boolean;
	onSelect: (id: string) => void;
}) {
	if (!items.length) return null;
	return (
		<ul aria-busy={busy || undefined} className="-mx-2 flex flex-col">
			{items.map((item) => (
				<li key={item.id}>
					<RowButton
						aria-current={item.id === current ? "true" : undefined}
						data-focus-inset=""
						onClick={() => onSelect(item.id)}
						className="min-h-11 items-center gap-3 rounded-md px-2 py-2.5 aria-[current=true]:bg-surface-2"
					>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm font-medium text-ink">{item.title}</span>
							<span className="block text-xs text-text-3">{when(item.updatedAt)}</span>
						</span>
						{item.activeTurnId ? <span className="flex-none text-xs text-text-3">Answering</span> : null}
					</RowButton>
				</li>
			))}
		</ul>
	);
}
