import { describeMessagesOptOut } from "@everyfield/domain/communication";
import type { Metadata } from "next";
import { UnsubscribeScreen, type UnsubscribeView } from "./UnsubscribeScreen.tsx";
import { unsubscribeCall } from "./unsubscribe.ts";

// The Unsubscribe link of a Messages email (REQ-NTF-016). Opening it only describes the token, so a mail scanner that
// follows the link changes nothing; a malformed, tampered or wrong-purpose token reads as invalid.

export const unsubscribeMetadata: Metadata = {
	title: "Unsubscribe",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
	const token = (await params).token;
	return <UnsubscribeScreen token={token} view={await describe(token)} />;
}

async function describe(token: string): Promise<UnsubscribeView> {
	const r = await unsubscribeCall(({ db, ring }) => describeMessagesOptOut(db, ring, { token }));
	if (r.status === "lost") return { state: "unavailable" };
	if (r.status === "refused") return r.code === "unavailable" ? { state: "unavailable" } : { state: "invalid" };
	return { state: "open", churchName: r.value.churchName, unsubscribed: r.value.unsubscribed };
}
