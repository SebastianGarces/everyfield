import { Unlink03Icon } from "@hugeicons/core-free-icons";
import { LANDING_ROUTE } from "@everyfield/contracts/identity";
import { Button, Card, StatePanel } from "@everyfield/ui/controls";
import Link from "next/link";
import { ButtonLink } from "@/components/ButtonLink";
import { getViewer } from "@/server/request-context";
import { RootState } from "./RootState";

export async function RootNotFound() {
	const home = (await getViewer()).status === "unauthenticated" ? "/" : LANDING_ROUTE;
	return (
		<RootState title="Page not found" actions={<ButtonLink href={home}>Go to the home page</ButtonLink>}>
			The link may be out of date, or the address may have a typo.
		</RootState>
	);
}

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
				The link may be out of date, or this page is not part of your account.
			</StatePanel>
		</Card>
	);
}
