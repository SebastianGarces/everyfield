import { bodyToTextResult, textToBody } from "./body.ts";
import { fieldProblem, usableKeys } from "./fields.ts";
import { emptyAudience, type Audience, type Draft, type DraftState, type Template } from "./model.ts";

// The compose form and what it needs to be saved, checked and shown. Pure, so the step rules are testable.

export type PersonRef = { id: string; displayName: string; email: string | null };

export type Form = {
	communicationId: string | null;
	revision: string | null;
	state: DraftState | "new";
	subject: string;
	/** The typed message. The stored body is textToBody(text). */
	text: string;
	audience: Audience;
	people: PersonRef[];
	/** The template shown in the picker: a template id, or "none". */
	templateKey: string;
	templateId: string | null;
	templateSource: string | null;
	meetingId: string | null;
	lossy: boolean;
};

export const blankForm = (): Form => ({
	communicationId: null,
	revision: null,
	state: "new",
	subject: "",
	text: "",
	audience: emptyAudience(),
	people: [],
	templateKey: "none",
	templateId: null,
	templateSource: null,
	meetingId: null,
	lossy: false,
});

export function formFrom(draft: Draft, templates: readonly Template[], known: readonly PersonRef[] = []): Form {
	const body = bodyToTextResult(draft.bodyHtml ?? "");
	const byId = new Map(known.map((person) => [person.id, person]));
	const template = templates.find((item) =>
		draft.templateId
			? item.templateId === draft.templateId
			: draft.templateSource && item.sourceKey === draft.templateSource,
	);
	return {
		communicationId: draft.communicationId,
		revision: draft.revision,
		state: draft.state,
		subject: draft.subject ?? "",
		text: body.text,
		audience: {
			groups: [...draft.audience.groups],
			teamIds: [...draft.audience.teamIds],
			personIds: [...draft.audience.personIds],
		},
		people: draft.audience.personIds.map(
			(id) => byId.get(id) ?? { id, displayName: "Person on this message", email: null },
		),
		templateKey: template?.templateId ?? "none",
		templateId: draft.templateId,
		templateSource: draft.templateSource,
		meetingId: draft.meetingId,
		lossy: body.lossy,
	};
}

/** The saveDraft input for a form. */
export function draftPayload(form: Form) {
	const body = textToBody(form.text);
	return {
		...(form.communicationId ? { communicationId: form.communicationId } : {}),
		subject: form.subject.trim() ? form.subject.trim() : null,
		bodyHtml: body ? body : null,
		audience: form.audience,
		meetingId: form.meetingId,
		templateId: form.templateId,
		templateSource: form.templateSource,
	};
}

export const audienceSize = (audience: Audience) =>
	audience.groups.length + audience.teamIds.length + audience.personIds.length;

/** Why Write cannot move on, or null. The first issue of the subject and field rules comes first. */
export function writeReason(
	form: Form,
	hasMeeting: boolean,
): { reason: string; subject?: string; body?: string } | null {
	if (form.subject.includes("{{")) {
		const text = "Fields work in the message, not the subject.";
		return { reason: text, subject: text };
	}
	const problem = fieldProblem(form.text, usableKeys(hasMeeting));
	if (problem) {
		const text = `Finish or remove the field ${problem}`;
		return { reason: text, body: text };
	}
	// An empty field is named in the footer only. A red error on a fresh form would scold before anyone typed.
	if (!form.subject.trim()) return { reason: "Enter a subject." };
	if (!form.text.trim()) return { reason: "Write the message." };
	return null;
}

export const isLocked = (form: Form) => form.state === "reviewed" || form.state === "scheduled";

export function formatWhen(iso: string): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function listed(items: string[], max = 4): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")}, and ${items.length - max} more`;
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
