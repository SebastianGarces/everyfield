export function reinstall<T>(key: symbol, next: T): T | undefined {
	const slots: { [slot: symbol]: T | undefined } = {};
	const host = Object.assign(window, slots);
	const previous = host[key];
	host[key] = next;
	return previous;
}
