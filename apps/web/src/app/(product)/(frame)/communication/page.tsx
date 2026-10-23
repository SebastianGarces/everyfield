import { CommunicationRegister } from "@/features/communication/register";
import { getViewer } from "@/server/request-context";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
	title: "Communication",
	robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function CommunicationPage() {
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated") redirect("/signin?returnTo=%2Fcommunication");
	return (
		<>
			<h1>Communication</h1>
			<CommunicationRegister />
		</>
	);
}
