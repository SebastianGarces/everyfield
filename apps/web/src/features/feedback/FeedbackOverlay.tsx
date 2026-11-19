"use client";

import { Dialog, DialogBody, DialogContent, DialogHeader } from "@everyfield/ui/controls";
import { Suspense } from "react";
import { lazyModule, LoadFailed, Opened, useLazyModule, type Failure } from "../../components/lazy.tsx";

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
	return <Failed {...props} failure={loaded} />;
}

function Failed({ open, onOpenChange, failure }: FeedbackProps & { failure: Failure }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent style={{ maxWidth: 620 }} aria-describedby={undefined} onCloseAutoFocus={failure.keepFocusOnRetry}>
				<DialogHeader title="Send feedback" />
				<DialogBody>
					<LoadFailed what="Feedback" retry={failure.retry} />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
