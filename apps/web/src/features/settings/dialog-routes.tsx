import { getViewer } from "@/server/request-context";
import { readBrand } from "./brand/server";
import { readSection, settingsViewerOf } from "./server";
import { dialogSection, firstSection, offeredSections, sectionRequest, type DialogSection } from "./model";
import type { SectionSeed, SettingsViewer } from "./port";
import { ProductSettingsDialog } from "./ProductSettings";

function sectionSeed(viewer: SettingsViewer | null, section: DialogSection | null): SectionSeed | null {
	if (viewer && section === "brand" && offeredSections(viewer, []).includes("brand"))
		return { brand: getViewer().then(readBrand) };
	const request = viewer && section ? sectionRequest(viewer, section) : null;
	if (!request) return null;
	return { request, value: getViewer().then((session) => readSection(session, request)) };
}

export async function SettingsSectionDialog({ params }: { params: Promise<{ section: string }> }) {
	const viewer = settingsViewerOf(await getViewer());
	return <ProductSettingsDialog seed={sectionSeed(viewer, dialogSection((await params).section))} />;
}

export async function SettingsIndexDialog() {
	const viewer = settingsViewerOf(await getViewer());
	return <ProductSettingsDialog seed={sectionSeed(viewer, viewer ? firstSection(viewer) : null)} />;
}

export function SettingsDialogElsewhere() {
	return <ProductSettingsDialog seed={null} />;
}
