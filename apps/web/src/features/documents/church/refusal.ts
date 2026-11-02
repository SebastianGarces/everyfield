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
