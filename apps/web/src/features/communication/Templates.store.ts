import { createDebouncer } from "@everyfield/ui/foundations";
import { createStore, type StoreApi } from "zustand/vanilla";
import { bodyToTextResult } from "./body.ts";
import type { MeetingType, Template, TemplateCategory } from "./model.ts";

export type Fields = {
	name: string;
	description: string;
	category: TemplateCategory;
	meetingType: MeetingType | "";
	subject: string;
	text: string;
	lossy: boolean;
};

export type Issues = { name?: string; subject?: string; body?: string; meetingType?: string; form?: string };

export type TemplateEditorState = {
	fields: Fields;
	current: Template | null;
	issues: Issues;
	status: string | null;
	previewed: string;
	actions: {
		change: (update: (fields: Fields) => Fields) => void;
		keep: (template: Template) => void;
		flag: (issues: Issues) => void;
		say: (status: string | null) => void;
	};
};

const PREVIEW_PAUSE_MS = 300;

const blank = (): Fields => ({
	name: "",
	description: "",
	category: "announcement",
	meetingType: "",
	subject: "",
	text: "",
	lossy: false,
});

export function fieldsFrom(template: Template): Fields {
	const body = bodyToTextResult(template.bodyHtml);
	return {
		name: template.name,
		description: template.description ?? "",
		category: template.category,
		meetingType: template.meetingType ?? "",
		subject: template.subject,
		text: body.text,
		lossy: body.lossy,
	};
}

export function createTemplateEditorStore(init: { template: Template | null }): StoreApi<TemplateEditorState> {
	const previewPause = createDebouncer(PREVIEW_PAUSE_MS);
	const fields = init.template ? fieldsFrom(init.template) : blank();
	return createStore<TemplateEditorState>()((set, get) => ({
		fields,
		current: init.template,
		issues: {},
		status: null,
		previewed: fields.text,
		actions: {
			change: (update) => {
				const before = get().fields;
				const next = update(before);
				set({ fields: next });
				if (next.text !== before.text) previewPause.run(() => set((state) => ({ previewed: state.fields.text })));
			},
			keep: (template) => {
				previewPause.cancel();
				const next = fieldsFrom(template);
				set({ current: template, fields: next, previewed: next.text });
			},
			flag: (issues) => set({ issues }),
			say: (status) => set({ status }),
		},
	}));
}
