"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as api from "./api.ts";
import {
	cursor,
	EMPTY,
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

// One conversation in the panel: it opens the latest one when the panel first opens, sends with one request key per
// message, follows a run over the server's event stream while the panel is open, and stops or retries a turn. Nothing
// here reads the page again (no router.refresh): each answer updates only the state it changed.

type Action =
	| { type: "open"; state: State }
	| { type: "events"; events: readonly ConversationEvent[] }
	| { type: "live"; turnId: string; offset: number; text: string }
	| { type: "conversation"; conversation: Conversation }
	| { type: "send"; send: Send }
	| { type: "sent"; key: string; patch: Partial<Send> }
	| { type: "drop"; key: string }
	| { type: "active"; turnId: string | null }
	| { type: "stopping"; value: boolean };

function reduce(state: State, action: Action): State {
	switch (action.type) {
		case "open":
			return action.state;
		case "events":
			return merge(state, action.events);
		case "live":
			return mergeLive(state, action.turnId, action.offset, action.text);
		case "conversation":
			return { ...state, conversation: action.conversation };
		case "send":
			return { ...state, sends: [...state.sends, action.send] };
		case "sent": {
			const sends = state.sends.map((s) => (s.key === action.key ? { ...s, ...action.patch } : s));
			// A confirmed message whose saved event already arrived is shown from the event alone.
			const saved = new Set(state.events.map((e) => e.sequence));
			return { ...state, sends: sends.filter((s) => s.sequence === null || !saved.has(s.sequence)) };
		}
		case "drop":
			return { ...state, sends: state.sends.filter((s) => s.key !== action.key) };
		case "active":
			return { ...state, activeTurnId: action.turnId, stopping: action.turnId ? state.stopping : false };
		case "stopping":
			return { ...state, stopping: action.value };
	}
}

const KINDS = ["user_message", "assistant_text", "tool_result", "status"] as const;

export type Load = "idle" | "loading" | "ready" | "failed";
/** live: following a run · reconnecting: the browser is reconnecting on its own · lost: it gave up. */
export type Stream = "idle" | "live" | "reconnecting" | "lost";

/**
 * Reads a whole conversation from its first page, following the remaining event pages while `wanted()` holds. Once the
 * person has moved on, it asks for nothing more and answers lost; the caller drops it anyway.
 */
async function readAll(
	id: string,
	wanted: () => boolean,
	first?: ReadConversation,
): Promise<api.Reply<ReadConversation>> {
	let read = first;
	if (!read) {
		const r = await api.readConversation(id);
		if (r.status !== "ok") return r;
		read = r.value;
	}
	while (read.more) {
		if (!wanted()) return { status: "lost" };
		const next = await api.readConversation(id, read.events.at(-1)?.sequence ?? 0);
		if (next.status !== "ok") return next;
		read.events.push(...next.value.events);
		read.more = next.value.more;
		read.run = next.value.run;
	}
	return { status: "ok", value: read };
}

export function useConversation(open: boolean) {
	const [state, dispatch] = useReducer(reduce, EMPTY);
	const [load, setLoad] = useState<Load>("idle");
	const [stream, setStream] = useState<Stream>("idle");
	const [attempt, setAttempt] = useState(0);
	const [retrying, setRetrying] = useState(false);
	/** A failed stop or retry, said next to the turn it was for. */
	const [problem, setProblem] = useState<string | null>(null);
	const latest = useRef(state);
	const createKey = useRef<string | null>(null);
	const retryKeys = useRef(new Map<string, string>());
	/** Counts what the person chose to show (open, a History pick, a new chat); a read that answers late never wins. */
	const shown = useRef(0);
	useEffect(() => {
		latest.current = state;
	});

	const openState = (next: State) => {
		latest.current = next;
		dispatch({ type: "open", state: next });
		setProblem(null);
	};

	const reload = async () => {
		const mine = ++shown.current;
		setLoad("loading");
		const latest = await api.openLatest();
		// A long conversation answers in pages; the rest are read before it shows, so its newest messages are there.
		const r =
			latest.status === "ok" && latest.value.conversation
				? await readAll(latest.value.conversation.id, () => mine === shown.current, latest.value as ReadConversation)
				: latest;
		if (mine !== shown.current) return;
		if (r.status !== "ok") return setLoad("failed");
		openState(r.value.conversation ? opened(r.value as ReadConversation) : EMPTY);
		setLoad("ready");
	};

	const ensureLoaded = () => {
		if (load === "idle") void reload();
	};

	/** A stream ended by a refusal: nothing more comes for this run, so the panel stops waiting and says why. */
	const stopped = (error: ProjectedError) => {
		if (error.outcome !== "refused") return setStream("lost");
		dispatch({ type: "active", turnId: null });
		setStream("idle");
		setProblem(
			error.code === "access_denied" || error.code === "not_found"
				? "Your access changed, so Evry stopped. Nothing was changed."
				: "Evry stopped. Nothing was changed.",
		);
	};

	/** After the stream closed for good: the saved events and the run's state, or the refusal that closed it. */
	const settle = async (conversationId: string) => {
		const r = await api.readConversation(conversationId, cursor(latest.current));
		if (latest.current.conversation?.id !== conversationId) return;
		if (r.status === "refused") return stopped(r.error);
		if (r.status === "lost") return setStream("lost");
		dispatch({ type: "events", events: r.value.events });
		if (r.value.run) setStream("lost");
		else dispatch({ type: "active", turnId: null });
	};

	// The stream's handlers call the newest helpers without reopening the stream when they change.
	const ends = useRef({ stopped, settle });
	useEffect(() => {
		ends.current = { stopped, settle };
	});

	// Follow the run while the panel is open. The stream sends saved events after the cursor first, so it also catches
	// up after the panel was closed. On a dropped connection the browser reconnects with Last-Event-ID by itself.
	const id = state.conversation?.id;
	const running = state.activeTurnId !== null;
	useEffect(() => {
		if (!open || !id || !running) return;
		const source = new EventSource(api.streamUrl(id, cursor(latest.current)));
		const onEvent = (e: MessageEvent<string>) =>
			dispatch({ type: "events", events: [JSON.parse(e.data) as ConversationEvent] });
		for (const kind of KINDS) source.addEventListener(kind, onEvent);
		// The running turn's text as this server received it, ahead of its saved events.
		source.addEventListener("live", (e) => {
			const { turnId, offset, text } = JSON.parse((e as MessageEvent<string>).data) as {
				turnId: string;
				offset: number;
				text: string;
			};
			dispatch({ type: "live", turnId, offset, text });
		});
		source.onopen = () => setStream("live");
		// The server ends the stream when no run is active; any run the panel still waits for has no more events.
		source.addEventListener("idle", () => {
			source.close();
			setStream("idle");
			dispatch({ type: "active", turnId: null });
		});
		source.addEventListener("error", (e) => {
			// The server's projected error (access ended, signed out, the conversation is gone) ends the stream for good.
			if (e instanceof MessageEvent) {
				source.close();
				return ends.current.stopped(JSON.parse(e.data) as ProjectedError);
			}
			// The browser gave up (the server refused to reopen the stream): read what was saved to learn why.
			if (source.readyState === EventSource.CLOSED) {
				source.close();
				return void ends.current.settle(id);
			}
			setStream("reconnecting");
		});
		return () => {
			source.close();
			setStream("idle");
		};
	}, [open, id, running, attempt]);

	const fail = (send: Send, reply: api.Reply<unknown>) =>
		dispatch({
			type: "sent",
			key: send.key,
			patch:
				reply.status === "refused" ? { state: "refused", error: reply.error } : { state: "unconfirmed", error: null },
		});

	/** Sends one message. A send that was not confirmed goes again with the same key, so it is saved once. */
	const deliver = async (send: Send) => {
		// The view this send belongs to. If the person opens another conversation or a new chat meanwhile, the message
		// is still saved, but its answers never replace what the person chose to show.
		const view = shown.current;
		const here = () => shown.current === view;
		dispatch({ type: "sent", key: send.key, patch: { state: "sending", error: null } });
		let conversation = latest.current.conversation;
		if (!conversation) {
			const key = (createKey.current ??= crypto.randomUUID());
			const created = await api.createConversation(key);
			if (!here())
				return void (created.status === "ok" && api.submitTurn(created.value.id, send.key, send.text, send.references));
			if (created.status !== "ok") return fail(send, created);
			if (createKey.current === key) createKey.current = null;
			conversation = created.value;
			latest.current = { ...latest.current, conversation };
			dispatch({ type: "conversation", conversation });
		}
		const r = await api.submitTurn(conversation.id, send.key, send.text, send.references);
		if (!here()) return;
		if (r.status !== "ok") return fail(send, r);
		dispatch({ type: "sent", key: send.key, patch: { sequence: r.value.sequence } });
		const ended = latest.current.events.some((e) => e.kind === "status" && e.turnId === r.value.turnId);
		if (!ended) dispatch({ type: "active", turnId: r.value.turnId });
	};

	const send = (text: string, references: Reference[]) => {
		const s: Send = { key: crypto.randomUUID(), text, references, state: "sending", error: null, sequence: null };
		dispatch({ type: "send", send: s });
		void deliver(s);
	};

	const cancel = async () => {
		const conversation = latest.current.conversation;
		if (!conversation || !latest.current.activeTurnId) return;
		setProblem(null);
		dispatch({ type: "stopping", value: true });
		const r = await api.cancelTurn(conversation.id);
		if (r.status !== "ok") {
			dispatch({ type: "stopping", value: false });
			setProblem("Evry could not stop. Check your connection and try again.");
			return;
		}
		// The stop's status event comes over the stream. Without a live stream, read what was saved.
		if (stream !== "live") await catchUp(conversation.id);
	};

	const catchUp = async (conversationId: string) => {
		const r = await api.readConversation(conversationId, cursor(latest.current));
		if (r.status !== "ok" || latest.current.conversation?.id !== conversationId) return;
		dispatch({ type: "events", events: r.value.events });
		if (!r.value.run) dispatch({ type: "active", turnId: null });
	};

	/** Tries the last turn again as a new turn. A retry that was not confirmed reuses its key. */
	const retry = async (turnId: string) => {
		const conversation = latest.current.conversation;
		if (!conversation || retrying) return;
		const key = retryKeys.current.get(turnId) ?? crypto.randomUUID();
		retryKeys.current.set(turnId, key);
		setProblem(null);
		setRetrying(true);
		const r = await api.retryTurn(conversation.id, key);
		setRetrying(false);
		if (r.status === "lost") return setProblem("Not confirmed. Check your connection, then try again.");
		retryKeys.current.delete(turnId);
		if (r.status === "refused")
			return setProblem(
				r.error.code === "run_active"
					? "Evry is already answering in this conversation."
					: "Evry could not try again. This answer can't be retried.",
			);
		if (latest.current.conversation?.id === conversation.id) dispatch({ type: "active", turnId: r.value.turnId });
	};

	/** Opens a conversation from History. */
	const select = async (conversationId: string) => {
		if (conversationId === latest.current.conversation?.id) return;
		const mine = ++shown.current;
		setLoad("loading");
		const r = await readAll(conversationId, () => mine === shown.current);
		if (mine !== shown.current) return;
		setLoad("ready");
		if (r.status !== "ok") return setProblem("That conversation could not open. Check your connection and try again.");
		openState(opened(r.value));
	};

	/** A new chat is created by its first message, so an empty one is never saved. */
	const newChat = () => {
		shown.current++;
		createKey.current = null;
		openState(EMPTY);
		setLoad("ready");
	};

	const turns = useMemo(() => turnsOf(state.events, state.live), [state.events, state.live]);
	return {
		state,
		turns,
		load,
		stream,
		retrying,
		problem,
		reload,
		ensureLoaded,
		send,
		resend: (s: Send) => void deliver(s),
		discard: (key: string) => dispatch({ type: "drop", key }),
		cancel,
		retry,
		reconnect: () => setAttempt((n) => n + 1),
		select,
		newChat,
	};
}
