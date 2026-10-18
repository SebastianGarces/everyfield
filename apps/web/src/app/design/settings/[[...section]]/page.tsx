import { parseSectionKey } from "@/features/settings/model";
import { notFound } from "next/navigation";

// /design/settings is the page underneath with settings closed; /design/settings/<section> opens one section.
export default async function SettingsSectionPage({ params }: { params: Promise<{ section?: string[] }> }) {
	const section = (await params).section;
	if (section && (section.length > 1 || !parseSectionKey(section[0]))) notFound();
	return null;
}
