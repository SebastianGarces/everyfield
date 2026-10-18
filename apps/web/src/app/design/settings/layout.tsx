import { SettingsPreview } from "@/features/settings/preview/SettingsPreview";
import { Suspense, type ReactNode } from "react";

export const metadata = { title: "Settings" };

// The settings dialog lives in this layout, so its drafts survive moving between section URLs (WP-010/ui R2).
export default function SettingsPreviewLayout({ children }: { children: ReactNode }) {
	return (
		<Suspense>
			<SettingsPreview />
			{children}
		</Suspense>
	);
}
