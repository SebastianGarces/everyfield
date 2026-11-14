// Where the reviewer reads what was sent to them (T-385). No React and no server code.

export const REVIEWS_PATH = "/organization/reviews";
/** One send on the reviewer's Sent for review page. */
export const reviewPath = (reviewId: string) => `${REVIEWS_PATH}/${encodeURIComponent(reviewId)}`;
