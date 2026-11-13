"use client";

import { useEffect, useState } from "react";
import { readPreviewContext } from "./actions.ts";
import { History } from "./HistoryPanel.tsx";

/**
 * Communication tab on the person screen. It shows this person's message history.
 * A saved follow-up is a new reviewed message. It does not send email.
 */
export function PersonCommunication({ personId, canWrite }: { personId: string; canWrite: boolean }) {
	const [saved, setSaved] = useState(false);
	const [preview, setPreview] = useState<{ churchName: string; origin: string } | "failed" | null>(null);
	useEffect(() => {
		let current = true;
		void readPreviewContext().then((result) => {
			if (current) setPreview(result.status === "ok" ? result.value : "failed");
		});
		return () => {
			current = false;
		};
	}, []);
	if (preview === null) return <p className="text-sm text-text-3">Loading messages.</p>;
	if (preview === "failed")
		return (
			<p role="alert" className="text-sm font-medium text-magenta-600">
				Messages did not load. Reload the page in a moment.
			</p>
		);
	return (
		<div className="flex flex-col gap-4">
			{saved ? (
				<p role="status" className="text-sm text-text-2">
					This follow-up keeps the original subject and body. The original message was not changed. No email was sent.
				</p>
			) : null}
			<History
				canWrite={canWrite}
				personId={personId}
				meetingId={null}
				keepScope
				onOpen={() => setSaved(true)}
				churchName={preview.churchName}
				origin={preview.origin}
			/>
		</div>
	);
}
