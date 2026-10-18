import { RESTRICTED_FLOWS, RestrictedPreview, type RestrictedFlow } from "@/features/settings/preview/RestrictedPreview";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export const metadata = { title: "Restricted" };

export default async function RestrictedPage({ params }: { params: Promise<{ flow: string }> }) {
	const flow = (await params).flow;
	if (!(RESTRICTED_FLOWS as readonly string[]).includes(flow)) notFound();
	return (
		<Suspense>
			<RestrictedPreview flow={flow as RestrictedFlow} />
		</Suspense>
	);
}
