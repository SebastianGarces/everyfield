import type { AnswerReview, ReviewList } from "@everyfield/contracts/organizations";
import { ArrowRight01Icon, FileSearchIcon } from "@hugeicons/core-free-icons";
import { Card, CardBody, EmptyState, IntentLink, PageHeader, StatePanel } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { formatDay } from "../board/model";
import { REVIEWS_PATH, reviewPath } from "./model";

// The reviewer's Sent for review page and one send (T-385, D-1507). The reviewer reads only the questions sent to them,
// with the note's current answers. A send that is no longer shared shows no question or answer.

const from = (sender: string | null, sentOn: string) => `From ${sender ?? "former staff"} · ${formatDay(sentOn)}`;

/** Every send to the viewer, newest first. A shared one opens; one that is no longer shared says so. */
export function ReviewsScreen({ list }: { list: ReviewList }) {
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				title="Sent for review"
				subtitle="Answers your Owner or Admins sent you to read. You see only the questions they chose."
			/>
			<Card>
				{list.items.length ? (
					<ul className="-my-3 divide-y divide-line">
						{list.items.map((item) => {
							const body = (
								<>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="font-medium text-ink [overflow-wrap:anywhere]">{item.person}</span>
										<span className="text-sm text-ink-2 [overflow-wrap:anywhere]">{item.groupName}</span>
										<span className="text-sm text-text-2">{from(item.sender, item.sentOn)}</span>
									</span>
									{item.shared ? (
										<Icon icon={ArrowRight01Icon} size={18} className="flex-none text-text-3" />
									) : (
										<span className="flex-none rounded-full bg-surface-2 px-2.5 py-1 text-xs text-text-2">
											No longer shared
										</span>
									)}
								</>
							);
							return (
								<li key={item.id}>
									{item.shared ? (
										<IntentLink
											href={reviewPath(item.id)}
											className="-mx-3 flex cursor-pointer items-center justify-between gap-4 rounded-md px-3 py-3.5 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
										>
											{body}
										</IntentLink>
									) : (
										<div className="flex items-center justify-between gap-4 py-3.5">{body}</div>
									)}
								</li>
							);
						})}
					</ul>
				) : (
					<CardBody>
						<EmptyState icon={FileSearchIcon} title="Nothing sent to you yet" headingLevel="h2">
							When an Owner or Admin sends you answers to review, they appear here.
						</EmptyState>
					</CardBody>
				)}
			</Card>
		</div>
	);
}

/** One send: the chosen questions with their current answers, or that it is no longer shared. */
export function ReviewScreen({ review }: { review: AnswerReview }) {
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				breadcrumb={[{ label: "Sent for review", href: REVIEWS_PATH }, { label: review.groupName }]}
				title={review.groupName}
				subtitle={`${review.person} · ${from(review.sender, review.sentOn)}`}
			/>
			<Card className="max-w-[760px]">
				{review.shared ? (
					<CardBody className="flex flex-col gap-5">
						<p className="text-sm text-text-2">
							Only these questions are shared with you. They show the answers as they read now.
						</p>
						<dl className="flex flex-col gap-5">
							{review.answers.map((a) => (
								<div key={a.question} className="flex flex-col gap-1.5">
									<dt className="text-sm font-medium text-ink [overflow-wrap:anywhere]">{a.question}</dt>
									<dd
										className={
											a.answer === null
												? "text-sm text-text-3"
												: "text-sm whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]"
										}
									>
										{a.answer ?? "No longer available"}
									</dd>
								</div>
							))}
						</dl>
					</CardBody>
				) : (
					<StatePanel icon={FileSearchIcon} title="No longer shared">
						These answers are no longer shared with you.
					</StatePanel>
				)}
			</Card>
		</div>
	);
}
