import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessPreview } from "./AccessPreview";
import { ACCESS_FLOWS, type AccessFlow } from "./fixtures";

export async function AccessPreviewPage({ params }: { params: Promise<{ flow: string }> }) {
	const flow = (await params).flow;
	if (!(ACCESS_FLOWS as readonly string[]).includes(flow)) notFound();
	return (
		<Suspense>
			<AccessPreview flow={flow as AccessFlow} />
		</Suspense>
	);
}
