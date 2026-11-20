import { requireActor } from "@/server/sign-in";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { NotAvailable } from "../../access/AccessStates";
import { AFTER_SIGN_IN } from "../SignInScreen";
import { loadSeats, workspaceViewer } from "./server";
import { parseSeats } from "./model";
import { SeatsScreen } from "./SeatsScreen";

export const seatsMetadata: Metadata = { title: "Seats and invitations", robots: { index: false, follow: false } };

export async function SeatsPage() {
	await requireActor("/settings/seats");
	const read = await loadSeats(await workspaceViewer());
	if (read.status !== "ready")
		return (
			<div className="py-12">
				<Card className="mx-auto max-w-[560px]">
					<NotAvailable scope="page" homeHref={AFTER_SIGN_IN} />
				</Card>
			</div>
		);
	return <SeatsScreen initial={parseSeats(read)} />;
}
