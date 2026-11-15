"use client";

import { useState } from "react";
import { Await, createRead, useRead } from "../../components/read.tsx";
import { readPreviewContext } from "./actions.ts";
import { History } from "./HistoryPanel.tsx";
import type { Outcome } from "./model.ts";

const previewContexts = createRead(() => readPreviewContext(), {
	failed: (): Outcome<{ churchName: string; origin: string }> => ({ status: "lost" }),
});

export function PersonCommunication({ personId, canWrite }: { personId: string; canWrite: boolean }) {
	const [saved, setSaved] = useState(false);
	const { promise } = useRead(previewContexts);
	return (
		<Await promise={promise} fallback={<p className="text-sm text-text-3">Loading messages.</p>}>
			{(preview) =>
				preview.status !== "ok" ? (
					<p role="alert" className="text-sm font-medium text-magenta-600">
						Messages did not load. Reload the page in a moment.
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
							origin={preview.value.origin}
						/>
					</div>
				)
			}
		</Await>
	);
}
