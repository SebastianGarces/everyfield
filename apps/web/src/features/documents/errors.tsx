"use client";

import { Button, Card, PageHeader, StatePanel } from "@everyfield/ui/controls";

export function DocumentsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	return (
		<>
			<PageHeader size="xl" title="Documents" />
			<Card>
				<StatePanel
					tone="error"
					title="We could not load documents"
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
