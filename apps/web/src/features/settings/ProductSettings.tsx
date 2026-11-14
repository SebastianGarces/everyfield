"use client";

import { DASHBOARD_HOME } from "@everyfield/contracts/identity";
import { avatarRoute } from "@everyfield/contracts/settings";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadPage } from "../identity/api";
import { readSourceOrder, saveSourceOrder } from "../wiki/actions";
import { SettingsGuide } from "../wiki/client.tsx";
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
	finalizeAvatar,
	getSection,
	previewPersonalTimezone,
	previewPlantTimezone,
	removeAvatar,
	requestAccountDeletion,
	requestAvatarUpload,
	requestEmailChange,
	requestWorkspaceDeletion,
	saveChurch,
	saveSection,
	setPersonalTimezone,
	setPlantTimezone,
} from "./actions";
import { uploadAvatarBytes } from "./flows/avatarBytes";
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
	wiki: { read: readSourceOrder, save: saveSourceOrder },
	flows: {
		avatar: { requestAvatarUpload, uploadAvatarBytes, finalizeAvatar, removeAvatar, avatarSrc: avatarRoute },
		requestEmailChange,
		changePassword,
		previewPersonalTimezone,
		setPersonalTimezone,
		requestAccountDeletion,
		requestWorkspaceDeletion,
	},
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

	// A saved Wiki source order changes which version the page underneath shows, so it is read again once the address
	// is that page's again (the router refreshes the address it holds).
	const stale = useRef(false);
	const port = useMemo<SettingsPort>(
		() => ({
			...PORT,
			wiki: {
				...PORT.wiki,
				save: async (...args) => {
					const reply = await PORT.wiki.save(...args);
					if (reply.status === "ok") stale.current = true;
					return reply;
				},
			},
		}),
		[],
	);
	useEffect(() => {
		if (atPath || !stale.current) return;
		stale.current = false;
		router.refresh();
	}, [atPath, router]);

	const navigate = (key: SectionKey | null) => {
		if (key || underneath.current) {
			setAsked({ section: key, path: pathname });
			window.history.pushState(null, "", key ? hrefFor(key) : underneath.current);
		} else router.push(viewer?.context === "plant" ? DASHBOARD_HOME : "/settings/sharing");
	};

	const element = viewer ? (
		<SettingsProvider key={`${viewer.accountId}-${viewer.context}`} port={port} viewer={viewer} seed={seed}>
			<SettingsDialog
				section={section}
				onNavigate={navigate}
				hrefFor={hrefFor}
				pages={{ sections: ["seats", "sharing"], open: (key) => router.push(hrefFor(key)) }}
				// The dialog covers the frame's Guide button, so it carries its own (WP-034).
				headerActions={<SettingsGuide />}
				// The request ended every session, so the next page is a full load of the restricted deletion page.
				onDeletionRequested={(status) => loadPage(deletionPage(status))}
			/>
		</SettingsProvider>
	) : null;
	return { element, open: (key: DialogSection) => navigate(key) };
}

/**
 * The restricted deletion page for the request's subject (a church workspace or your account), with the deadline the
 * request returned when it is known to be pending. A reply that never arrived came from your account's dialog.
 */
function deletionPage(status: DeletionStatus | null): string {
	const page =
		status && status.status !== "active" && status.subject.kind === "plant"
			? "/workspace-deletion"
			: "/account-deletion";
	return status?.status === "pending_deletion" ? `${page}?until=${encodeURIComponent(status.cancelUntil)}` : page;
}
