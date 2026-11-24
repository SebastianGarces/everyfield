"use client";

import { dayText } from "@everyfield/contracts/common";
import type { Assessment, NewestRun } from "@everyfield/contracts/intelligence";
import { Alert, Button, InlineAlert } from "@everyfield/ui/controls";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { requestAssessmentRefresh } from "./assessment-actions.ts";
import { newestText, refreshProblem, type ActionOutcome } from "./assessment-model.ts";

export function OutOfDate({ assessment, newest }: { assessment: Assessment; newest: NewestRun | null }) {
	const router = useRouter();
	const [requestId, setRequestId] = useState(() => crypto.randomUUID());
	const [problem, setProblem] = useState<string | null>(null);
	const [focus, setFocus] = useState(0);
	const [busy, start] = useTransition();
	const underWay = newest?.state === "preparing" || newest?.state === "deferred";
	const refresh = () =>
		start(async () => {
			setProblem(null);
			const sent: ActionOutcome<unknown> = await requestAssessmentRefresh(requestId).catch(() => ({
				status: "lost" as const,
			}));
			setProblem(refreshProblem(sent));
			if (sent.status !== "ok") return;
			setRequestId(crypto.randomUUID());
			setFocus((n) => n + 1);
			router.refresh();
		});
	return (
		<div className="flex flex-col gap-2" data-out-of-date={assessment.runId}>
			<Alert
				tone="warning"
				title="This assessment is out of date"
				focus={focus}
				data-newest={newest?.state}
				actions={
					underWay ? null : (
						<Button type="button" size="sm" variant="secondary" loading={busy} onClick={refresh}>
							Refresh
						</Button>
					)
				}
			>
				<p>Your church&apos;s records changed since it was measured on {dayText(assessment.measuredOn)}.</p>
				{newest ? <p>{newestText(newest, true)}</p> : null}
			</Alert>
			<InlineAlert>{problem}</InlineAlert>
		</div>
	);
}
