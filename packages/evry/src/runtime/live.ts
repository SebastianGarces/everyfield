// The in-process live path (WP-051): the running turn publishes each text delta here at once, and observers in the same
// process deliver it without waiting for the database. The database stays the durable record (the turn saves its events
// off the model read loop); a worker in another process simply has no room here, and its observers read the database.
// The registry hangs off globalThis so the route bundle and the worker bundle share it.

type Waiter = () => void;

/** One conversation's running turn: all its text so far, and who waits for more. */
export class LiveRoom {
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
	/** Resolves at the next change, or when `signal` aborts. */
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

/** The conversation's live room, created when first needed. */
export const liveRoom = (conversationId: string) => {
	let room = rooms.get(conversationId);
	if (!room) rooms.set(conversationId, (room = new LiveRoom(conversationId, rooms)));
	return room;
};
