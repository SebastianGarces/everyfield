"use client";

import { useState } from "react";
import { History } from "./HistoryPanel.tsx";

/**
 * Communication tab on the person screen. It shows this person's message history.
 * A saved follow-up is a new reviewed message. It does not send email.
 */
export function PersonCommunication({ personId, canWrite }: { personId: string; canWrite: boolean }) {
	const [saved, setSaved] = useState(false);
	return (
		<div className="flex flex-col gap-4">
			{saved ? (
				<p role="status" className="text-sm text-text-2">
					This follow-up keeps the original subject and body. The original message was not changed. No email was sent.
				</p>
			) : null}
			<History canWrite={canWrite} personId={personId} meetingId={null} keepScope onOpen={() => setSaved(true)} />
		</div>
	);
}
