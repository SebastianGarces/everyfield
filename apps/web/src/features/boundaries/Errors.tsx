"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Button, Card, StatePanel } from "@everyfield/ui/controls";
import Link from "next/link";
import { ButtonLink, buttonClass } from "@/components/ButtonLink";
import { RootState } from "./RootState";

/** What Next hands an error boundary. The message stays in the server log; only the digest reaches the viewer. */
export type BoundaryProps = { error: Error & { digest?: string }; reset: () => void };

const MESSAGE = "This page ran into a problem. Try again, and if it keeps happening, come back in a few minutes.";

function reference(error: BoundaryProps["error"]) {
	return error.digest ? `Error reference ${error.digest}` : undefined;
}

/** A thrown render inside the signed-in product frame ((frame)/error.tsx): the shell stays, the main area says so. */
export function FrameError({ error, reset }: BoundaryProps) {
	return (
		<Card>
			<StatePanel
				tone="error"
				icon={Alert02Icon}
				title="Something went wrong"
				headingLevel="h1"
				meta={reference(error)}
				actions={
					<>
						<Button variant="primary" onClick={() => reset()}>
							Try again
						</Button>
						<Button asChild>
							<Link href="/home">Go to home</Link>
						</Button>
					</>
				}
			>
				{MESSAGE}
			</StatePanel>
		</Card>
	);
}

/** A thrown render outside the product frame (app/error.tsx), inside the root layout. */
export function RootError({ error, reset }: BoundaryProps) {
	const ref = reference(error);
	return (
		<RootState
			title="Something went wrong"
			actions={
				<>
					<button type="button" className={buttonClass()} onClick={() => reset()}>
						Try again
					</button>
					<ButtonLink href="/" variant="secondary">
						Go to the home page
					</ButtonLink>
				</>
			}
		>
			{MESSAGE}
			{ref ? <span className="mt-3 block type-md text-text-3">{ref}</span> : null}
		</RootState>
	);
}
