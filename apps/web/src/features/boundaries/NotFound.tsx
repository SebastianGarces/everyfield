import { Unlink03Icon } from "@hugeicons/core-free-icons";
import { Button, Card, StatePanel } from "@everyfield/ui/controls";
import Link from "next/link";
import { ButtonLink } from "@/components/ButtonLink";
import { RootState } from "./RootState";

/** An unknown address outside the product frame (app/not-found.tsx). Next answers it with status 404. */
export function RootNotFound() {
	return (
		<RootState title="Page not found" actions={<ButtonLink href="/">Go to the home page</ButtonLink>}>
			The link may be out of date, or the address may have a typo.
		</RootState>
	);
}

/**
 * A notFound() inside the signed-in product frame ((frame)/not-found.tsx): an unknown settings section, a malformed or
 * missing follow-up. The shell stays around it; Home sends the viewer to their own landing page.
 */
export function FrameNotFound() {
	return (
		<Card>
			<StatePanel
				icon={Unlink03Icon}
				title="Page not found"
				headingLevel="h1"
				actions={
					<Button asChild variant="primary">
						<Link href="/home">Go to home</Link>
					</Button>
				}
			>
				The link may be out of date, or this page is not part of your workspace.
			</StatePanel>
		</Card>
	);
}
