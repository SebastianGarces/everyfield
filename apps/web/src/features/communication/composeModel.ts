import { bodyToTextResult, textToBody } from "./body.ts";
import { fieldProblem, fieldProblemText, usableKeys } from "./fields.ts";
import { counted } from "@everyfield/contracts/common";
import {
	emptyAudience,
	groupLabel,
	type Audience,
	type AudienceSummary,
	type Draft,
	type DraftState,
	type Team,
	type Template,
} from "./model.ts";

type PersonRef = { id: string; displayName: string | null; email: string | null };

export type Form = {
	communicationId: string | null;
	revision: string | null;
	state: DraftState | "new";
	subject: string;
	text: string;
	audience: Audience;
	people: PersonRef[];
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
		people: draft.audience.personIds.map((id) => byId.get(id) ?? { id, displayName: null, email: null }),
		templateKey: template?.templateId ?? "none",
		templateId: draft.templateId,
		templateSource: draft.templateSource,
		meetingId: draft.meetingId,
		lossy: body.lossy,
	};
}

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
		const text = fieldProblemText(problem);
		return { reason: text, body: text };
	}
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

export function toLine(form: Form, summary: AudienceSummary | null, teams: readonly Team[]): string {
	const children = new Set((summary?.childExclusions ?? []).map((person) => person.id));
	const known = new Map((summary?.recipients ?? []).map((r) => [r.id, r.displayName]));
	const chosen = [
		...form.audience.groups.map((g) => groupLabel[g as keyof typeof groupLabel] ?? g),
		...form.audience.teamIds.map((id) => teams.find((t) => t.id === id)?.name ?? "A team"),
		...form.people
			.filter((p) => !children.has(p.id))
			.map((p) => p.displayName ?? known.get(p.id) ?? "A person"),
	];
	const count = counted(summary?.eligibleRecipients ?? 0, "person", "people");
	return chosen.length ? `${count} · ${listed(chosen)}` : count;
}
