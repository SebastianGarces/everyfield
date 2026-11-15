import {
	checkReason,
	type DeclareResult,
	type JourneyEntry,
	type JourneyState,
	type PhaseNumber,
	type TransitionResult,
} from "@everyfield/contracts/phases";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
	pendingDeclaration,
	pendingMove,
	REASON_MESSAGE,
	refusalMessage,
	requestKeys,
	sent,
	withEntry,
	type Journey,
	type Outcome,
} from "./model.ts";

export type MoveDraft = { to: PhaseNumber; reason: string; error: string | null; changed: JourneyState | null };

export type JourneyDialog = { kind: "move"; draft: MoveDraft } | { kind: "declare"; to: PhaseNumber } | null;

export type JourneyPort = {
	move: (key: string, revision: string, to: PhaseNumber, reason: string) => Promise<Outcome<TransitionResult>>;
	declare: (key: string, revision: string, to: PhaseNumber) => Promise<Outcome<DeclareResult>>;
	failed: (message: string) => void;
	actor: JourneyEntry["actor"];
};

export type JourneyStoreState = {
	journey: Journey;
	dialog: JourneyDialog;
	receipt: string | null;
	lostMove: MoveDraft | null;
	lostDeclare: PhaseNumber | null;
	actions: {
		openMove: () => void;
		openDeclare: () => void;
		editMove: (draft: MoveDraft | null) => void;
		editDeclare: (to: PhaseNumber | null) => void;
		submitMove: (draft: MoveDraft) => Promise<void>;
		submitDeclare: (to: PhaseNumber) => Promise<void>;
	};
};

export type JourneyStore = StoreApi<JourneyStoreState>;

const DECLARE_FIRST: PhaseNumber = 2;

export function createJourneyStore(init: { journey: Journey; port: JourneyPort }): JourneyStore {
	const keys = requestKeys(() => crypto.randomUUID());
	const { port } = init;

	return createStore<JourneyStoreState>()((set, get) => ({
		journey: init.journey,
		dialog: null,
		receipt: null,
		lostMove: null,
		lostDeclare: null,
		actions: {
			openMove: () => {
				const s = get();
				set({
					dialog: {
						kind: "move",
						draft: s.lostMove ?? { to: s.journey.state.phase, reason: "", error: null, changed: null },
					},
				});
			},
			openDeclare: () => set((s) => ({ dialog: { kind: "declare", to: s.lostDeclare ?? DECLARE_FIRST } })),
			editMove: (draft) => set({ dialog: draft ? { kind: "move", draft } : null }),
			editDeclare: (to) => set({ dialog: to === null ? null : { kind: "declare", to } }),
			submitMove: async (draft) => {
				const checked = checkReason(draft.reason);
				if (!checked.ok) {
					set({ dialog: { kind: "move", draft: { ...draft, error: REASON_MESSAGE[checked.problem] } } });
					return;
				}
				const before = get().journey;
				set({
					dialog: null,
					receipt: null,
					lostMove: null,
					journey: pendingMove(before, draft.to, checked.reason, port.actor, new Date().toISOString()),
				});
				const intent = ["move", before.state.revision, draft.to, draft.reason] as const;
				const r = await sent(() => port.move(keys.keyFor(intent), before.state.revision, draft.to, draft.reason));
				if (r.status === "lost") set({ lostMove: { ...draft, error: null, changed: null } });
				else keys.settle(intent);
				if (r.status === "ok") {
					if (r.value.outcome === "noop") {
						set({ receipt: `No change: already in Phase ${r.value.state.phase}.` });
						return;
					}
					set({ journey: withEntry(before, r.value.state, r.value.entry) });
					return;
				}
				if (r.status === "refused" && r.error.code === "revision_conflict") {
					const changed = r.error.details.state;
					set({
						journey: { ...before, state: changed },
						dialog: { kind: "move", draft: { ...draft, error: null, changed } },
					});
					return;
				}
				set({ journey: before });
				if (r.status === "refused" && r.error.code === "invalid_reason") {
					set({ dialog: { kind: "move", draft: { ...draft, error: refusalMessage(r), changed: null } } });
					return;
				}
				port.failed(refusalMessage(r));
			},
			submitDeclare: async (to) => {
				const before = get().journey;
				set({
					dialog: null,
					receipt: null,
					lostDeclare: null,
					journey: pendingDeclaration(before, to, port.actor, new Date().toISOString()),
				});
				const intent = ["declare", before.state.revision, to] as const;
				const r = await sent(() => port.declare(keys.keyFor(intent), before.state.revision, to));
				if (r.status === "lost") set({ lostDeclare: to });
				else keys.settle(intent);
				if (r.status === "ok") {
					set({ journey: withEntry(before, r.value.state, r.value.entry) });
					return;
				}
				set({
					journey:
						r.status === "refused" && r.error.code === "revision_conflict"
							? { ...before, state: r.error.details.state }
							: before,
				});
				port.failed(refusalMessage(r));
			},
		},
	}));
}
