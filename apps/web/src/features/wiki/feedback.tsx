"use client";

import { Button } from "@everyfield/ui/controls";
import { useOptimistic, useState, useTransition } from "react";
import { setFeedback, type FeedbackResult } from "./actions.ts";

type Vote = "helpful" | "unhelpful";

function refusal(result: Exclude<FeedbackResult, { status: "ok" }>): string {
	if (result.status === "conflict") return "Reload the page, then try again.";
	if (result.status === "denied") return "You cannot rate this article.";
	return "That rating did not save. Try again.";
}

export function ArticleFeedback({ articleId, vote }: { articleId: string; vote: Vote | null }) {
	const [saved, setSaved] = useState(vote);
	const [current, showVote] = useOptimistic(saved);
	const [message, setMessage] = useState("");
	const [pending, startVote] = useTransition();

	function choose(next: Vote) {
		if (pending || next === current) return;
		setMessage("");
		startVote(async () => {
			showVote(next);
			const result = await setFeedback({ requestKey: crypto.randomUUID(), articleId, vote: next }).catch(
				(): FeedbackResult => ({ status: "lost" }),
			);
			if (result.status !== "ok") {
				setMessage(refusal(result));
				return;
			}
			setSaved(result.vote);
			setMessage(result.vote === "helpful" ? "Marked as helpful." : "Marked as unhelpful.");
		});
	}

	return (
		<section className="mx-auto mt-10 max-w-[700px]" aria-labelledby="wiki-feedback-title">
			<h2 id="wiki-feedback-title" className="font-title text-[22px] tracking-[-0.02em] text-ink">
				Was this article helpful?
			</h2>
			<div className="mt-4 flex flex-wrap gap-3">
				<Button
					variant={current === "helpful" ? "primary" : "outline"}
					aria-pressed={current === "helpful"}
					loading={pending && current === "helpful"}
					disabled={pending && current !== "helpful"}
					onClick={() => choose("helpful")}
				>
					Helpful
				</Button>
				<Button
					variant={current === "unhelpful" ? "primary" : "outline"}
					aria-pressed={current === "unhelpful"}
					loading={pending && current === "unhelpful"}
					disabled={pending && current !== "unhelpful"}
					onClick={() => choose("unhelpful")}
				>
					Unhelpful
				</Button>
			</div>
			<p role="status" className="mt-3 min-h-6 text-sm text-text-2">
				{message}
			</p>
		</section>
	);
}
