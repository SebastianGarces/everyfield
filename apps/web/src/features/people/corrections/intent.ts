import type { FocusEvent, PointerEvent } from "react";
import { createRead } from "../../../components/read.tsx";
import { loadRecords, unmergePreview } from "../fetch.ts";

const INTENT_FRESH_MS = 15_000;
const lost = () => ({ status: "lost" }) as const;

export const recordsRead = createRead((personId: string) => loadRecords(personId), {
	failed: lost,
	fresh: INTENT_FRESH_MS,
});
export const unmergeRead = createRead((mergeId: string) => unmergePreview(mergeId), {
	failed: lost,
	fresh: INTENT_FRESH_MS,
});

function intent(begin: () => void) {
	return {
		onPointerMove: (e: PointerEvent<HTMLElement>) => {
			if (e.pointerType === "mouse") begin();
		},
		onTouchStart: () => begin(),
		onFocusCapture: (e: FocusEvent<HTMLElement>) => {
			if (e.currentTarget.matches(":focus-visible")) begin();
		},
	};
}
export const unmergeIntent = (mergeId: string) => intent(() => unmergeRead.prefetch(mergeId));
export const recordsIntent = (personId: string) => intent(() => recordsRead.prefetch(personId));
