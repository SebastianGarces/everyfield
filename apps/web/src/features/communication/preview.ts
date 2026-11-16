import { renderEmailHtml } from "@everyfield/contracts/communication";
import { prepareBody, usableKeys } from "./fields.ts";

export type PreviewInput = {
	bodyHtml: string;
	name: string;
	hasMeeting: boolean;
	origin: string;
	churchName: string;
};
type PreviewResult = { html: string } | { error: string };

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
