import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getViewer } from "@/server/request-context";
import { PeopleFrame } from "../people/PeopleFrame";
import { dialogSection } from "./model";
import { settingsViewerOf } from "./server";

/**
 * The product root and frame around every /settings page, the same frame as People, so the name button's user menu
 * reaches the other settings pages and People is one click away. Each page still checks its own viewer and access.
 */
export async function SettingsLayout({ children }: { children: ReactNode }) {
	const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
	const v = await getViewer();
	const viewer = v?.people ?? null;
	return (
		<ProductRoot initialTheme={theme}>
			<PeopleFrame name={viewer?.displayName ?? "You"} role={viewer?.role ?? null} settings={settingsViewerOf(v)}>
				{children}
			</PeopleFrame>
		</ProductRoot>
	);
}

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
