import { parseSectionKey } from "@/features/settings/model";
import { notFound } from "next/navigation";

export default async function SettingsSectionPage({ params }: { params: Promise<{ section?: string[] }> }) {
	const section = (await params).section;
	if (section && (section.length > 1 || !parseSectionKey(section[0]))) notFound();
	return null;
}
