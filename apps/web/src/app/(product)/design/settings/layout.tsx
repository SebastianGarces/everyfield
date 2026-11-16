import { SettingsPreview } from "@/features/settings/preview/SettingsPreview";
import { Suspense, type ReactNode } from "react";

export const metadata = { title: "Settings" };

export default function SettingsPreviewLayout({ children }: { children: ReactNode }) {
	return (
		<Suspense>
			<SettingsPreview />
			{children}
		</Suspense>
	);
}
