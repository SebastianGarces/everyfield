import type { Outcome as Shared } from "@everyfield/contracts/common";

export type Outcome<T> = Shared<T, string, { reason?: string }>;

export async function sendTwice<T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const once = () => call().catch((): Outcome<T> => ({ status: "lost" }));
	const first = await once();
	return first.status === "lost" ? once() : first;
}

export type Notice =
	| { tone: "refused"; id: string; what: string; done: string; reason: string }
	| { tone: "unknown"; id: string; what: string; done: string; check: () => void; checking: boolean };

export type Wait = "saving" | "unknown" | null;
export const waitOf = (saving: boolean, notice: Notice | null): Wait =>
	saving ? "saving" : notice?.tone === "unknown" ? "unknown" : null;

export type LaneState<E> = {
	editing: E | null;
	notice: Notice | null;
	intent: number;
	saving: boolean;
};

export type SaveSpec<E, T> = {
	what: string;
	done?: string;
	form?: E;
	send: (key: string) => Promise<Outcome<T>>;
	through?: (key: string, send: () => Promise<Outcome<T>>) => Promise<Outcome<T> | null>;
	replay?: boolean;
	code?: (code: string) => string;
	ok: (value: T, checked: boolean) => void;
	refused?: (code: string) => void;
};

export type LaneOptions = {
	explain: (code: string) => string;
	busy?: () => boolean;
	fresh?: () => string;
	report?: (line: string) => void;
};

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
	wait = (): Wait => waitOf(this.#state.saving || (this.#options.busy?.() ?? false), this.#state.notice);
	open = (e: E) => this.#set({ editing: e, intent: this.#state.intent + 1 });
	close = () => this.#set({ editing: null, intent: this.#state.intent + 1 });
	dismiss = () => {
		if (this.#state.notice?.tone === "refused") this.#set({ notice: null });
	};

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
			this.#options.report?.(JSON.stringify({ component: "save-lane", outcome: "save_not_started", what: spec.what }));
			return this.#refuse(spec, key, token, "busy", done);
		}
		if (r.status === "refused") {
			const named = r.reason ?? r.code;
			const code = spec.code?.(named) ?? named;
			this.#refuse(spec, key, token, code, done);
			return spec.refused?.(code);
		}
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
