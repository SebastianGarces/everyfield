export type Replies = {
	held: () => boolean;
	waiting: () => number;
	hold: (on: boolean) => void;
	answer: () => void;
	arrive: () => Promise<void>;
	subscribe: (listener: () => void) => () => void;
};

export function createReplies(held = false): Replies {
	let holding = held;
	const queue: (() => void)[] = [];
	const listeners = new Set<() => void>();
	const emit = () => listeners.forEach((listener) => listener());
	const answer = () => {
		for (const release of queue.splice(0)) release();
		emit();
	};
	return {
		held: () => holding,
		waiting: () => queue.length,
		hold: (on) => {
			holding = on;
			if (on) emit();
			else answer();
		},
		answer,
		arrive: async () => {
			if (!holding) return;
			await new Promise<void>((release) => {
				queue.push(release);
				emit();
			});
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
