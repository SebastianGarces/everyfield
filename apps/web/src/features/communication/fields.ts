import { mergeKeys, type MergeKey } from "@everyfield/contracts/communication";

export type MergeField = {
	key: MergeKey;
	label: string;
	example: string;
	needsMeeting: boolean;
};

const railEntries: Record<MergeKey, Omit<MergeField, "key">> = {
	name: { label: "Name", example: "Maria Santos", needsMeeting: false },
	rsvp_link: { label: "RSVP button", example: "Tell us if you can come", needsMeeting: true },
};

const mergeFields: readonly MergeField[] = mergeKeys.map((key) => ({ key, ...railEntries[key] }));

const sampleNames: readonly [string, ...string[]] = [
	"Maria Santos",
	"Daniel Okafor",
	"Priya Raman",
	"Samuel Weber",
	"Grace Lindqvist",
	"Tomas Herrera",
	"Hannah Cho",
	"Isaac Mensah",
];

export const fieldsFor = (hasMeeting: boolean): MergeField[] =>
	mergeFields.filter((field) => hasMeeting || !field.needsMeeting);
export const fieldToken = (key: string): string => `{{${key}}}`;
export const pickSampleName = (seed: string): string => {
	let hash = 0;
	for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return sampleNames[hash % sampleNames.length] ?? sampleNames[0];
};

export const UNFINISHED_MARKER = "[finish this field]";
export const unknownMarker = (key: string) => `[unknown field: ${key}]`;

const meetingOnly = (token: string): MergeField | null => {
	const key = token.replace(/^\{\{|\}\}$/g, "").trim();
	return mergeFields.find((field) => field.needsMeeting && field.key === key) ?? null;
};
const needsMeetingMarker = (field: MergeField) => `[${field.label} needs a meeting]`;

export const fieldProblemText = (problem: string): string => {
	const field = meetingOnly(problem);
	return field
		? `The ${field.label} needs a meeting. Attach a meeting or remove ${problem}`
		: `Finish or remove the field ${problem}`;
};

const CLOSED = /\{\{([^{}]*)\}\}/g;
const UNCLOSED = /\{\{(?![^{}]*\}\})[^{}\s<]*/g;
const SHAPE = /^[a-z0-9_]+$/i;

export const usableKeys = (hasMeeting: boolean): string[] => fieldsFor(hasMeeting).map((field) => field.key);

export function prepareBody(body: string, keys: readonly string[]): string {
	return body
		.replace(CLOSED, (whole, inner: string) => {
			const key = inner.trim();
			if (SHAPE.test(key) && keys.includes(key)) return whole;
			const field = meetingOnly(whole);
			return field ? needsMeetingMarker(field) : unknownMarker(key);
		})
		.replace(UNCLOSED, UNFINISHED_MARKER);
}

export function fieldProblem(text: string, keys: readonly string[]): string | null {
	for (const match of text.matchAll(/\{\{[^{}]*(?:\}\}|(?=\{\{)|$)|\{\{[^{}\s]*/g)) {
		const token = match[0];
		if (!token.endsWith("}}")) return token.trim();
		const key = token.slice(2, -2).trim();
		if (!SHAPE.test(key) || !keys.includes(key)) return token;
	}
	return null;
}
