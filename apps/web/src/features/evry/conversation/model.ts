import type { Review } from "../review/model.ts";

type ContextKind = "account" | "plant" | "sending_church" | "sending_network";

export type Conversation = {
	id: string;
	title: string;
	context: ContextKind;
	lastSequence: number;
	activeTurnId: string | null;
	updatedAt: string;
};

type ErrorCode =
	| "not_found"
	| "access_denied"
	| "invalid_input"
	| "run_active"
	| "model_unavailable"
	| "source_unavailable"
	| "interrupted"
	| "review_changed"
	| "review_expired"
	| "review_closed"
	| "photo_unavailable"
	| "unknown";

export type ProjectedError = {
	code: ErrorCode;
	correlationId: string;
	retry: "never" | "same_request" | "new_turn";
	outcome: "unknown" | "refused";
};

export type Reference = { kind: "person" | "photo"; id: string };
export type SourceRow = {
	kind:
		| "person"
		| "household"
		| "tag"
		| "skill"
		| "activity"
		| "file"
		| "import"
		| "message"
		| "notice"
		| "setting"
		| "digest"
		| "team"
		| "role"
		| "training"
		| "meeting"
		| "responsibility"
		| "template"
		| "venue"
		| "item"
		| "seat"
		| "invitation"
		| "connection"
		| "step"
		| "relationship"
		| "stage"
		| "milestone";
	id: string;
	label: string;
	fields: Record<string, unknown>;
};
export type SourceResult = {
	operation: string;
	status: "available" | "not_found";
	rows: SourceRow[];
	total: number | null;
	page: number;
	next: number | null;
	completeness: "complete" | "partial";
	exclusions: string[];
	facts?: Record<string, unknown>;
	withheldRows?: number;
	proposalId?: string;
};

type StopReason =
	| "completed"
	| "policy_boundary"
	| "tool_budget"
	| "input_budget"
	| "output_budget"
	| "wall_time"
	| "cancelled"
	| "failed";

type Saved<K extends string, B> = { sequence: number; turnId: string | null; kind: K; body: B; createdAt: string };
export type ConversationEvent =
	| Saved<"user_message", { text: string; references?: Reference[]; retryOf?: number }>
	| Saved<"assistant_text", { text: string; withheld?: boolean }>
	| Saved<"tool_result", { operation: string; result: SourceResult; originalTotal?: number | null }>
	| Saved<
			"status",
			{ state: "completed" | "stopped" | "failed"; reason: StopReason; error?: ProjectedError; withheld?: boolean }
	  >;

export type Send = {
	key: string;
	text: string;
	references: Reference[];
	state: "sending" | "unconfirmed" | "refused";
	error: ProjectedError | null;
	sequence: number | null;
};

export type State = {
	conversation: Conversation | null;
	events: readonly ConversationEvent[];
	activeTurnId: string | null;
	stopping: boolean;
	sends: readonly Send[];
	live: Readonly<Record<string, string>>;
	reviews: Readonly<Record<string, Review | null>>;
};

export const EMPTY: State = {
	conversation: null,
	events: [],
	activeTurnId: null,
	stopping: false,
	sends: [],
	live: {},
	reviews: {},
};

export function mergeLive(state: State, turnId: string, offset: number, text: string): State {
	const have = state.live[turnId] ?? "";
	if (offset > have.length || offset + text.length <= have.length) return state;
	return { ...state, live: { ...state.live, [turnId]: have + text.slice(have.length - offset) } };
}

export type ReadConversation = {
	conversation: Conversation;
	run: { turnId: string; state: "running" | "lost" } | null;
	events: ConversationEvent[];
	reviews: Record<string, Review | null>;
	more: boolean;
};

export function opened(read: ReadConversation): State {
	return {
		...merge({ ...EMPTY, conversation: read.conversation }, read.events),
		activeTurnId: read.run?.turnId ?? null,
		reviews: read.reviews,
	};
}

export const cursor = (state: State) => state.events.at(-1)?.sequence ?? 0;

export function merge(state: State, incoming: readonly ConversationEvent[]): State {
	if (!incoming.length) return state;
	const known = new Set(state.events.map((e) => e.sequence));
	const fresh = incoming.filter((e) => !known.has(e.sequence));
	if (!fresh.length) return state;
	const events = [...state.events, ...fresh].sort((a, b) => a.sequence - b.sequence);
	let { activeTurnId, stopping } = state;
	let live = state.live;
	for (const e of fresh) {
		if (e.kind === "status" && e.turnId && e.turnId in live)
			live = Object.fromEntries(Object.entries(live).filter(([id]) => id !== e.turnId));
		if (e.kind === "user_message" && e.turnId && !events.some((s) => s.kind === "status" && s.turnId === e.turnId))
			activeTurnId = e.turnId;
		if (e.kind === "status" && e.turnId === activeTurnId) {
			activeTurnId = null;
			stopping = false;
		}
	}
	const saved = new Set(events.map((e) => e.sequence));
	const sends = state.sends.filter((s) => s.sequence === null || !saved.has(s.sequence));
	return { ...state, events, activeTurnId, stopping, sends, live };
}

type Block =
	| { kind: "text"; sequence: number; text: string; withheld: boolean }
	| { kind: "result"; sequence: number; operation: string; result: SourceResult; originalTotal: number | null }
	| { kind: "review"; sequence: number; proposalId: string; target: string | null };

export type TurnEnd = { state: "completed" | "stopped" | "failed"; reason: StopReason; error: ProjectedError | null };

export type Turn = {
	id: string;
	ask: { sequence: number; text: string; retried: boolean } | null;
	blocks: Block[];
	end: TurnEnd | null;
};

export function turnsOf(events: readonly ConversationEvent[], live: Readonly<Record<string, string>> = {}): Turn[] {
	const turns = new Map<string, Turn>();
	for (const e of events) {
		const id = e.turnId ?? `event-${e.sequence}`;
		let turn = turns.get(id);
		if (!turn) turns.set(id, (turn = { id, ask: null, blocks: [], end: null }));
		switch (e.kind) {
			case "user_message":
				turn.ask = { sequence: e.sequence, text: e.body.text, retried: e.body.retryOf !== undefined };
				break;
			case "assistant_text": {
				const last = turn.blocks.at(-1);
				const withheld = e.body.withheld === true;
				if (last?.kind === "text" && last.withheld === withheld) last.text += e.body.text;
				else turn.blocks.push({ kind: "text", sequence: e.sequence, text: e.body.text, withheld });
				break;
			}
			case "tool_result":
				if (e.body.result.proposalId)
					turn.blocks.push({
						kind: "review",
						sequence: e.sequence,
						proposalId: e.body.result.proposalId,
						target: e.body.result.rows[0]?.label ?? null,
					});
				else
					turn.blocks.push({
						kind: "result",
						sequence: e.sequence,
						operation: e.body.operation,
						result: e.body.result,
						originalTotal: e.body.originalTotal ?? null,
					});
				break;
			case "status":
				turn.end = { state: e.body.state, reason: e.body.reason, error: e.body.error ?? null };
				break;
		}
	}
	for (const turn of turns.values()) {
		const streamed = live[turn.id];
		if (!streamed || turn.end) continue;
		if (turn.blocks.some((b) => b.kind === "text" && b.withheld)) continue;
		let saved = 0;
		for (const e of events) if (e.turnId === turn.id && e.kind === "assistant_text") saved += e.body.text.length;
		const tail = streamed.slice(saved);
		if (!tail) continue;
		const last = turn.blocks.at(-1);
		if (last?.kind === "text" && !last.withheld) last.text += tail;
		else
			turn.blocks.push({ kind: "text", sequence: (events.at(-1)?.sequence ?? 0) + 0.5, text: tail, withheld: false });
	}
	for (const turn of turns.values())
		for (const block of turn.blocks) if (block.kind === "text" && block.withheld) block.text = "";
	return [...turns.values()];
}

export const answerText = (turn: Turn) =>
	turn.blocks
		.filter((b) => b.kind === "text" && !b.withheld)
		.map((b) => (b as { text: string }).text)
		.join("")
		.trim();

export function retryable(state: State, turns: readonly Turn[]) {
	const last = turns.at(-1);
	if (!last?.end || state.activeTurnId || last.end.state === "completed") return false;
	return last.end.error?.retry !== "never";
}

export type Notice = { tone: "neutral" | "error"; title: string; text: string };

export function endNotice(end: TurnEnd | null): Notice | null {
	if (!end || end.state === "completed") return null;
	if (end.state === "stopped")
		switch (end.reason) {
			case "cancelled":
				return {
					tone: "neutral",
					title: "You stopped this answer",
					text: "What Evry read before you stopped stays here.",
				};
			case "tool_budget":
				return {
					tone: "neutral",
					title: "Evry reached its read limit",
					text: "One answer can use up to 24 reads. Ask a narrower question, or try again.",
				};
			case "wall_time":
				return {
					tone: "neutral",
					title: "This answer took too long",
					text: "Evry stops an answer after 3 minutes. Try again, or ask a narrower question.",
				};
			default:
				return {
					tone: "neutral",
					title: "This answer reached its length limit",
					text: "Ask a narrower question, or try again.",
				};
		}
	switch (end.error?.code) {
		case "model_unavailable":
			return {
				tone: "neutral",
				title: "Evry can't answer yet",
				text: "Evry's AI model is not turned on yet. Your message is saved, so you can try again later.",
			};
		case "source_unavailable":
			return {
				tone: "error",
				title: "Evry could not read a record",
				text: "A record Evry needed was not available. Nothing was changed. Try again.",
			};
		case "access_denied":
		case "not_found":
			return {
				tone: "error",
				title: "Your access changed",
				text: "Evry stopped because your seat no longer allows this. Nothing was changed.",
			};
		default:
			return {
				tone: "error",
				title: "Evry stopped before it finished",
				text: "Nothing was changed. Try again.",
			};
	}
}

export function sendNotice(send: Send): string | null {
	if (send.state === "sending") return null;
	if (send.state === "unconfirmed") return "Not confirmed. Check your connection, then send it again.";
	switch (send.error?.code) {
		case "run_active":
			return "Not sent. Evry is still answering your last message. Stop it or wait, then send again.";
		case "invalid_input":
			return "Not sent. A message can have up to 8,000 characters.";
		case "access_denied":
		case "not_found":
			return "Not sent. You no longer have access to this conversation.";
		default:
			return "Not sent. Send it again.";
	}
}

export const resendable = (send: Send) =>
	send.state === "unconfirmed" || (send.state === "refused" && send.error?.retry !== "never");

const PERSON_PAGE = /^\/people\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function pageReferences(pathname: string | null): Reference[] {
	const id = pathname ? PERSON_PAGE.exec(pathname)?.[1] : undefined;
	return id ? [{ kind: "person", id: id.toLowerCase() }] : [];
}

export const MAX_MESSAGE = 8_000;
