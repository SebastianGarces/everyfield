import type { Conversation, ProjectedError, ReadConversation, Reference } from "./model.ts";

export type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: ProjectedError } | { status: "lost" };

export async function call<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<Reply<T>> {
	try {
		const r = await fetch(`/api/evry/${path}`, {
			cache: "no-store",
			...(init
				? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }
				: {}),
		});
		const json = (await r.json().catch(() => null)) as { error?: ProjectedError } | null;
		if (r.ok && json) return { status: "ok", value: json as T };
		const error = json?.error;
		return error && error.outcome === "refused" ? { status: "refused", error } : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}

export type Submitted = { turnId: string; sequence: number; replayed: boolean };
export type ConversationPage = { items: Conversation[]; total: number; page: number; next: number | null };

export const openLatest = () => call<(ReadConversation | { conversation: null }) & { pipeline?: boolean }>("open");
export const readConversation = (id: string, after = 0) => call<ReadConversation>(`conversations/${id}?after=${after}`);
export const listConversations = (search: string, page: number) =>
	call<ConversationPage>(
		`conversations?${new URLSearchParams({ page: String(page), ...(search ? { q: search } : {}) })}`,
	);
export const createConversation = (requestKey: string) =>
	call<Conversation>("conversations", { method: "POST", body: { requestKey } });
export const submitTurn = (id: string, requestKey: string, text: string, references: Reference[]) =>
	call<Submitted>(`conversations/${id}/turns`, { method: "POST", body: { requestKey, text, references } });
export const retryTurn = (id: string, requestKey: string) =>
	call<Submitted>(`conversations/${id}/retry`, { method: "POST", body: { requestKey } });
export const cancelTurn = (id: string) =>
	call<{ cancelled: boolean; turnId: string | null }>(`conversations/${id}/cancel`, { method: "POST", body: {} });

export const streamUrl = (id: string, after: number) => `/api/evry/conversations/${id}/stream?after=${after}`;
