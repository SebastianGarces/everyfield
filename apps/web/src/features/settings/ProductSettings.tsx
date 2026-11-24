"use client";

import { brandAssetPath } from "@everyfield/contracts/common";
import { DASHBOARD_HOME } from "@everyfield/contracts/identity";
import { avatarRoute } from "@everyfield/contracts/settings";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { currentAddress, onTraversal, usePath, writeAddress } from "../../components/location.ts";
import { loadPage } from "../identity/api";
import { saveSourceOrder } from "../wiki/actions";
import { readSourceOrder } from "../wiki/fetch.ts";
import { saveRegion } from "./region";
import { SettingsGuide } from "../wiki/chrome.tsx";
import { finalizeAssetUpload, requestAssetUpload, resetBrand, saveBrand } from "./brand/actions";
import { uploadBytes } from "./brand/bytes";
import {
	changePassword,
	finalizeAvatar,
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
import { getSection, getBrand, suggestColors, readRegion, suggestRegion } from "./fetch.ts";
import { uploadAvatarBytes } from "./flows/avatarBytes";
import { sectionAt, type DialogSection } from "./model";
import type { DeletionStatus, SectionKey, SectionSeed, SettingsPort, SettingsViewer } from "./port";
import { settingsDialog } from "./LazySettingsDialog";
import type { SettingsDialogParts } from "./SettingsDialogSlot";
import { createSettingsStore, type SettingsStore } from "./settings.store";

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
		assetSrc: brandAssetPath,
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

export function useProductSettings(viewer: SettingsViewer | null, seedFits: boolean) {
	const path = usePath();
	const router = useRouter();
	const section = sectionAt(path, viewer);
	const [underneath, setUnderneath] = useState<string | null>(null);
	if (!section && pathOf(underneath) !== path) setUnderneath(path);

	const refreshAfterClose = useRef<(() => void) | null>(null);
	const refreshUnderneath = useCallback(() => {
		const refresh = refreshAfterClose.current;
		refreshAfterClose.current = null;
		refresh?.();
	}, []);
	const refreshOnClose =
		<A extends unknown[], R extends { status: string }>(save: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			const reply = await save(...args);
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
		};
	const [port] = useState<SettingsPort>(() => ({
		...PORT,
		saveChurch: refreshOnClose(PORT.saveChurch),
		wiki: { ...PORT.wiki, save: refreshOnClose(PORT.wiki.save) },
	}));

	const navigate = useCallback(
		(key: SectionKey | null) => {
			if (key)
				settingsDialog.whenLoaded(() => {
					if (!section) setUnderneath(currentAddress());
					writeAddress(hrefFor(key));
				});
			else if (underneath) {
				writeAddress(underneath);
				refreshUnderneath();
			} else router.push(viewer?.context === "plant" ? DASHBOARD_HOME : "/settings/sharing");
		},
		[section, underneath, refreshUnderneath, router, viewer],
	);

	const held = useRef<{ key: string; store: SettingsStore } | null>(null);
	const storeFor = useCallback(
		(seed: SectionSeed | null) => {
			const key = viewer ? `${viewer.accountId}-${viewer.context}` : "";
			if (held.current?.key !== key)
				held.current = { key, store: createSettingsStore({ port, seed: seedFits ? seed : null }) };
			return held.current.store;
		},
		[viewer, port, seedFits],
	);

	const parts = useMemo<SettingsDialogParts | null>(
		() =>
			viewer
				? {
						viewer,
						section,
						navigate,
						storeFor,
						dialog: {
							hrefFor,
							pages: { sections: ["seats", "sharing"], open: (key: SectionKey) => router.push(hrefFor(key)) },
							headerActions: <SettingsGuide />,
							onDeletionRequested: (status: DeletionStatus | null) => loadPage(deletionPage(status)),
						},
					}
				: null,
		[viewer, section, navigate, router, storeFor],
	);
	return { parts, open: (key: DialogSection) => navigate(key) };
}

function deletionPage(status: DeletionStatus | null): string {
	const page = status?.subject.kind === "plant" ? "/workspace-deletion" : "/account-deletion";
	return status?.status === "pending_deletion" ? `${page}?until=${encodeURIComponent(status.cancelUntil)}` : page;
}
