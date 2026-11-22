import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RESTRICTED_FLOWS, type RestrictedFlow } from "./flows";
import { RestrictedPreview } from "./RestrictedPreview";

export async function RestrictedPreviewPage({ params }: { params: Promise<{ flow: string }> }) {
	const flow = (await params).flow;
	if (!(RESTRICTED_FLOWS as readonly string[]).includes(flow)) notFound();
	return (
		<Suspense>
			<RestrictedPreview flow={flow as RestrictedFlow} />
		</Suspense>
	);
}
