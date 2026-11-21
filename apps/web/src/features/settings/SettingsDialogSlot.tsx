"use client";

import { createContext, use } from "react";
import { LazySettingsDialog } from "./LazySettingsDialog";
import type { DialogSection } from "./model";
import type { SectionKey, SectionSeed, SettingsViewer } from "./port";
import type { SettingsDialogProps } from "./SettingsDialog";
import type { SettingsStore } from "./settings.store";
import { SettingsProvider } from "./store";

export type SettingsDialogParts = {
	viewer: SettingsViewer;
	section: DialogSection | null;
	navigate: (key: SectionKey | null) => void;
	storeFor: (seed: SectionSeed | null) => SettingsStore;
	dialog: Pick<SettingsDialogProps, "hrefFor" | "pages" | "headerActions" | "onDeletionRequested">;
};

export const SettingsDialogContext = createContext<SettingsDialogParts | null>(null);

export function ProductSettingsDialog({ seed }: { seed: SectionSeed | null }) {
	const parts = use(SettingsDialogContext);
	if (!parts) return null;
	const { viewer, section, navigate, storeFor, dialog } = parts;
	return (
		<SettingsProvider key={`${viewer.accountId}-${viewer.context}`} store={storeFor(seed)} viewer={viewer}>
			<LazySettingsDialog section={section} onNavigate={navigate} {...dialog} />
		</SettingsProvider>
	);
}
