"use client";

import type { History } from "@everyfield/contracts/launch";
import {
	Button,
	Card,
	CardActions,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
} from "@everyfield/ui/controls";
import { useState } from "react";
import { readLaunchHistory } from "./actions.ts";
import { actorText, historyText, refusalMessage, sent } from "./model.ts";

/**
 * Launch history (LCH-002, LCH-010): every change to Launch Sunday, the milestones and the recorded outcome, newest
 * first, with who made it and when. It loads when opened, so it is always current; a change by an account that was
 * since deleted reads as a former account.
 */
export function LaunchHistory({ today }: { today: string }) {
	const [history, setHistory] = useState<History | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	async function load() {
		setLoading(true);
		const r = await sent(() => readLaunchHistory());
		setLoading(false);
		if (r.status === "ok") {
			setError(null);
			return setHistory(r.value);
		}
		setError(refusalMessage(r));
	}

	const at = (instant: string, timeZone: string) =>
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}).format(new Date(instant));

	return (
		<Card className="mt-5" aria-labelledby="launch-history">
			<CardHeader>
				<CardHeading>
					<CardTitle id="launch-history">Launch history</CardTitle>
					<CardDescription>Every date change, milestone and outcome, with who made it and when.</CardDescription>
				</CardHeading>
				<CardActions>
					<Button variant="secondary" size="sm" disabled={loading} onClick={load}>
						{loading ? "Loading" : history ? "Refresh" : "Show history"}
					</Button>
				</CardActions>
			</CardHeader>
			{error ? (
				<p role="alert" className="text-sm text-red-700">
					{error}
				</p>
			) : null}
			{history ? (
				history.entries.length ? (
					<ol className="flex flex-col">
						{history.entries.map((e) => {
							const t = historyText(e, today);
							return (
								<li key={e.id} className="border-t border-line py-3.5 first:border-t-0 first:pt-0">
									<p className="font-semibold text-ink">{t.title}</p>
									{t.lines.map((line, i) => (
										<p key={i} className="text-sm break-words whitespace-pre-line text-ink-2">
											{line}
										</p>
									))}
									<p className="mt-1 text-xs text-text-3">
										{actorText(e)} · {at(e.at, history.timeZone)}
									</p>
								</li>
							);
						})}
					</ol>
				) : (
					<p className="text-sm text-text-3">Nothing has changed yet.</p>
				)
			) : null}
		</Card>
	);
}
