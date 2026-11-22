import { checkDebrief, type DebriefAnswers, type Plan } from "@everyfield/contracts/launch";
import { createDebouncer } from "@everyfield/ui/foundations";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
	DEBRIEF_MESSAGE,
	instantDate,
	parseCount,
	refusalMessage,
	sent,
	type Outcome,
	type requestKeys,
} from "./model.ts";

export type Written = "wentWell" | "toChange" | "operations" | "followUpPlan" | "supportNeeded";
export type Form = Record<Written, string> & { missingNames: "yes" | "no" | null; missingCount: string };

export const formOf = (a: DebriefAnswers | null): Form => ({
	wentWell: a?.wentWell ?? "",
	toChange: a?.toChange ?? "",
	operations: a?.operations ?? "",
	followUpPlan: a?.followUpPlan ?? "",
	supportNeeded: a?.supportNeeded ?? "",
	missingNames: a?.missingNames ?? null,
	missingCount: a?.missingCount === null || !a ? "" : String(a.missingCount),
});

function answersOf(f: Form): DebriefAnswers | null {
	const count = parseCount(f.missingCount);
	return count.ok ? { ...f, missingCount: count.value } : null;
}

export type DebriefPort = {
	save: (
		key: string,
		revision: string,
		draftId: string | null,
		answers: DebriefAnswers,
		submit: boolean,
	) => Promise<Outcome<{ plan: Plan }>>;
	keys: ReturnType<typeof requestKeys>;
	onPlan: (plan: Plan) => void;
	onSubmitted: () => void;
};

export type DebriefState = {
	form: Form;
	status: string | null;
	error: string | null;
	busy: boolean;
	actions: {
		edit: (patch: Partial<Form>) => void;
		save: (submit: boolean) => Promise<void>;
		hold: (node: Element | null) => () => void;
	};
};

export type DebriefStore = StoreApi<DebriefState>;

const DRAFT_PAUSE_MS = 900;

export function createDebriefStore(init: {
	debrief: NonNullable<Plan["debrief"]>;
	timeZone: string;
	port: DebriefPort;
}): DebriefStore {
	const d = init.debrief;
	const timeZone = init.timeZone;
	const pause = createDebouncer(DRAFT_PAUSE_MS);
	let held = d.draft ? { id: d.draft.id, revision: d.draft.revision } : null;
	let dirty = false;
	let inFlight = false;

	return createStore<DebriefState>()((set, get) => {
		const save = async (submit: boolean): Promise<void> => {
			const answers = answersOf(get().form);
			if (!answers) {
				set({ error: DEBRIEF_MESSAGE.count_out_of_range });
				return;
			}
			const checked = checkDebrief(answers, submit);
			if (!checked.ok) {
				if (submit) set({ error: DEBRIEF_MESSAGE[checked.problem] });
				return;
			}
			dirty = false;
			const fence = held;
			const intent = ["debrief", submit, fence, checked.answers] as const;
			inFlight = true;
			set(submit ? { busy: true } : { busy: true, status: "Saving draft" });
			const r = await sent(() =>
				init.port.save(
					init.port.keys.keyFor(intent),
					fence?.revision ?? "0",
					fence?.id ?? null,
					checked.answers,
					submit,
				),
			);
			inFlight = false;
			set({ busy: false });
			if (r.status !== "lost") init.port.keys.settle(intent);
			if (r.status === "ok") {
				const draft = r.value.plan.debrief?.draft ?? null;
				held = draft ? { id: draft.id, revision: draft.revision } : null;
				set({ error: null });
				init.port.onPlan(r.value.plan);
				if (submit) return init.port.onSubmitted();
				set({ status: draft ? `Draft saved ${instantDate(draft.savedAt, timeZone)}` : null });
				if (dirty) void save(false);
				return;
			}
			dirty = true;
			set({ status: null, error: refusalMessage(r) });
		};
		return {
			form: formOf(d.draft?.answers ?? d.submitted?.answers ?? null),
			status: d.draft ? `Draft saved ${instantDate(d.draft.savedAt, timeZone)}` : null,
			error: null,
			busy: false,
			actions: {
				edit: (patch) => {
					dirty = true;
					set((s) => ({ form: { ...s.form, ...patch }, error: null }));
					pause.run(() => {
						if (dirty && !inFlight) void save(false);
					});
				},
				save,
				hold: pause.cancelOnDetach,
			},
		};
	});
}
