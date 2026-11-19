"use client";

import { Dialog, DialogBody, DialogContent, DialogHeader } from "@everyfield/ui/controls";
import { Suspense } from "react";
import { lazyModule, LoadFailed, Opened, useLazyModule } from "../../components/lazy.tsx";

type FeedbackProps = { open: boolean; onOpenChange: (open: boolean) => void; name: string };

const feedback = lazyModule(() => import("./FeedbackDialog.tsx"));

export const preloadFeedback = feedback.preload;

export function FeedbackOverlay(props: FeedbackProps) {
	return (
		<Opened open={props.open}>
			<Suspense fallback={null}>
				<Loaded {...props} />
			</Suspense>
		</Opened>
	);
}

function Loaded(props: FeedbackProps) {
	const loaded = useLazyModule(feedback);
	if (loaded.module) return <loaded.module.FeedbackDialog {...props} />;
	return <Failed {...props} retry={loaded.retry} />;
}

function Failed({ open, onOpenChange, retry }: FeedbackProps & { retry: () => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent style={{ maxWidth: 620 }} aria-describedby={undefined}>
				<DialogHeader title="Send feedback" />
				<DialogBody>
					<LoadFailed what="Feedback" retry={retry} />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
