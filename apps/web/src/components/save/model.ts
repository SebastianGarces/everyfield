// The save contract for every card and dialog (C58, C65, C68, C69). No React and no server code, so the rules run the
// same in the browser and in node tests; parts.tsx wraps the lane in a hook and draws its notice.
//
// Every save is one save intent with its own new request key, also when the values repeat an earlier save. A lost
// answer is sent once more at once with the same key; the producer returns the first result for a key it already
// saved, so the replay can never save twice. When that answer is lost too, the card says the change may already be
// saved and offers Check again, which sends the same request with the same key. Only a server answer says "not saved".
// A refusal opens the form again with the values and the reason while it is still the latest form; otherwise the card
// says what was not saved and why. One save per card at a time: while a save is in flight or unknown, nothing else on
// the card can start, and nothing waits in a queue.

export type Outcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: string }
	/** The answer was lost (network, server restart). The same request may be sent again with the same key. */
	| { status: "lost" };

/**
 * Sends a save, and once more with the same request key when the answer is lost. A second lost answer goes back to the
 * person as unknown.
 */
export async function sendTwice<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const once = () => call().catch((): Outcome<T> => ({ status: "lost" }));
	const first = await once();
	return first.status === "lost" ? once() : first;
}

/** A card's notice. `what` names the change ("Piano"), `done` its verb ("saved", "added", "removed"). */
export type Notice =
	| { tone: "refused"; id: string; what: string; done: string; reason: string }
	| { tone: "unknown"; id: string; what: string; done: string; check: () => void; checking: boolean };

/**
 * One save per card (C68). "saving" until the save ends, "unknown" until its replay or Check again settles it. A refused
 * save is final, so new forms may submit.
 */
export type Wait = "saving" | "unknown" | null;
export const waitOf = (saving: boolean, notice: Notice | null): Wait =>
	saving ? "saving" : notice?.tone === "unknown" ? "unknown" : null;

export type LaneState<E> = {
	/** The open form, or null. A refused save opens it again with `problem`. */
	editing: E | null;
	notice: Notice | null;
	/** Counts form openings and closings: a refusal reopens its form only while no newer form was opened or closed. */
	intent: number;
	saving: boolean;
};

/** One save intent. `send` makes one request with the intent's key; the lane replays it once after a lost answer. */
export type SaveSpec<E, T> = {
	what: string;
	/** The verb for the notice: "was not added", "may already be added". Default "saved". */
	done?: string;
	/** The form to open again with the reason when the server refuses. A one-click action has none. */
	form?: E;
	send: (key: string) => Promise<Outcome<T>>;
	/**
	 * Runs the save inside a lane the card shares with other cards (the person store), or gives null when that lane is
	 * busy. `send` already includes the replay.
	 */
	through?: (key: string, send: () => Promise<Outcome<T>>) => Promise<Outcome<T> | null>;
	/** False when `send` replays on its own (an upload that must not send its file twice, C97). */
	replay?: boolean;
	/** The code the form and notice show for a refusal code. */
	code?: (code: string) => string;
	/** A saved answer. `checked` is true when Check again brought it. */
	ok: (value: T, checked: boolean) => void;
	/** A refused answer, after the form or notice shows it (a conflict reads the latest values here). */
	refused?: (code: string) => void;
};

export type LaneOptions = {
	/** The words for a refusal code. */
	explain: (code: string) => string;
	/** True while a lane the card shares (the person store) runs another save. */
	busy?: () => boolean;
	fresh?: () => string;
	/** Where a save that started while the card was busy is reported (C69): a programming error, nothing is sent. */
	report?: (line: string) => void;
};

/**
 * One card's save lane: its open form, its notice and its one save at a time. An external store, so a double click
 * or two dialogs cannot start two saves before React renders.
 */
export class SaveLane<E extends { problem?: string }> {
	#state: LaneState<E> = { editing: null, notice: null, intent: 0, saving: false };
	#listeners = new Set<() => void>();
	#options: LaneOptions;
	constructor(options: LaneOptions) {
		this.#options = options;
	}
	get = (): LaneState<E> => this.#state;
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	#set(patch: Partial<LaneState<E>>) {
		this.#state = { ...this.#state, ...patch };
		for (const l of this.#listeners) l();
	}
	/** The card's wait now: its own save, a shared lane's save, or an unknown result. */
	wait = (): Wait => waitOf(this.#state.saving || (this.#options.busy?.() ?? false), this.#state.notice);
	open = (e: E) => this.#set({ editing: e, intent: this.#state.intent + 1 });
	close = () => this.#set({ editing: null, intent: this.#state.intent + 1 });
	/** Dismisses a refused notice. An unknown result stays until it is checked. */
	dismiss = () => {
		if (this.#state.notice?.tone === "refused") this.#set({ notice: null });
	};

	/**
	 * Starts a save intent: closes the form, takes a new key and sends. Resolves when the save has an answer or is
	 * unknown. A save that starts while the card waits sends nothing and is reported (C69).
	 */
	save = async <T>(spec: SaveSpec<E, T>): Promise<void> => {
		if (this.wait() !== null) {
			this.#options.report?.(JSON.stringify({ component: "save-lane", outcome: "save_not_started", what: spec.what }));
			return;
		}
		this.close();
		const key = (this.#options.fresh ?? (() => crypto.randomUUID()))();
		await this.#attempt(spec, key, this.#state.intent, false);
	};

	async #attempt<T>(spec: SaveSpec<E, T>, key: string, token: number, checked: boolean) {
		const done = spec.done ?? "saved";
		const send = spec.replay === false ? () => spec.send(key) : () => sendTwice(() => spec.send(key));
		const safe = () => send().catch((): Outcome<T> => ({ status: "lost" }));
		this.#set({ saving: true });
		const r = spec.through ? await spec.through(key, safe) : await safe();
		this.#set({ saving: false });
		// Both answers lost, or a Check again the shared lane could not start: the first request may still be saved.
		if (r?.status === "lost" || (r === null && checked)) {
			const check = () => {
				const n = this.#state.notice;
				if (n?.tone !== "unknown" || n.id !== key || n.checking || this.wait() === "saving") return;
				this.#set({ notice: { ...n, checking: true } });
				void this.#attempt(spec, key, -1, true);
			};
			return this.#set({ notice: { tone: "unknown", id: key, what: spec.what, done, check, checking: false } });
		}
		if (r === null) {
			// The shared lane was busy at the first send, so nothing was sent (C69).
			this.#options.report?.(JSON.stringify({ component: "save-lane", outcome: "save_not_started", what: spec.what }));
			return this.#refuse(spec, key, token, "busy", done);
		}
		if (r.status === "refused") {
			const code = spec.code?.(r.code) ?? r.code;
			this.#refuse(spec, key, token, code, done);
			return spec.refused?.(code);
		}
		// A save now known to be saved clears its own notice, never another one.
		if (this.#state.notice?.id === key) this.#set({ notice: null });
		spec.ok(r.value, checked);
	}

	#refuse<T>(spec: SaveSpec<E, T>, key: string, token: number, code: string, done: string) {
		const reopen = spec.form !== undefined && token === this.#state.intent;
		if (reopen) return this.#set({ editing: { ...spec.form!, problem: code } });
		this.#set({
			notice: { tone: "refused", id: key, what: spec.what, done, reason: this.#options.explain(code) },
		});
	}
}
