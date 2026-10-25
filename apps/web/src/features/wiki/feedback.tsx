"use client";

import { Button } from "@everyfield/ui/controls";
import { useRef, useState } from "react";
import { setFeedback } from "./actions.ts";

const EMPTY = "";

export function ArticleFeedback({ articleId, vote }: { articleId: string; vote: "helpful" | "unhelpful" | null }) {
	const [current, setCurrent] = useState(vote);
	const [message, setMessage] = useState(EMPTY);
	const [pending, setPending] = useState<"helpful" | "unhelpful" | null>(null);
	const lock = useRef(false);

	async function choose(next: "helpful" | "unhelpful") {
		if (lock.current || next === current) return;
		lock.current = true;
		const previous = current;
		setCurrent(next);
		setPending(next);
		setMessage(EMPTY);
		try {
			const result = await setFeedback({
				requestKey: crypto.randomUUID(),
				articleId,
				vote: next,
			});
			if (result.status === "ok") {
				setCurrent(result.vote);
				setMessage(result.vote === "helpful" ? "Marked as helpful." : "Marked as unhelpful.");
				return;
			}
			setCurrent(previous);
			setMessage(
				result.status === "conflict"
					? "Reload the page, then try again."
					: result.status === "denied"
						? "You cannot rate this article."
						: "That rating did not save. Try again.",
			);
		} catch {
			setCurrent(previous);
			setMessage("That rating did not save. Try again.");
		} finally {
			setPending(null);
			lock.current = false;
		}
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
					loading={pending === "helpful"}
					disabled={pending !== null && pending !== "helpful"}
					onClick={() => void choose("helpful")}
				>
					Helpful
				</Button>
				<Button
					variant={current === "unhelpful" ? "primary" : "outline"}
					aria-pressed={current === "unhelpful"}
					loading={pending === "unhelpful"}
					disabled={pending !== null && pending !== "unhelpful"}
					onClick={() => void choose("unhelpful")}
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
