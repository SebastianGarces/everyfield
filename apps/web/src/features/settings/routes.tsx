import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/server/request-context";
import { dialogSection } from "./model";

export const settingsMetadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

/**
 * A fresh load of a settings section link (/settings/account). The frame's Settings dialog opens from the address;
 * this page is what lies underneath it. Signed-out visitors sign in and come back.
 */
export async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
	const section = dialogSection((await params).section);
	if (!section) notFound();
	const v = await getViewer();
	if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent(`/settings/${section}`)}`);
	return <h1 className="sr-only">Settings</h1>;
}

/**
 * /settings is the Settings dialog on the first section this viewer is offered, in one request: the frame's dialog
 * picks that section from the address (ProductSettings), so no role meets a missing page and there is no redirect.
 */
export async function SettingsIndexPage() {
	const v = await getViewer();
	if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent("/settings")}`);
	return <h1 className="sr-only">Settings</h1>;
}
