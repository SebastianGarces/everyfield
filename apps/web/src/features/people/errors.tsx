"use client";

import { Button, Card, PageHeader, StatePanel } from "@everyfield/ui/controls";

/** An unexpected failure while rendering a People page. Retrying renders the page again; nothing was changed. */
export function PeopleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<>
			<PageHeader size="xl" title="People" />
			<Card>
				<StatePanel
					tone="error"
					title="We could not load your people"
					headingLevel="h2"
					actions={
						<Button variant="primary" onClick={reset}>
							Try again
						</Button>
					}
				>
					This is a loading problem, not an empty list. Your people are safe. Try again in a moment.
				</StatePanel>
			</Card>
		</>
	);
}
