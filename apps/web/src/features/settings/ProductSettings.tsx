"use client";

import { DASHBOARD_HOME } from "@everyfield/contracts/identity";
import { avatarRoute } from "@everyfield/contracts/settings";
import { useRouter } from "next/navigation";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@everyfield/ui/controls";
import { Suspense, useRef, useState } from "react";
import { lazyModule, LoadState, Opened, useLazyModule } from "../../components/lazy.tsx";
import { currentAddress, onTraversal, usePath, writeAddress } from "../../components/location.ts";
import { loadPage } from "../identity/api";
import { readSourceOrder, saveSourceOrder } from "../wiki/actions";
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
import type { SettingsDialogProps } from "./SettingsDialog";
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

const dialog = lazyModule(() => import("./SettingsDialog"));

function LazySettingsDialog(props: SettingsDialogProps) {
	return (
		<Opened open={props.section !== null}>
			<Suspense fallback={<Unloaded {...props} />}>
				<Loaded {...props} />
			</Suspense>
		</Opened>
	);
}

function Loaded(props: SettingsDialogProps) {
	const loaded = useLazyModule(dialog);
	if (loaded.module) return <loaded.module.SettingsDialog {...props} />;
	return <Unloaded {...props} retry={loaded.retry} />;
}

function Unloaded({ section, onNavigate, retry }: SettingsDialogProps & { retry?: () => void }) {
	return (
		<Dialog open={section !== null} onOpenChange={(open) => (open ? undefined : onNavigate(null))}>
			<DialogContent
				size="lg"
				aria-describedby={undefined}
				className="h-[min(720px,calc(100dvh-24px))] max-w-[1040px] overflow-hidden bg-surface"
			>
				<DialogHeader title="Settings" />
				<DialogBody className="grid place-items-center">
					<LoadState what="Settings" retry={retry} />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

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
			dialog.preload();
			if (!section) setUnderneath(currentAddress());
			writeAddress(hrefFor(key));
		} else if (underneath) {
			writeAddress(underneath);
			refreshUnderneath();
		} else router.push(viewer?.context === "plant" ? DASHBOARD_HOME : "/settings/sharing");
	};

	const element = viewer ? (
		<SettingsProvider key={`${viewer.accountId}-${viewer.context}`} port={port} viewer={viewer} seed={seed}>
			<LazySettingsDialog
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
