import { call } from "../conversation/api.ts";
import type { Operation, Review } from "./model.ts";

// The browser side of the WP-053 review API (apps/web/src/app/api/evry/proposals). Each call answers ok, refused with
// the projected error, or lost. The approval witness (revision and digest) is the request key: sending the same one
// again after a lost reply returns the approval that was saved and queues nothing.

export const readReview = (id: string) => call<Review>(`proposals/${id}`);
export const approve = (review: Pick<Review, "id" | "revision" | "digest">) =>
	call<{ proposal: Review; replayed: boolean }>(`proposals/${review.id}/approve`, {
		method: "POST",
		body: { revision: review.revision, digest: review.digest },
	});
export const revise = (id: string, operation: Operation, revision: number, input: unknown) =>
	call<Review>(`proposals/${id}/revise`, { method: "POST", body: { operation, revision, input } });
export const cancel = (id: string) =>
	call<{ proposal: Review; cancelled: boolean }>(`proposals/${id}/cancel`, { method: "POST", body: {} });
export const retry = (id: string) =>
	call<{ proposal: Review; retried: boolean }>(`proposals/${id}/retry`, { method: "POST", body: {} });
