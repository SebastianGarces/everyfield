// The messages a refused Church Document action shows. A plain module, so a test reads them without a server action.

export const MESSAGES: Record<string, string> = {
	access_denied: "Only an Owner or Admin of the church plant can do this.",
	unavailable: "This is not available any more. Reload the page.",
	conflict: "The document changed after this page opened. Reload the page and try again.",
	invalid_input: "That request is not valid.",
};
export const refusedWith = (code: string): { status: "refused"; message: string } => ({
	status: "refused",
	message: MESSAGES[code] ?? "Something went wrong. Nothing was changed.",
});

/** The messages a refused Download shows. Nothing is saved and nothing downloads on any of them. */
export const EXPORT_MESSAGES: Record<string, string> = {
	render_failed: "Everyfield could not make this file, so nothing was saved or downloaded. Try again in a moment.",
	unavailable: "This file could not be saved, so nothing was downloaded. Reload the page and try again.",
	conflict: "The document changed after this page opened, so nothing was saved. Reload the page and try again.",
	access_denied: "You no longer have access to this document, so nothing was saved.",
	invalid_input: "That format is not offered for this document, so nothing was saved.",
};
