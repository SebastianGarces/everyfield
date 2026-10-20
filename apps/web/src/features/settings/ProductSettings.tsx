"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { loadPage } from "../identity/api";
import { getSection, previewPlantTimezone, saveSection, setPlantTimezone } from "./actions";
import { dialogSection, type DialogSection } from "./model";
import type { SectionKey, SettingsPort, SettingsViewer } from "./port";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsProvider } from "./store";

// Settings in the product (screens.md, Settings): a dialog over the current page, with one link per section. Opening
// or switching a section writes /settings/<section> to the address with history.pushState, which Next.js keeps in
// step with usePathname, so the page underneath stays as it was and makes no request. Closing writes the page's
// address back; Back and Forward move between those entries. A fresh load of a section link renders the settings
// route (app/settings/[section]), and closing then goes to the viewer's home page.

const PORT: SettingsPort = { getSection, saveSection, previewPlantTimezone, setPlantTimezone };
const hrefFor = (key: SectionKey) => `/settings/${key}`;

/**
 * The product's Settings dialog and a way to open it. The dialog shows the section asked for in the same event as
 * the click, before Next.js reports the new address, so it opens while the opener still has focus and Escape
 * returns focus there.
 */
export function useProductSettings(viewer: SettingsViewer | null) {
	const pathname = usePathname();
	const router = useRouter();
	const atPath = dialogSection(pathname.match(/^\/settings\/([a-z]+)$/)?.[1]);
	// The section asked for in this document until the address catches up; undefined means "follow the address".
	const [asked, setAsked] = useState<{ section: SectionKey | null; path: string } | undefined>(undefined);
	if (asked && asked.path !== pathname) setAsked(undefined);
	const section = asked ? asked.section : atPath;
	// The address of the page underneath, kept while Settings is closed. Null after a fresh load of a section link.
	const underneath = useRef<string | null>(null);
	useEffect(() => {
		if (!atPath) underneath.current = window.location.pathname + window.location.search;
	}, [atPath, pathname]);

	const navigate = (key: SectionKey | null) => {
		if (key || underneath.current) {
			setAsked({ section: key, path: pathname });
			window.history.pushState(null, "", key ? hrefFor(key) : underneath.current);
		} else router.push(viewer?.context === "plant" ? "/people" : "/settings/sharing");
	};

	const element = viewer ? (
		<SettingsProvider key={`${viewer.accountId}-${viewer.context}`} port={PORT} viewer={viewer}>
			<SettingsDialog
				section={section}
				onNavigate={navigate}
				hrefFor={hrefFor}
				// A deletion request ends the session; deletion is not offered here yet (SettingsPort.flows).
				onDeletionRequested={() => loadPage("/signin")}
			/>
		</SettingsProvider>
	) : null;
	return { element, open: (key: DialogSection) => navigate(key) };
}
