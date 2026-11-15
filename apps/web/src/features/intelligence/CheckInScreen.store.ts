import type {
	CareAnswers,
	CareArea,
	CareError,
	CareLevel,
	CarePage,
	CareWeek,
	CareWriteResult,
} from "@everyfield/contracts/intelligence";
import { createStore, type StoreApi } from "zustand/vanilla";
import { complete, draftOf, withAnswer, withResult, type Draft, type Outcome } from "./model.ts";

export type CheckInPort = {
	save: (key: string, revision: string, answers: CareAnswers, note: string) => Promise<Outcome<CareWriteResult>>;
	correct: (
		key: string,
		revision: string,
		weekId: string | null,
		answers: CareAnswers,
		note: string,
	) => Promise<Outcome<CareWriteResult>>;
	history: (page: number) => Promise<Outcome<CarePage>>;
};

export type CheckInState = {
	strip: CarePage;
	older: CarePage | null;
	target: CareWeek | null;
	draft: Draft;
	saving: boolean;
	paging: boolean;
	status: string | null;
	failure: { error: CareError | null } | null;
	incomplete: boolean;
	actions: {
		choose: (week: CareWeek | null) => void;
		answer: (area: CareArea, level: CareLevel) => void;
		write: (note: string) => void;
		submit: () => Promise<void>;
		load: (page: number) => Promise<void>;
		showLatest: () => void;
	};
};

export type CheckInStore = StoreApi<CheckInState>;

export const thisWeekOf = (s: CheckInState) => s.strip.weeks[0]!;
export const shownOf = (s: CheckInState) => s.older ?? s.strip;
export const editingOf = (s: CheckInState) => s.target ?? thisWeekOf(s);

const savedText = (result: CareWriteResult, correcting: boolean) =>
	result.outcome === "unchanged"
		? "Nothing changed, so nothing new was saved."
		: correcting
			? "Correction saved. Your earlier answer stays in your history."
			: "Check-in saved.";

export function createCheckInStore(init: { initial: CarePage; port: CheckInPort }): CheckInStore {
	let sent: { payload: string; key: string } | null = null;
	const keyFor = (payload: string) => {
		if (sent?.payload !== payload) sent = { payload, key: crypto.randomUUID() };
		return sent.key;
	};
	const failed = <T>(result: Outcome<T>) => ({ error: result.status === "refused" ? result.error : null });

	return createStore<CheckInState>()((set, get) => ({
		strip: init.initial,
		older: null,
		target: null,
		draft: draftOf(init.initial.weeks[0]!),
		saving: false,
		paging: false,
		status: null,
		failure: null,
		incomplete: false,
		actions: {
			choose: (week) => {
				const thisWeek = thisWeekOf(get());
				set({
					target: week && week.ordinal !== thisWeek.ordinal ? week : null,
					draft: draftOf(week ?? thisWeek),
					failure: null,
					incomplete: false,
					status: null,
				});
			},
			answer: (area, level) =>
				set((s) => ({ draft: { ...s.draft, answers: { ...s.draft.answers, [area]: level } }, status: null })),
			write: (note) => set((s) => ({ draft: { ...s.draft, note }, status: null })),
			submit: async () => {
				const s = get();
				const draft = s.draft;
				if (!complete(draft)) {
					set({ incomplete: true });
					return;
				}
				const week = editingOf(s);
				const correcting = s.target !== null;
				const { answers, note } = draft;
				const before = { strip: s.strip, older: s.older };
				const revision = s.strip.revision;
				set({
					incomplete: false,
					failure: null,
					status: "Saving…",
					saving: true,
					strip: withAnswer(s.strip, week, answers, note),
					older: s.older ? withAnswer(s.older, week, answers, note) : s.older,
				});
				const key = keyFor(JSON.stringify({ id: week.id, revision, answers, note }));
				let result: Outcome<CareWriteResult>;
				try {
					result = correcting
						? await init.port.correct(key, revision, week.id, answers, note)
						: await init.port.save(key, revision, answers, note);
				} catch {
					result = { status: "lost" };
				}
				if (result.status !== "ok") {
					set({ saving: false, strip: before.strip, older: before.older, status: null, failure: failed(result) });
					return;
				}
				sent = null;
				const confirmed = result.value;
				set((now) => ({
					saving: false,
					strip: withResult(now.strip, confirmed),
					older: now.older ? withResult(now.older, confirmed) : now.older,
					draft: draftOf(confirmed.week),
					target: correcting ? confirmed.week : now.target,
					status: savedText(confirmed, correcting),
				}));
			},
			load: async (page) => {
				set({ paging: true });
				const result = await init.port.history(page).catch((): Outcome<CarePage> => ({ status: "lost" }));
				if (result.status !== "ok") {
					set({ paging: false, failure: failed(result) });
					return;
				}
				if (page === 1) set({ paging: false, strip: result.value, older: null });
				else
					set((now) => ({
						paging: false,
						older: result.value,
						strip: { ...now.strip, revision: result.value.revision },
					}));
			},
			showLatest: () => set({ older: null }),
		},
	}));
}
