import { renderEmailHtml } from "@everyfield/contracts/communication";
import { prepareBody, usableKeys } from "./fields.ts";

// The one place preview HTML comes from. Write, Review, the template editor and the history detail all call
// `renderPreview`, and the result goes to the sandboxed EmailFrame. The pre-pass below turns unfinished or unknown
// fields into readable markers, so a valid body passes through unchanged and the preview equals the sent email.
// It renders in the browser with the same `renderEmailHtml` delivery uses, so typing sends no request.

export type PreviewInput = {
	bodyHtml: string;
	/** The display name that fills `name`. */
	name: string;
	hasMeeting: boolean;
	/** The app origin, for the RSVP link. */
	origin: string;
	/** The church name in the email header and footer. */
	churchName: string;
};
export type PreviewResult = { html: string } | { error: string };

/** The preview HTML for a message. Pure: the same input gives the same result. */
export function renderPreview(input: PreviewInput): PreviewResult {
	const merge: Record<string, string> = { name: input.name };
	if (input.hasMeeting) merge.rsvp_link = `${input.origin}/rsvp/preview`;
	const bodyHtml = prepareBody(input.bodyHtml, usableKeys(input.hasMeeting));
	try {
		return { html: renderEmailHtml(bodyHtml, merge, { churchName: input.churchName }, "preview") };
	} catch {
		return { error: "The preview did not load." };
	}
}
