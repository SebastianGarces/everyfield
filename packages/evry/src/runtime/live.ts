type Waiter = () => void;

class LiveRoom {
	turnId: string | null = null;
	text = "";
	private waiters = new Set<Waiter>();
	private readonly id: string;
	private readonly rooms: Map<string, LiveRoom>;
	constructor(id: string, rooms: Map<string, LiveRoom>) {
		this.id = id;
		this.rooms = rooms;
	}

	begin(turnId: string) {
		this.turnId = turnId;
		this.text = "";
		this.wake();
	}
	push(delta: string) {
		this.text += delta;
		this.wake();
	}
	end(turnId: string) {
		if (this.turnId !== turnId) return;
		this.turnId = null;
		this.wake();
		this.release();
	}
	next(signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				this.waiters.delete(done);
				signal.removeEventListener("abort", done);
				this.release();
				resolve();
			};
			this.waiters.add(done);
			signal.addEventListener("abort", done, { once: true });
			if (signal.aborted) done();
		});
	}
	private wake() {
		for (const waiter of [...this.waiters]) waiter();
	}
	private release() {
		if (this.turnId === null && this.waiters.size === 0 && this.rooms.get(this.id) === this) this.rooms.delete(this.id);
	}
}

const KEY = Symbol.for("everyfield.evry.live");
const rooms = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<string, LiveRoom>()) as Map<string, LiveRoom>;

export const liveRoom = (conversationId: string) => {
	let room = rooms.get(conversationId);
	if (!room) rooms.set(conversationId, (room = new LiveRoom(conversationId, rooms)));
	return room;
};
