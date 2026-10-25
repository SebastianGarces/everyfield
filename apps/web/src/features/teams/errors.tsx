"use client";

import { Button, Card, PageHeader, StatePanel } from "@everyfield/ui/controls";

/** An unexpected failure while rendering a ministries page. Retrying renders the page again; nothing was changed. */
export function TeamsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<>
			<PageHeader size="xl" title="Ministries" />
			<Card>
				<StatePanel
					tone="error"
					title="We could not load ministries"
					headingLevel="h2"
					actions={
						<Button variant="primary" onClick={reset}>
							Try again
						</Button>
					}
				>
					This is a loading problem. Nothing was changed. Try again in a moment.
				</StatePanel>
			</Card>
		</>
	);
}
