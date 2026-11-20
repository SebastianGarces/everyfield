import { organizationSeatOf } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { loadAnswerReview, loadAnswerReviews } from "../pipeline-mount";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { LANDING_ROUTE } from "@everyfield/contracts/identity";
import { NotAvailable } from "../../access/AccessStates";
import { REVIEWS_PATH, reviewPath } from "./model";
import { ReviewScreen, ReviewsScreen } from "./ReviewScreens";

export const reviewsMetadata: Metadata = { title: "Sent for review", robots: { index: false, follow: false } };

const refused = (
	<div className="py-12">
		<Card className="mx-auto max-w-[560px]">
			<NotAvailable scope="page" homeHref={LANDING_ROUTE} />
		</Card>
	</div>
);

export async function ReviewsPage() {
	const seat = organizationSeatOf(await requireActor(REVIEWS_PATH));
	if (!seat) return refused;
	const list = await loadAnswerReviews(seat.authority);
	if (list.status !== "ok") return refused;
	return <ReviewsScreen list={list.value} />;
}

export async function ReviewPage({ params }: { params: Promise<{ reviewId: string }> }) {
	const { reviewId } = await params;
	const seat = organizationSeatOf(await requireActor(reviewPath(reviewId)));
	if (!seat) return refused;
	const review = await loadAnswerReview(seat.authority, reviewId);
	if (review.status !== "ok") return refused;
	return <ReviewScreen review={review.value} />;
}
