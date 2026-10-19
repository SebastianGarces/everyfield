import { OrganizationsPreview } from "@/features/organizations/preview/OrganizationsPreview";
import { ORGANIZATION_FLOWS, type OrganizationFlow } from "@/features/organizations/preview/fixtures";
import { notFound } from "next/navigation";
import { Suspense } from "react";

export const metadata = { title: "Organizations" };

export default async function OrganizationsPreviewPage({ params }: { params: Promise<{ flow: string }> }) {
	const flow = (await params).flow;
	if (!(ORGANIZATION_FLOWS as readonly string[]).includes(flow)) notFound();
	return (
		<Suspense>
			<OrganizationsPreview flow={flow as OrganizationFlow} />
		</Suspense>
	);
}
