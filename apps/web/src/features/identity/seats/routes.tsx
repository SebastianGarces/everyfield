import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { viewerOf } from "@/server/organizations";
import { NotAvailable } from "../../access/AccessStates";
import { AFTER_SIGN_IN } from "../SignInScreen";
import { readSeats } from "./actions";
import { parseSeats } from "./model";
import { SeatsScreen } from "./SeatsScreen";

// /settings/seats (screens.md Settings, Seats and invitations). It sits inside the settings layout's product frame
// (WP-010) until the settings dialog lands (ruling U2).

export const seatsMetadata: Metadata = { title: "Seats and invitations", robots: { index: false, follow: false } };

export async function SeatsPage() {
	const who = await viewerOf();
	if (who.kind === "signed_out") redirect("/signin?returnTo=%2Fsettings%2Fseats");
	const read = await readSeats();
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
