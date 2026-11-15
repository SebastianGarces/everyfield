export class SaveChain {
	#inflight: Promise<boolean> | null = null;

	get busy(): boolean {
		return this.#inflight !== null;
	}

	start(send: () => Promise<boolean>): Promise<boolean> {
		const run = send().finally(() => {
			this.#inflight = null;
		});
		this.#inflight = run;
		return run;
	}

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

export async function saveAndLeave(save: () => Promise<boolean>, finish: (leave: boolean) => void): Promise<void> {
	finish(await save().catch(() => false));
}
