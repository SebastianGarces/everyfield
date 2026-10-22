import { call, type Reply } from "../conversation/api.ts";
import type { ProjectedError } from "../conversation/model.ts";
import type { Operation, Review } from "./model.ts";

// The browser side of the WP-053 review API (apps/web/src/app/api/evry/proposals). Each call answers ok, refused with
// the projected error, or lost. The approval witness (revision and digest) is the request key: sending the same one
// again after a lost reply returns the approval that was saved and queues nothing.

export const readReview = (id: string) => call<Review>(`proposals/${id}`);
/**
 * Approves the exact revision. The witness (revision and digest) is the request key, so after a lost reply the same
 * request is sent once more at once: the server replays a saved approval and queues nothing (C58).
 */
export async function approve(review: Pick<Review, "id" | "revision" | "digest">) {
	const send = () =>
		call<{ proposal: Review; replayed: boolean }>(`proposals/${review.id}/approve`, {
			method: "POST",
			body: { revision: review.revision, digest: review.digest },
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

/**
 * The exact upload a set-photo review would save, as image bytes for this card only. The route is private and never
 * cached, so the card reads it once and keeps the bytes for as long as it shows them. A refusal means the upload or
 * the review is gone; anything else is lost and may be read again.
 */
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
