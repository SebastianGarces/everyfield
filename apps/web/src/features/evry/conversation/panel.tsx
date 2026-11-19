"use client";

import { EvryBot } from "@everyfield/ui/foundations";
import { Sheet } from "@everyfield/ui/controls";
import { Suspense } from "react";
import { lazyModule, LoadFailed, Opened, useLazyModule, type Failure } from "@/components/lazy";
import { storeContext, useLocalStore, useStore } from "@/components/store";
import * as api from "./api.ts";
import { createEvryPanelStore, type EvryPanelState, type EvryPort } from "./EvryPanel.store.ts";
import { checkPhoto, stageAttached } from "./PhotoAttach.tsx";

const PORT: EvryPort = { ...api, checkPhoto, stagePhoto: stageAttached };
export const Panel = storeContext<EvryPanelState>("EvryPanel");

const panel = lazyModule(() => import("./EvryPanel.tsx"));

type PanelProps = { inPlant: boolean; context: string };

export function useEvryPanel({ inPlant, off = false, context }: PanelProps & { off?: boolean }) {
	const store = useLocalStore(() => createEvryPanelStore({ context, port: PORT }));
	const open = useStore(store, (s) => s.open);
	return {
		open,
		toggle: () => {
			panel.preload();
			store.getState().actions.toggle();
		},
		element: off ? null : (
			<Panel.Provider value={store}>
				<Opened open={open}>
					<Suspense fallback={null}>
						<Loaded inPlant={inPlant} context={context} />
					</Suspense>
				</Opened>
			</Panel.Provider>
		),
	};
}

function Loaded(props: PanelProps) {
	const loaded = useLazyModule(panel);
	if (loaded.module) return <loaded.module.EvryPanel {...props} />;
	return <Failed failure={loaded} />;
}

function Failed({ failure }: { failure: Failure }) {
	const open = Panel.useSelect((s) => s.open);
	const show = Panel.useSelect((s) => s.actions.show);
	return (
		<Sheet
			open={open}
			onOpenChange={show}
			modal={false}
			onCloseAutoFocus={failure.keepFocusOnRetry}
			className="w-[560px] max-w-[calc(100vw-24px)]"
			title={
				<span className="flex items-center gap-3">
					<EvryBot size="md" mood="idle" />
					Evry
				</span>
			}
			description="Reads and drafts. You approve every change."
		>
			<LoadFailed what="Evry" retry={failure.retry} />
		</Sheet>
	);
}
