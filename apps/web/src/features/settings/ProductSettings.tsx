"use client";

import { DASHBOARD_HOME } from "@everyfield/contracts/identity";
import { avatarRoute } from "@everyfield/contracts/settings";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { currentAddress, onTraversal, usePath, writeAddress } from "../../components/location.ts";
import { loadPage } from "../identity/api";
import { saveSourceOrder } from "../wiki/actions";
import { readSourceOrder } from "../wiki/fetch.ts";
import { readRegion, saveRegion, suggestRegion } from "./region";
import { SettingsGuide } from "../wiki/chrome.tsx";
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

const pathOf = (href: string | null) => href?.split("?")[0] ?? null;

export function useProductSettings(viewer: SettingsViewer | null, seed: SectionSeed | null = null) {
	const path = usePath();
	const router = useRouter();
	const section = sectionAt(path, viewer);
	const [underneath, setUnderneath] = useState<string | null>(null);
	if (!section && pathOf(underneath) !== path) setUnderneath(path);

	const refreshAfterClose = useRef<(() => void) | null>(null);
	const refreshUnderneath = () => {
		const refresh = refreshAfterClose.current;
		refreshAfterClose.current = null;
		refresh?.();
	};
	const [port] = useState<SettingsPort>(() => ({
		...PORT,
		wiki: {
			...PORT.wiki,
			save: async (...args) => {
				const reply = await PORT.wiki.save(...args);
				if (reply.status === "ok" && !refreshAfterClose.current) {
					const stop = onTraversal(() => {
						if (!sectionAt(window.location.pathname, viewer)) refreshUnderneath();
					});
					refreshAfterClose.current = () => {
						stop();
						router.refresh();
					};
				}
				return reply;
			},
		},
	}));

	const navigate = (key: SectionKey | null) => {
		if (key) {
			if (!section) setUnderneath(currentAddress());
			writeAddress(hrefFor(key));
		} else if (underneath) {
			writeAddress(underneath);
			refreshUnderneath();
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
