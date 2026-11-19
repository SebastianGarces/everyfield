import { signIn } from "@/server/request-context";
import { loadMyResidency, loadResidentReading, residentActor } from "./server";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { NotAvailable } from "../access/AccessStates";
import { MyResidencyScreen } from "./MyResidencyScreen";
import { MY_RESIDENCY_PATH, readingPath } from "./model";
import { ResidentReadingScreen } from "./ResidentReadingScreen";

export const myResidencyMetadata: Metadata = { title: "My residency", robots: { index: false, follow: false } };

const refused = (
	<div className="py-12">
		<Card className="mx-auto max-w-[560px]">
			<NotAvailable scope="page" homeHref="/home" />
		</Card>
	</div>
);

async function account(path: string) {
	const who = await residentActor();
	if (who === "signed_out") signIn(path);
	return who;
}

export async function MyResidencyPage() {
	const authority = await account(MY_RESIDENCY_PATH);
	if (!authority) return refused;
	const residency = await loadMyResidency(authority);
	if (residency.status !== "ok" || residency.value.status === "not_linked") return refused;
	return <MyResidencyScreen initial={residency.value} />;
}

export async function ResidentReadingPage({ params }: { params: Promise<{ readingId: string }> }) {
	const { readingId } = await params;
	const authority = await account(readingPath(readingId));
	if (!authority) return refused;
	const reading = await loadResidentReading(authority, readingId);
	if (reading.status !== "ok") return refused;
	return <ResidentReadingScreen reading={reading.value} />;
}
