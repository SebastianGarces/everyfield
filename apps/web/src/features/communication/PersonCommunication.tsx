"use client";
import type { Outcome } from "@everyfield/contracts/common";

import { useState } from "react";
import { Await, createRead, useRead } from "../../components/read.tsx";
import { readPreviewContext } from "./fetch.ts";
import { History } from "./HistoryPanel.tsx";
import { loadProblem } from "../../components/read-failed.ts";
import type { ReadFailure } from "../../components/get-reads.ts";

const previewContexts = createRead(() => readPreviewContext(), {
	failed: (): Outcome<{ churchName: string; mailingAddress: string | null; origin: string }> | ReadFailure => ({
		status: "lost",
	}),
});

export function PersonCommunication({ personId, canWrite }: { personId: string; canWrite: boolean }) {
	const [saved, setSaved] = useState(false);
	const previews = useRead(previewContexts);
	return (
		<Await state={previews} fallback={<p className="text-sm text-text-3">Loading messages.</p>}>
			{(preview) =>
				preview.status !== "ok" ? (
					<p role="alert" className="text-sm font-medium text-magenta-600">
						{loadProblem(preview, "Messages did not load. Reload the page in a moment.")}
					</p>
				) : (
					<div className="flex flex-col gap-4">
						{saved ? (
							<p role="status" className="text-sm text-text-2">
								This follow-up keeps the original subject and body. The original message was not changed. No email was
								sent.
							</p>
						) : null}
						<History
							canWrite={canWrite}
							personId={personId}
							meetingId={null}
							keepScope
							onOpen={() => setSaved(true)}
							churchName={preview.value.churchName}
							mailingAddress={preview.value.mailingAddress}
							origin={preview.value.origin}
						/>
					</div>
				)
			}
		</Await>
	);
}
