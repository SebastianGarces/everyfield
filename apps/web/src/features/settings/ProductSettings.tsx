"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
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

/** Opens Settings at `section` over the current page. */
export function openSettings(section: DialogSection) {
	window.history.pushState(null, "", hrefFor(section));
}

export function ProductSettings({ viewer }: { viewer: SettingsViewer }) {
	const pathname = usePathname();
	const router = useRouter();
	const section = dialogSection(pathname.match(/^\/settings\/([a-z]+)$/)?.[1]);
	// The address of the page underneath, kept while Settings is closed. Null after a fresh load of a section link.
	const underneath = useRef<string | null>(null);
	useEffect(() => {
		if (!section) underneath.current = window.location.pathname + window.location.search;
	}, [section, pathname]);

	const navigate = (key: SectionKey | null) => {
		if (key) window.history.pushState(null, "", hrefFor(key));
		else if (underneath.current) window.history.pushState(null, "", underneath.current);
		else router.push(viewer.context === "plant" ? "/people" : "/settings/sharing");
	};

	return (
		<SettingsProvider key={`${viewer.accountId}-${viewer.context}`} port={PORT} viewer={viewer}>
			<SettingsDialog
				section={section}
				onNavigate={navigate}
				hrefFor={hrefFor}
				// A deletion request ends the session; deletion is not offered here yet (SettingsPort.flows).
				onDeletionRequested={() => loadPage("/signin")}
			/>
		</SettingsProvider>
	);
}
