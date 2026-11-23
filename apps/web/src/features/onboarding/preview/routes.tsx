import { Suspense } from "react";
import { FOUNDATION_ARTICLES } from "../foundations";
import { OnboardingPreview } from "./OnboardingPreview";

export function OnboardingPreviewPage() {
	return (
		<Suspense>
			<OnboardingPreview articles={FOUNDATION_ARTICLES} />
		</Suspense>
	);
}
