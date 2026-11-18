import { call, type Reply } from "../conversation/api.ts";
import type { ProjectedError } from "../conversation/model.ts";
import type { Operation, Review } from "./model.ts";

export const readReview = (id: string) => call<Review>(`proposals/${id}`);
export async function approve(review: Pick<Review, "id" | "revision" | "digest">, reason?: string) {
	const send = () =>
		call<{ proposal: Review; replayed: boolean }>(`proposals/${review.id}/approve`, {
			method: "POST",
			body: { revision: review.revision, digest: review.digest, ...(reason ? { reason } : {}) },
		});
	const first = await send();
	return first.status === "lost" ? send() : first;
}
export const revise = (id: string, operation: Operation, revision: number, input: unknown) =>
	call<Review>(`proposals/${id}/revise`, { method: "POST", body: { operation, revision, input } });
export const cancel = (id: string) =>
	call<{ proposal: Review; cancelled: boolean }>(`proposals/${id}/cancel`, { method: "POST", body: {} });
export const retry = (id: string) =>
	call<{ proposal: Review; retried: boolean }>(`proposals/${id}/retry`, { method: "POST", body: {} });

export async function readStagedPhoto(id: string): Promise<Reply<Blob>> {
	try {
		const r = await fetch(`/api/evry/proposals/${id}/photo`, { cache: "no-store" });
		if (r.ok) return { status: "ok", value: await r.blob() };
		const json = (await r.json().catch(() => null)) as { error?: ProjectedError } | null;
		return json?.error?.outcome === "refused" ? { status: "refused", error: json.error } : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}

export const check = (id: string) => call<{ proposal: Review }>(`proposals/${id}/check`, { method: "POST", body: {} });
