import { FOUNDATION_ARTICLES } from "@/features/onboarding/foundations";
import { OnboardingPreview } from "@/features/onboarding/preview/OnboardingPreview";
import { Suspense } from "react";

export const metadata = { title: "Onboarding" };

export default function OnboardingPreviewPage() {
	return (
		<Suspense>
			<OnboardingPreview articles={FOUNDATION_ARTICLES} />
		</Suspense>
	);
}
