// The one page-wide hold on leaving. A screen with work that is not saved (the church document editor) holds it. An
// action that leaves the page by itself instead of through a link, such as Sign out, calls `leavePage` first, so the
// screen asks in its own Everyfield dialog before anything ends the session. Links and Back need no call: the editor's
// own listeners catch them.

/** Takes the way out when the screen must ask first, and returns true; returns false when nothing is unsaved. */
type Hold = (go: () => void) => boolean;

let hold: Hold | null = null;

/** Holds every `leavePage` call until the returned release runs. One screen holds at a time; the latest one wins. */
export function holdLeave(next: Hold): () => void {
	hold = next;
	return () => {
		if (hold === next) hold = null;
	};
}

/** Runs `go` now, or after the screen that holds the page asks and the person chooses to leave. */
export function leavePage(go: () => void): void {
	if (!hold?.(go)) go();
}
