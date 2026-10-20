import { AccessPreview } from "@/features/access/preview/AccessPreview";
import { ACCESS_FLOWS, type AccessFlow } from "@/features/access/preview/fixtures";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export const metadata = { title: "Access" };

export default async function AccessPreviewPage({ params }: { params: Promise<{ flow: string }> }) {
	const flow = (await params).flow;
	if (!(ACCESS_FLOWS as readonly string[]).includes(flow)) notFound();
	return (
		<Suspense>
			<AccessPreview flow={flow as AccessFlow} />
		</Suspense>
	);
}
