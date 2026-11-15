import { createStore, type StoreApi } from "zustand/vanilla";
import type * as api from "./api.ts";
import {
	answerText,
	cursor,
	EMPTY,
	endNotice,
	merge,
	mergeLive,
	opened,
	turnsOf,
	type Conversation,
	type ConversationEvent,
	type ProjectedError,
	type ReadConversation,
	type Reference,
	type Send,
	type State,
} from "./model.ts";
import type { Attached } from "./PhotoAttach.tsx";

export type Load = "idle" | "loading" | "ready" | "failed";
export type Stream = "idle" | "live" | "reconnecting" | "lost";
export type View = "chat" | "history";

export type EvryPort = Pick<
	typeof api,
	"openLatest" | "readConversation" | "createConversation" | "submitTurn" | "retryTurn" | "cancelTurn" | "streamUrl"
> & {
	checkPhoto: (file: File) => Attached | null;
	stagePhoto: (file: File, src: string) => Promise<Attached>;
};

export type EvryPanelState = {
	open: boolean;
	view: View;
	draft: string;
	startedIn: string;
	photo: Attached | null;
	chat: State;
	load: Load;
	pipeline: boolean;
	stream: Stream;
	retrying: boolean;
	problem: string | null;
	announcement: string;
	actions: {
		show: (open: boolean) => void;
		shortcut: (off: boolean) => void;
		setView: (view: View) => void;
		write: (draft: string) => void;
		send: (text: string, references: Reference[], context: string) => void;
		resend: (send: Send) => void;
		edit: (send: Send) => void;
		attach: (file: File) => void;
		clearPhoto: () => void;
		reload: () => void;
		cancel: () => void;
		retry: (turnId: string) => void;
		reconnect: () => void;
		followStream: (listener: () => void) => () => void;
		select: (conversationId: string) => void;
		newChat: () => void;
		seen: (proposalId: string) => void;
	};
};

export type EvryPanelStore = StoreApi<EvryPanelState>;

const KINDS = ["user_message", "assistant_text", "tool_result", "status"] as const;

async function readAll(
	port: EvryPort,
	id: string,
	wanted: () => boolean,
	first?: ReadConversation,
): Promise<api.Reply<ReadConversation>> {
	let read = first;
	if (!read) {
		const r = await port.readConversation(id);
		if (r.status !== "ok") return r;
		read = r.value;
	}
	while (read.more) {
		if (!wanted()) return { status: "lost" };
		const next = await port.readConversation(id, read.events.at(-1)?.sequence ?? 0);
		if (next.status !== "ok") return next;
		read.events.push(...next.value.events);
		Object.assign(read.reviews, next.value.reviews);
		read.more = next.value.more;
		read.run = next.value.run;
	}
	return { status: "ok", value: read };
}

export function createEvryPanelStore(init: { context: string; port: EvryPort }): EvryPanelStore {
	const { port } = init;
	let createKey: string | null = null;
	const retryKeys = new Map<string, string>();
	let shown = 0;
	let photoRun = 0;
	let said: string | null = null;
	let source: EventSource | null = null;
	let following: string | null = null;
	let readers = 0;
	let unwatch = () => {};

	const store = createStore<EvryPanelState>()((set, get, api) => {
		const watching = () => get().open && get().view === "chat";

		const announce = (chat: State): string | null => {
			if (chat.activeTurnId) {
				if (said === `start:${chat.activeTurnId}`) return null;
				said = `start:${chat.activeTurnId}`;
				return "Evry is answering.";
			}
			if (!said?.startsWith("start:")) return null;
			const last = turnsOf(chat.events, chat.live).at(-1);
			if (!last?.end) return null;
			const watched = said === `start:${last.id}`;
			said = `end:${last.id}`;
			if (!watched) return null;
			const notice = endNotice(last.end);
			return notice ? `${notice.title}. ${notice.text}` : `Evry answered: ${answerText(last)}`;
		};

		const watchAgain = () => {
			said = null;
			const chat = get().chat;
			if (!chat.activeTurnId) {
				const last = turnsOf(chat.events, chat.live).at(-1);
				said = last?.end ? `end:${last.id}` : null;
			}
			set({ announcement: announce(chat) ?? "" });
		};

		const update = (change: (chat: State) => State, extra: Partial<EvryPanelState> = {}) => {
			const chat = change(get().chat);
			const announcement = watching() ? announce(chat) : null;
			set({ ...extra, chat, ...(announcement === null ? {} : { announcement }) });
		};

		const dropPhoto = () => {
			photoRun++;
			const src = get().photo?.src;
			if (src) URL.revokeObjectURL(src);
			set({ photo: null });
		};

		const openState = (next: State) => {
			said = null;
			update(() => next, { problem: null });
		};

		const stopped = (error: ProjectedError) => {
			if (error.outcome !== "refused") return set({ stream: "lost" });
			update((chat) => ({ ...chat, activeTurnId: null, stopping: false }), {
				stream: "idle",
				problem:
					error.code === "access_denied" || error.code === "not_found"
						? "Your access changed, so Evry stopped. Nothing was changed."
						: "Evry stopped. Nothing was changed.",
			});
		};

		const settle = async (conversationId: string) => {
			const r = await port.readConversation(conversationId, cursor(get().chat));
			if (get().chat.conversation?.id !== conversationId) return;
			if (r.status === "refused") return stopped(r.error);
			if (r.status === "lost") return set({ stream: "lost" });
			update((chat) => merge(chat, r.value.events));
			if (r.value.run) set({ stream: "lost" });
			else update((chat) => ({ ...chat, activeTurnId: null, stopping: false }));
		};

		const catchUp = async (conversationId: string) => {
			const r = await port.readConversation(conversationId, cursor(get().chat));
			if (r.status !== "ok" || get().chat.conversation?.id !== conversationId) return;
			update((chat) => merge(chat, r.value.events));
			if (!r.value.run) update((chat) => ({ ...chat, activeTurnId: null, stopping: false }));
		};

		const fail = (send: Send, reply: api.Reply<unknown>) =>
			patchSend(
				send.key,
				reply.status === "refused" ? { state: "refused", error: reply.error } : { state: "unconfirmed", error: null },
			);

		const patchSend = (key: string, patch: Partial<Send>) =>
			update((chat) => {
				const saved = new Set(chat.events.map((e) => e.sequence));
				const sends = chat.sends
					.map((s) => (s.key === key ? { ...s, ...patch } : s))
					.filter((s) => s.sequence === null || !saved.has(s.sequence));
				return { ...chat, sends };
			});

		const deliver = async (send: Send) => {
			const view = shown;
			const here = () => shown === view;
			patchSend(send.key, { state: "sending", error: null });
			let conversation: Conversation | null = get().chat.conversation;
			if (!conversation) {
				const key = (createKey ??= crypto.randomUUID());
				const created = await port.createConversation(key);
				if (!here())
					return void (
						created.status === "ok" && port.submitTurn(created.value.id, send.key, send.text, send.references)
					);
				if (created.status !== "ok") return fail(send, created);
				if (createKey === key) createKey = null;
				const made = created.value;
				conversation = made;
				update((chat) => ({ ...chat, conversation: made }));
			}
			const r = await port.submitTurn(conversation.id, send.key, send.text, send.references);
			if (!here()) return;
			if (r.status !== "ok") return fail(send, r);
			patchSend(send.key, { sequence: r.value.sequence });
			const ended = get().chat.events.some((e) => e.kind === "status" && e.turnId === r.value.turnId);
			if (!ended) update((chat) => ({ ...chat, activeTurnId: r.value.turnId }));
		};

		const follow = () => {
			const { chat } = get();
			const id = chat.conversation?.id;
			const wanted = readers > 0 && id && chat.activeTurnId !== null ? id : null;
			if (wanted === following) return;
			following = wanted;
			if (source) {
				source.close();
				source = null;
				set({ stream: "idle" });
			}
			if (!wanted) return;
			const next = new EventSource(port.streamUrl(wanted, cursor(chat)));
			source = next;
			const current = () => source === next;
			const onEvent = (e: MessageEvent<string>) => {
				if (current()) update((c) => merge(c, [JSON.parse(e.data) as ConversationEvent]));
			};
			for (const kind of KINDS) next.addEventListener(kind, onEvent);
			next.addEventListener("live", (e) => {
				if (!current()) return;
				const { turnId, offset, text } = JSON.parse((e as MessageEvent<string>).data) as {
					turnId: string;
					offset: number;
					text: string;
				};
				update((c) => mergeLive(c, turnId, offset, text));
			});
			next.onopen = () => {
				if (current()) set({ stream: "live" });
			};
			next.addEventListener("idle", () => {
				next.close();
				if (current()) update((c) => ({ ...c, activeTurnId: null, stopping: false }), { stream: "idle" });
			});
			next.addEventListener("error", (e) => {
				if (!current()) return;
				if (e instanceof MessageEvent) {
					next.close();
					return stopped(JSON.parse(e.data) as ProjectedError);
				}
				if (next.readyState === EventSource.CLOSED) {
					next.close();
					return void settle(wanted);
				}
				set({ stream: "reconnecting" });
			});
		};

		const reload = async () => {
			const mine = ++shown;
			set({ load: "loading" });
			const latest = await port.openLatest();
			if (latest.status === "ok") set({ pipeline: latest.value.pipeline === true });
			const r =
				latest.status === "ok" && latest.value.conversation
					? await readAll(port, latest.value.conversation.id, () => mine === shown, latest.value as ReadConversation)
					: latest;
			if (mine !== shown) return;
			if (r.status !== "ok") return set({ load: "failed" });
			openState(r.value.conversation ? opened(r.value as ReadConversation) : EMPTY);
			set({ load: "ready" });
		};

		const show = (open: boolean) => {
			if (open === get().open) return;
			if (!open) dropPhoto();
			set({ open });
			if (open) {
				watchAgain();
				if (get().load === "idle") void reload();
			}
		};

		return {
			open: false,
			view: "chat",
			draft: "",
			startedIn: init.context,
			photo: null,
			chat: EMPTY,
			load: "idle",
			pipeline: false,
			stream: "idle",
			retrying: false,
			problem: null,
			announcement: "",
			actions: {
				show,
				shortcut: (off) => show(off ? false : !get().open),
				setView: (view) => {
					if (view === get().view) return;
					if (view === "history") dropPhoto();
					set({ view });
					if (view === "chat") watchAgain();
				},
				write: (draft) => set({ draft }),
				send: (text, references, context) => {
					if (get().startedIn !== context) {
						set({ startedIn: context });
						if (get().chat.conversation) get().actions.newChat();
					}
					const s: Send = { key: crypto.randomUUID(), text, references, state: "sending", error: null, sequence: null };
					update((chat) => ({ ...chat, sends: [...chat.sends, s] }), { draft: "" });
					dropPhoto();
					void deliver(s);
				},
				resend: (s) => void deliver(s),
				edit: (s) =>
					update((chat) => ({ ...chat, sends: chat.sends.filter((x) => x.key !== s.key) }), { draft: s.text }),
				attach: (file) => {
					dropPhoto();
					const problem = port.checkPhoto(file);
					if (problem) return set({ photo: problem });
					const run = photoRun;
					const src = URL.createObjectURL(file);
					set({ photo: { status: "uploading", src } });
					void port.stagePhoto(file, src).then((photo) => {
						if (run === photoRun) set({ photo });
					});
				},
				clearPhoto: dropPhoto,
				reload: () => void reload(),
				cancel: () =>
					void (async () => {
						const conversation = get().chat.conversation;
						if (!conversation || !get().chat.activeTurnId) return;
						update((chat) => ({ ...chat, stopping: true }), { problem: null });
						const r = await port.cancelTurn(conversation.id);
						if (r.status !== "ok") {
							update((chat) => ({ ...chat, stopping: false }), {
								problem: "Evry could not stop. Check your connection and try again.",
							});
							return;
						}
						if (get().stream !== "live") await catchUp(conversation.id);
					})(),
				retry: (turnId) =>
					void (async () => {
						const conversation = get().chat.conversation;
						if (!conversation || get().retrying) return;
						const key = retryKeys.get(turnId) ?? crypto.randomUUID();
						retryKeys.set(turnId, key);
						set({ problem: null, retrying: true });
						const r = await port.retryTurn(conversation.id, key);
						set({ retrying: false });
						if (r.status === "lost") return set({ problem: "Not confirmed. Check your connection, then try again." });
						retryKeys.delete(turnId);
						if (r.status === "refused")
							return set({
								problem:
									r.error.code === "run_active"
										? "Evry is already answering in this conversation."
										: "Evry could not try again. This answer can't be retried.",
							});
						if (get().chat.conversation?.id === conversation.id)
							update((chat) => ({ ...chat, activeTurnId: r.value.turnId }));
					})(),
				reconnect: () => {
					following = null;
					follow();
				},
				followStream: (listener) => {
					const off = api.subscribe(listener);
					readers++;
					if (readers === 1) {
						unwatch = api.subscribe(follow);
						follow();
					}
					return () => {
						off();
						readers--;
						if (readers > 0) return;
						unwatch();
						follow();
					};
				},
				select: (conversationId) =>
					void (async () => {
						if (conversationId === get().chat.conversation?.id) return;
						const mine = ++shown;
						set({ load: "loading" });
						const r = await readAll(port, conversationId, () => mine === shown);
						if (mine !== shown) return;
						set({ load: "ready" });
						if (r.status !== "ok")
							return set({ problem: "That conversation could not open. Check your connection and try again." });
						openState(opened(r.value));
					})(),
				newChat: () => {
					shown++;
					createKey = null;
					openState(EMPTY);
					set({ load: "ready" });
				},
				seen: (proposalId) => {
					const { reviews } = get().chat;
					if (!(proposalId in reviews)) return;
					update((chat) => ({
						...chat,
						reviews: Object.fromEntries(Object.entries(chat.reviews).filter(([id]) => id !== proposalId)),
					}));
				},
			},
		};
	});

	return store;
}
