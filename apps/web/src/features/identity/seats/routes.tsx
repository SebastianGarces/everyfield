import { Card } from "@everyfield/ui/controls";
import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { viewerOf } from "@/server/organizations";
import { NotAvailable } from "../../access/AccessStates";
import { AFTER_SIGN_IN } from "../SignInScreen";
import { readSeats } from "./actions";
import { parseSeats } from "./model";
import { SeatsScreen } from "./SeatsScreen";

// /settings/seats (screens.md Settings, Seats and invitations). A bare product page inside the product root, like
// /settings/sharing, until the settings dialog and app shell land (ruling U2).

export const seatsMetadata: Metadata = { title: "Seats and invitations", robots: { index: false, follow: false } };

async function Frame({ children }: { children: ReactNode }) {
	const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
	return <ProductRoot initialTheme={theme}>{children}</ProductRoot>;
}

export async function SeatsPage() {
	const who = await viewerOf();
	if (who.kind === "signed_out") redirect("/signin?returnTo=%2Fsettings%2Fseats");
	const read = await readSeats();
	if (read.status !== "ready")
		return (
			<Frame>
				<div className="px-4 py-12">
					<Card className="mx-auto max-w-[560px]">
						<NotAvailable scope="page" homeHref={AFTER_SIGN_IN} />
					</Card>
				</div>
			</Frame>
		);
	return (
		<Frame>
			<SeatsScreen initial={parseSeats(read)} />
		</Frame>
	);
}
