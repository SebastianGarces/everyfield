// The save order both document editors share (the written-document editor and the Church Document editor): at most
// one save in flight, a later save that waits for it and then saves what was typed meanwhile, and "Save and leave",
// which leaves only once everything on screen is saved. Plain code with no React, so a node test drives the same
// module the editors call (tests/ui/documents/save-chain.test.mjs).

/** One editor's saves. The editor keeps one for its life and asks it, never its own flag. */
export class SaveChain {
	#inflight: Promise<boolean> | null = null;

	/** True while a save is in flight: the page counts as unsaved until it answers. */
	get busy(): boolean {
		return this.#inflight !== null;
	}

	/** Sends one save of the document as it is now. The caller has checked that no save is in flight. */
	start(send: () => Promise<boolean>): Promise<boolean> {
		const run = send().finally(() => {
			this.#inflight = null;
		});
		this.#inflight = run;
		return run;
	}

	/**
	 * Saves the document on screen. A save already in flight sent the document as it was when it started, so after it
	 * resolves, edits typed meanwhile get a save of their own (`now`); with none, `onScreenSaved` says so and nothing is
	 * sent. True only when what is on screen is saved; a failed save answers false and keeps its reason on the page.
	 */
	async save(onScreenSaved: () => boolean, now: () => Promise<boolean>): Promise<boolean> {
		let joined = false;
		while (this.#inflight) {
			joined = true;
			if (!(await this.#inflight)) return false;
		}
		if (joined && onScreenSaved()) return true;
		return now();
	}
}

/**
 * "Save and leave": waits for `save`, then `finish(true)` leaves the page, or `finish(false)` keeps it when the save
 * failed. A save that throws keeps the page too, so the dialog is never left locked on "saving".
 */
export async function saveAndLeave(save: () => Promise<boolean>, finish: (leave: boolean) => void): Promise<void> {
	finish(await save().catch(() => false));
}
