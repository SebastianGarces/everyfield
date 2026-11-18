export const REVIEWS_PATH = "/organization/reviews";
export const reviewPath = (reviewId: string) => `${REVIEWS_PATH}/${encodeURIComponent(reviewId)}`;
