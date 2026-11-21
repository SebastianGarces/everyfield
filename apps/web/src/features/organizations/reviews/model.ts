import type { SitePath } from "@everyfield/contracts/identity";
export const REVIEWS_PATH = "/organization/reviews";
export const reviewPath = (reviewId: string): SitePath => `${REVIEWS_PATH}/${encodeURIComponent(reviewId)}`;
