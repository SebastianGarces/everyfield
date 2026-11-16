import { createDebouncer } from "@everyfield/ui/foundations";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SettleInput } from "./Attendance.tsx";
import type { Finalization, Outcome } from "./model.ts";

type Mode = "finalize" | "reconcile";

export type SettleChoice = {
	meetingId: string;
	attendeeIds: string[];
	followUpAssigneeIds: string[];
	reason?: string;
	evaluationAssigneeIds?: string[];
};

export type SettlePort = {
	preview: (choice: SettleChoice) => Promise<Outcome<Finalization>>;
	followUpOwners: () => Promise<string[]>;
	conflict: (chosen: SettleInput) => void;
};

export type SettleState = {
	ids: string[];
	followUp: string[];
	chose: boolean;
	evaluation: string[];
	reason: string;
	touched: boolean;
	effects: { key: string; value: Outcome<Finalization> } | null;
	actions: {
		start: () => void;
		toggle: (personId: string, on: boolean) => void;
		pickFollowUp: (ids: string[]) => void;
		pickEvaluation: (ids: string[]) => void;
		write: (reason: string) => void;
		retry: () => void;
		touch: () => void;
		hold: (node: Element | null) => () => void;
	};
};

export type SettleStore = StoreApi<SettleState>;

const PREVIEW_PAUSE_MS = 250;

export const choiceOf = (s: SettleState, meetingId: string, mode: Mode): SettleChoice => ({
	meetingId,
	attendeeIds: [...s.ids].sort(),
	followUpAssigneeIds: [...s.followUp].sort(),
	...(mode === "reconcile" ? { reason: "Review" } : { evaluationAssigneeIds: [...s.evaluation].sort() }),
});

export const chosenOf = (s: SettleState): SettleInput => ({
	attendeeIds: s.ids,
	followUpAssigneeIds: s.followUp,
	evaluationAssigneeIds: s.evaluation,
	reason: s.reason.trim(),
});

export const selectUnchanged = (s: SettleState, mode: Mode, current: string[]) =>
	mode === "reconcile" && s.ids.length === current.length && s.ids.every((id) => current.includes(id));

export function createSettleStore(init: {
	mode: Mode;
	meetingId: string;
	current: string[];
	initial: SettleInput | null;
	port: SettlePort;
}): SettleStore {
	const pause = createDebouncer(PREVIEW_PAUSE_MS);
	let asked = "";
	return createStore<SettleState>()((set, get) => {
		const preview = () => {
			pause.cancel();
			asked = "";
			if (selectUnchanged(get(), init.mode, init.current)) return;
			const choice = choiceOf(get(), init.meetingId, init.mode);
			const key = JSON.stringify(choice);
			asked = key;
			pause.run(() => {
				void init.port
					.preview(choice)
					.catch((): Outcome<Finalization> => ({ status: "lost" }))
					.then((value) => {
						if (asked !== key) return;
						if (value.status === "refused" && value.code === "conflict") return init.port.conflict(chosenOf(get()));
						set({ effects: { key, value } });
					});
			});
		};
		return {
			ids: init.initial?.attendeeIds ?? init.current,
			followUp: init.initial?.followUpAssigneeIds ?? [],
			chose: init.initial !== null,
			evaluation: init.initial?.evaluationAssigneeIds ?? [],
			reason: init.initial?.reason ?? "",
			touched: false,
			effects: null,
			actions: {
				start: () => {
					preview();
					if (init.mode !== "reconcile" || get().chose) return;
					void init.port.followUpOwners().then((owners) => {
						if (get().chose || !owners.length) return;
						set({ followUp: owners });
						preview();
					});
				},
				toggle: (personId, on) => {
					const ids = get().ids;
					set({ ids: on ? [...ids, personId] : ids.filter((id) => id !== personId) });
					preview();
				},
				pickFollowUp: (ids) => {
					set({ followUp: ids, chose: true });
					preview();
				},
				pickEvaluation: (ids) => {
					set({ evaluation: ids });
					preview();
				},
				write: (reason) => set({ reason }),
				retry: () => {
					set({ effects: null });
					preview();
				},
				touch: () => set({ touched: true }),
				hold: () => () => {
					pause.cancel();
					asked = "";
				},
			},
		};
	});
}
