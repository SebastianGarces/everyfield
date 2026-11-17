"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Button, Card, StatePanel } from "@everyfield/ui/controls";
import Link from "next/link";
import { ButtonLink, buttonClass } from "@/components/ButtonLink";
import { RootState } from "./RootState";

export type BoundaryProps = { error: Error & { digest?: string }; reset: () => void };

const MESSAGE = "This page ran into a problem. Try again, and if it keeps happening, come back in a few minutes.";

function reference(error: BoundaryProps["error"]) {
	return error.digest ? `Error reference ${error.digest}` : undefined;
}

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

export function GlobalErrorDocument({ className, ...props }: BoundaryProps & { className?: string }) {
	return (
		<html lang="en" className={className}>
			<body>
				<title>Something went wrong · Everyfield</title>
				<RootError {...props} />
			</body>
		</html>
	);
}
