import { createDebouncer } from "@everyfield/ui/foundations";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createRead } from "../../components/read.tsx";
import { searchRecipients } from "./actions.ts";
import { bodyToTextResult } from "./body.ts";
import { blankForm, draftPayload, formFrom, type Form } from "./composeModel.ts";
import {
	templateBinding,
	type Audience,
	type Draft,
	type MeetingContext,
	type Outcome,
	type Recipient,
	type Template,
} from "./model.ts";
import type { SendPlan } from "./ReviewStep.tsx";

export type Opening =
	| { kind: "draft"; draft: Draft }
	| { kind: "new"; meeting: MeetingContext | null; template: Template | null; guests: boolean; notes: string[] }
	| { kind: "missing" }
	| { kind: "unreachable" };

export type Opened = Exclude<Opening, { kind: "missing" } | { kind: "unreachable" }>;

export type Undo = {
	subject: string;
	text: string;
	templateKey: string;
	binding: Pick<Form, "templateId" | "templateSource">;
};

export const recipientSearches = createRead((text: string) => searchRecipients(text), {
	failed: (): Outcome<{ people: Recipient[] }> => ({ status: "lost" }),
});

const answered = (text: string) => text !== "" && recipientSearches.peek(text)?.value !== undefined;

export type PersonSearch = { query: string; searched: string; previous: string; open: boolean; active: number };

export type ComposeState = {
	form: Form;
	saved: string;
	extra: Template[];
	notes: string[];
	undo: Undo | null;
	pending: string | null;
	problem: string | null;
	plan: SendPlan | null;
	scheduledId: string | null;
	counted: Audience;
	previewed: string;
	search: PersonSearch;
	actions: {
		edit: (update: (form: Form) => Form) => void;
		hold: (form: Form) => void;
		begin: (name: string) => boolean;
		end: () => void;
		fail: (problem: string | null) => void;
		note: (notes: string[]) => void;
		offerUndo: (undo: Undo | null) => void;
		plan: (plan: SendPlan | null) => void;
		scheduled: (id: string) => void;
		type: (query: string) => void;
		openList: (open: boolean) => void;
		move: (step: number, length: number) => void;
		clearSearch: () => void;
	};
};

export type ComposeStore = StoreApi<ComposeState>;

const COUNT_PAUSE_MS = 300;
const PREVIEW_PAUSE_MS = 300;
const SEARCH_PAUSE_MS = 300;

const savedOf = (form: Form) => JSON.stringify(draftPayload(form));
const sameAudience = (a: Audience, b: Audience) => JSON.stringify(a) === JSON.stringify(b);

export function openedForm(opening: Opened, templates: readonly Template[]): Form {
	if (opening.kind === "draft") return formFrom(opening.draft, templates);
	let form: Form = { ...blankForm(), meetingId: opening.meeting?.id ?? null };
	const template = opening.template;
	if (template) {
		form = {
			...form,
			subject: template.subject,
			text: bodyToTextResult(template.bodyHtml).text,
			templateKey: template.templateId,
			...templateBinding(template),
		};
	}
	if (opening.guests && opening.meeting) {
		const people = opening.meeting.guests.map((g) => ({ id: g.id, displayName: g.displayName, email: null }));
		form = { ...form, people, audience: { ...form.audience, personIds: people.map((p) => p.id) } };
	}
	return form;
}

export function createComposeStore(init: { opening: Opened; templates: readonly Template[] }): ComposeStore {
	const countPause = createDebouncer(COUNT_PAUSE_MS);
	const previewPause = createDebouncer(PREVIEW_PAUSE_MS);
	const searchPause = createDebouncer(SEARCH_PAUSE_MS);
	const form = openedForm(init.opening, init.templates);
	return createStore<ComposeState>()((set, get) => ({
		form,
		saved: savedOf(init.opening.kind === "new" ? blankForm() : form),
		extra: init.opening.kind === "new" && init.opening.template ? [init.opening.template] : [],
		notes: init.opening.kind === "new" ? init.opening.notes : [],
		undo: null,
		pending: null,
		problem: null,
		plan: null,
		scheduledId: null,
		counted: form.audience,
		previewed: form.text,
		search: { query: "", searched: "", previous: "", open: false, active: 0 },
		actions: {
			edit: (update) => {
				const before = get().form;
				const next = update(before);
				set({ form: next });
				if (!sameAudience(before.audience, next.audience))
					countPause.run(() => set((state) => ({ counted: state.form.audience })));
				if (before.text !== next.text) previewPause.run(() => set((state) => ({ previewed: state.form.text })));
			},
			hold: (next) => set({ form: next, saved: savedOf(next) }),
			begin: (name) => {
				if (get().pending !== null) return false;
				set({ pending: name, problem: null });
				return true;
			},
			end: () => set({ pending: null }),
			fail: (problem) => set({ problem }),
			note: (notes) => set({ notes }),
			offerUndo: (undo) => set({ undo }),
			plan: (plan) => set({ plan }),
			scheduled: (scheduledId) => set({ scheduledId }),
			type: (query) => {
				const text = query.trim();
				set((state) => ({ search: { ...state.search, query, open: true } }));
				if (!text) {
					searchPause.cancel();
					set((state) => ({ search: { ...state.search, searched: "", previous: "" } }));
					return;
				}
				searchPause.run(() =>
					set(({ search }) => ({
						search: {
							...search,
							searched: text,
							previous: answered(search.searched) ? search.searched : search.previous,
							active: 0,
						},
					})),
				);
			},
			openList: (open) => set((state) => ({ search: { ...state.search, open } })),
			move: (step, length) =>
				set((state) => ({
					search: { ...state.search, open: true, active: (state.search.active + step + length) % length },
				})),
			clearSearch: () => {
				searchPause.cancel();
				set((state) => ({ search: { ...state.search, query: "", searched: "", previous: "" } }));
			},
		},
	}));
}
