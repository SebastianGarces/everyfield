import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ORGANIZATION_FLOWS, type OrganizationFlow } from "./fixtures";
import { OrganizationsPreview } from "./OrganizationsPreview";

export async function OrganizationsPreviewPage({ params }: { params: Promise<{ flow: string }> }) {
	const flow = (await params).flow;
	if (!(ORGANIZATION_FLOWS as readonly string[]).includes(flow)) notFound();
	return (
		<Suspense>
			<OrganizationsPreview flow={flow as OrganizationFlow} />
		</Suspense>
	);
}
