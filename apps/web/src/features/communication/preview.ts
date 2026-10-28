import { previewMessage } from "./actions.ts";
import { prepareBody, usableKeys } from "./fields.ts";
import { outcomeText } from "./model.ts";

// The one place preview HTML comes from. Write, Review, the template editor and the history detail all call
// `renderPreview`, and the result goes to the sandboxed EmailFrame. The pre-pass below turns unfinished or unknown
// fields into readable markers, so a valid body passes through unchanged and the preview equals the sent email.

export type PreviewInput = {
	bodyHtml: string;
	/** The display name that fills `name`. */
	name: string;
	hasMeeting: boolean;
	/** The app origin, for the RSVP link. */
	origin: string;
};
export type PreviewResult = { html: string } | { error: string };

const PAUSE_MS = 300;
let timer: ReturnType<typeof setTimeout> | null = null;
let superseded: (() => void) | null = null;

/**
 * The preview HTML for a message. One request per 300 ms pause: a newer call replaces an older one and the older
 * call resolves to `null`.
 */
export function renderPreview(input: PreviewInput): Promise<PreviewResult | null> {
	if (timer) clearTimeout(timer);
	superseded?.();
	return new Promise((resolve) => {
		superseded = () => resolve(null);
		timer = setTimeout(async () => {
			timer = null;
			superseded = null;
			const merge: Record<string, string> = { name: input.name };
			if (input.hasMeeting) merge.rsvp_link = `${input.origin}/rsvp/preview`;
			const bodyHtml = prepareBody(input.bodyHtml, usableKeys(input.hasMeeting));
			// TODO(WP-020/api): swap to renderEmailHtml(textToBody(text), merge, { churchName }, "preview")
			const result = await previewMessage({ bodyHtml, merge });
			if (result.status === "ok") return resolve({ html: result.value.previewBody });
			resolve({ error: outcomeText(result) ?? "The preview did not load." });
		}, PAUSE_MS);
	});
}
