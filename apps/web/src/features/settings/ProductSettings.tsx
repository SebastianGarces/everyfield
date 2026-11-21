"use client";

import { DASHBOARD_HOME } from "@everyfield/contracts/identity";
import { avatarRoute } from "@everyfield/contracts/settings";
import { useRouter } from "next/navigation";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@everyfield/ui/controls";
import { createContext, Suspense, use, useCallback, useMemo, useRef, useState } from "react";
import { lazyModule, LoadFailed, Opened, useLazyModule, type Failure } from "../../components/lazy.tsx";
import { currentAddress, onTraversal, usePath, writeAddress } from "../../components/location.ts";
import { loadPage } from "../identity/api";
import { saveSourceOrder } from "../wiki/actions";
import { readSourceOrder } from "../wiki/fetch.ts";
import { saveRegion } from "./region";
import { SettingsGuide } from "../wiki/chrome.tsx";
import { finalizeAssetUpload, requestAssetUpload, resetBrand, saveBrand } from "./brand/actions";
import { assetSrc, uploadBytes } from "./brand/bytes";
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
import type { SettingsDialogProps } from "./SettingsDialog";
import { createSettingsStore, type SettingsStore } from "./settings.store";
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

export function LazySettingsDialog(props: SettingsDialogProps) {
	return (
		<Opened open={props.section !== null}>
			<Suspense fallback={null}>
				<Loaded {...props} />
			</Suspense>
		</Opened>
	);
}

function Loaded(props: SettingsDialogProps) {
	const loaded = useLazyModule(dialog);
	if (loaded.module) return <loaded.module.SettingsDialog {...props} />;
	return <Failed {...props} failure={loaded} />;
}

function Failed({ section, onNavigate, failure }: SettingsDialogProps & { failure: Failure }) {
	return (
		<Dialog open={section !== null} onOpenChange={(open) => (open ? undefined : onNavigate(null))}>
			<DialogContent
				size="lg"
				aria-describedby={undefined}
				onCloseAutoFocus={failure.keepFocusOnRetry}
				className="h-[min(720px,calc(100dvh-24px))] max-w-[1040px] overflow-hidden bg-surface"
			>
				<DialogHeader title="Settings" />
				<DialogBody className="grid place-items-center">
					<LoadFailed what="Settings" retry={failure.retry} />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

const pathOf = (href: string | null) => href?.split("?")[0] ?? null;

type SettingsDialogParts = {
	viewer: SettingsViewer;
	port: SettingsPort;
	section: DialogSection | null;
	navigate: (key: SectionKey | null) => void;
	openPage: (key: SectionKey) => void;
	storeFor: (seed: SectionSeed | null) => SettingsStore;
};

export const SettingsDialogContext = createContext<SettingsDialogParts | null>(null);

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

	const navigate = useCallback(
		(key: SectionKey | null) => {
			if (key)
				dialog.whenLoaded(() => {
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

	const parts = useMemo(
		() =>
			viewer
				? { viewer, port, section, navigate, openPage: (key: SectionKey) => router.push(hrefFor(key)), storeFor }
				: null,
		[viewer, port, section, navigate, router, storeFor],
	);
	return { parts, open: (key: DialogSection) => navigate(key) };
}

export function ProductSettingsDialog({ seed }: { seed: SectionSeed | null }) {
	const parts = use(SettingsDialogContext);
	if (!parts) return null;
	const { viewer, section, navigate, openPage, storeFor } = parts;
	return (
		<SettingsProvider key={`${viewer.accountId}-${viewer.context}`} store={storeFor(seed)} viewer={viewer}>
			<LazySettingsDialog
				section={section}
				onNavigate={navigate}
				hrefFor={hrefFor}
				pages={{ sections: ["seats", "sharing"], open: openPage }}
				headerActions={<SettingsGuide />}
				onDeletionRequested={(status) => loadPage(deletionPage(status))}
			/>
		</SettingsProvider>
	);
}

function deletionPage(status: DeletionStatus | null): string {
	const page =
		status && status.status !== "active" && status.subject.kind === "plant"
			? "/workspace-deletion"
			: "/account-deletion";
	return status?.status === "pending_deletion" ? `${page}?until=${encodeURIComponent(status.cancelUntil)}` : page;
}
