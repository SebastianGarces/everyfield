"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { loadPage } from "../identity/api";
import {
	finalizeAssetUpload,
	getBrand,
	requestAssetUpload,
	resetBrand,
	saveBrand,
	suggestColors,
} from "./brand/actions";
import { assetSrc, uploadBytes } from "./brand/bytes";
import {
	changePassword,
	getSection,
	previewPersonalTimezone,
	previewPlantTimezone,
	requestAccountDeletion,
	requestEmailChange,
	saveChurch,
	saveSection,
	setPersonalTimezone,
	setPlantTimezone,
} from "./actions";
import { sectionAt, type DialogSection } from "./model";
import type { DeletionStatus, SectionKey, SectionSeed, SettingsPort, SettingsViewer } from "./port";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsProvider } from "./store";

// Settings in the product (screens.md, Settings): a dialog over the current page, with one link per section. Opening
// or switching a section writes /settings/<section> to the address with history.pushState, which Next.js keeps in
// step with usePathname, so the page underneath stays as it was and makes no request. Closing writes the page's
// address back; Back and Forward move between those entries. A fresh load of a section link renders the settings
// route (app/settings/[section]), and closing then goes to the viewer's home page. /settings shows the first section
// the viewer is offered without changing the address.

// The photo stays out until a private bucket exists (Q2), and church workspace deletion until it has a server action:
// their rows are then not shown at all.
const PORT: SettingsPort = {
	getSection,
	saveSection,
	saveChurch,
	previewPlantTimezone,
	setPlantTimezone,
	brand: {
		get: getBrand,
		save: saveBrand,
		reset: resetBrand,
		requestUpload: requestAssetUpload,
		uploadBytes,
		finalizeUpload: finalizeAssetUpload,
		suggestColors,
		assetSrc,
	},
	flows: { requestEmailChange, changePassword, previewPersonalTimezone, setPersonalTimezone, requestAccountDeletion },
};
const hrefFor = (key: SectionKey) => `/settings/${key}`;

/**
 * The product's Settings dialog and a way to open it. The dialog shows the section asked for in the same event as
 * the click, before Next.js reports the new address, so it opens while the opener still has focus and Escape
 * returns focus there.
 */
export function useProductSettings(viewer: SettingsViewer | null, seed: SectionSeed | null = null) {
	const pathname = usePathname();
	const router = useRouter();
	const atPath = sectionAt(pathname, viewer);
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
		<SettingsProvider key={`${viewer.accountId}-${viewer.context}`} port={PORT} viewer={viewer} seed={seed}>
			<SettingsDialog
				section={section}
				onNavigate={navigate}
				hrefFor={hrefFor}
				// The request ended every session, so the next page is a full load of the restricted deletion page.
				onDeletionRequested={(status) => loadPage(deletionPage(status))}
			/>
		</SettingsProvider>
	) : null;
	return { element, open: (key: DialogSection) => navigate(key) };
}

/** The restricted deletion page, with the deadline the request returned when the request is known to be pending. */
export function deletionPage(status: DeletionStatus | null): string {
	return status?.status === "pending_deletion"
		? `/account-deletion?until=${encodeURIComponent(status.cancelUntil)}`
		: "/account-deletion";
}
