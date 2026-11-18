import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { parseSectionKey } from "../model";
import { SettingsPreview } from "./SettingsPreview";

export function SettingsPreviewLayout({ children }: { children: ReactNode }) {
	return (
		<Suspense>
			<SettingsPreview />
			{children}
		</Suspense>
	);
}

export async function SettingsPreviewSectionPage({ params }: { params: Promise<{ section?: string[] }> }) {
	const section = (await params).section;
	if (section && (section.length > 1 || !parseSectionKey(section[0]))) notFound();
	return null;
}
