"use client";

import { DASHBOARD_HOME } from "@everyfield/contracts/identity";
import { avatarRoute } from "@everyfield/contracts/settings";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadPage } from "../identity/api";
import { readSourceOrder, saveSourceOrder } from "../wiki/actions";
import { readRegion, saveRegion, suggestRegion } from "./region";
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
	region: { read: readRegion, suggest: suggestRegion, save: saveRegion },
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

export function useProductSettings(viewer: SettingsViewer | null, seed: SectionSeed | null = null) {
	const pathname = usePathname();
	const router = useRouter();
	const atPath = sectionAt(pathname, viewer);
	const [asked, setAsked] = useState<{ section: SectionKey | null; path: string } | undefined>(undefined);
	if (asked && asked.path !== pathname) setAsked(undefined);
	const section = asked ? asked.section : atPath;
	const underneath = useRef<string | null>(null);
	useEffect(() => {
		if (!atPath) underneath.current = window.location.pathname + window.location.search;
	}, [atPath, pathname]);

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
				headerActions={<SettingsGuide />}
				onDeletionRequested={(status) => loadPage(deletionPage(status))}
			/>
		</SettingsProvider>
	) : null;
	return { element, open: (key: DialogSection) => navigate(key) };
}

function deletionPage(status: DeletionStatus | null): string {
	const page =
		status && status.status !== "active" && status.subject.kind === "plant"
			? "/workspace-deletion"
			: "/account-deletion";
	return status?.status === "pending_deletion" ? `${page}?until=${encodeURIComponent(status.cancelUntil)}` : page;
}
