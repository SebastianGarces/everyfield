import { FOUNDATION_ARTICLES } from "@/features/onboarding/foundations";
import { OnboardingPreview } from "@/features/onboarding/preview/OnboardingPreview";
import { Suspense } from "react";

export const metadata = { title: "Onboarding" };

// The onboarding screens on the fixture API (WP-009/ui R8). The /design layout returns 404 in production.
export default function OnboardingPreviewPage() {
	return (
		<Suspense>
			<OnboardingPreview articles={FOUNDATION_ARTICLES} />
		</Suspense>
	);
}
