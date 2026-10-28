// The merge fields a message may use. One typed list feeds the field rail, the `{{` list, the preview pre-pass and
// the send check. Keys are exactly the keys delivery fills at send: `name` and, from WP-020/api, `rsvp_link`.
// A field that delivery does not fill must never appear here, or the preview would differ from the sent email.

export type MergeField = {
	key: string;
	/** The plain label on the rail. */
	label: string;
	/** What the person sees in the preview. */
	example: string;
	/** True when the message must be attached to a meeting for the field to work. */
	needsMeeting: boolean;
};

export const mergeFields: readonly MergeField[] = [
	{ key: "name", label: "Name", example: "Maria Santos", needsMeeting: false },
	{ key: "rsvp_link", label: "RSVP button", example: "Tell us if you can come", needsMeeting: true },
];

/** Full names, because delivery fills `name` with the display name. */
export const sampleNames: readonly string[] = [
	"Maria Santos",
	"Daniel Okafor",
	"Priya Raman",
	"Samuel Weber",
	"Grace Lindqvist",
	"Tomas Herrera",
	"Hannah Cho",
	"Isaac Mensah",
];

export const knownKeys = (): string[] => mergeFields.map((field) => field.key);
export const fieldsFor = (hasMeeting: boolean): MergeField[] =>
	mergeFields.filter((field) => hasMeeting || !field.needsMeeting);
export const fieldToken = (key: string): string => `{{${key}}}`;
export const pickSampleName = (random: () => number = Math.random): string =>
	sampleNames[Math.floor(random() * sampleNames.length)] ?? sampleNames[0]!;

// The preview pre-pass. It turns unfinished or unknown fields into readable markers, so a valid body passes through
// unchanged and the preview equals the sent email.

export const UNFINISHED_MARKER = "[finish this field]";
export const unknownMarker = (key: string) => `[unknown field: ${key}]`;

const CLOSED = /\{\{([^{}]*)\}\}/g;
const UNCLOSED = /\{\{(?![^{}]*\}\})[^{}\s<]*/g;
const SHAPE = /^[a-z0-9_]+$/i;

/** The merge keys a message may use. Fields that need a meeting count only with a meeting. */
export const usableKeys = (hasMeeting: boolean): string[] => fieldsFor(hasMeeting).map((field) => field.key);

/** Replace unfinished and unknown fields with markers. Valid fields stay for the renderer. */
export function prepareBody(body: string, keys: readonly string[]): string {
	return body
		.replace(CLOSED, (whole, inner: string) => {
			const key = inner.trim();
			return SHAPE.test(key) && keys.includes(key) ? whole : unknownMarker(key);
		})
		.replace(UNCLOSED, UNFINISHED_MARKER);
}

/** The first field that blocks a send, as the text the person typed. `null` means every field is valid. */
export function fieldProblem(text: string, keys: readonly string[]): string | null {
	for (const match of text.matchAll(/\{\{[^{}]*(?:\}\}|(?=\{\{)|$)|\{\{[^{}\s]*/g)) {
		const token = match[0];
		if (!token.endsWith("}}")) return token.trim();
		const key = token.slice(2, -2).trim();
		if (!SHAPE.test(key) || !keys.includes(key)) return token;
	}
	return null;
}
