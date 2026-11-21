"use client";

import { Dialog, DialogBody, DialogContent, DialogHeader } from "@everyfield/ui/controls";
import { Suspense } from "react";
import { lazyModule, LoadFailed, Opened, useLazyModule, type Failure } from "../../components/lazy.tsx";
import type { SettingsDialogProps } from "./SettingsDialog";

export const settingsDialog = lazyModule(() => import("./SettingsDialog"));

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
	const loaded = useLazyModule(settingsDialog);
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
