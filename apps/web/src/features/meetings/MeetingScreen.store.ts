import { createStore, type StoreApi } from "zustand/vanilla";
import type { ShownEvaluation } from "./Attendance.tsx";
import type { Detail, Issue } from "./model.ts";
import type { TabId } from "./next-step.ts";

export type MeetingDialog = "edit" | "delete" | "history";

export type MeetingScreenState = {
	firstTab: TabId;
	dialog: MeetingDialog | null;
	preview: Detail | null;
	cardsRequest: number;
	evaluationDraft: ShownEvaluation | null;
	issues: Issue[];
	actions: {
		open: (dialog: MeetingDialog) => void;
		close: () => void;
		preview: (meeting: Detail | null) => void;
		askForCards: () => void;
		draftEvaluation: (draft: ShownEvaluation | null) => void;
		markIssues: (issues: Issue[]) => void;
	};
};

export function createMeetingScreenStore(init: { firstTab: TabId }): StoreApi<MeetingScreenState> {
	return createStore<MeetingScreenState>()((set, get) => ({
		firstTab: init.firstTab,
		dialog: null,
		preview: null,
		cardsRequest: 0,
		evaluationDraft: null,
		issues: [],
		actions: {
			open: (dialog) => set({ dialog }),
			close: () => set({ dialog: null }),
			preview: (preview) => set({ preview }),
			askForCards: () => set({ cardsRequest: get().cardsRequest + 1 }),
			draftEvaluation: (evaluationDraft) => set({ evaluationDraft }),
			markIssues: (issues) => set({ issues }),
		},
	}));
}
