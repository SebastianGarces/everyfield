export type Book<K extends string, R = unknown> = {
	edits: Partial<Record<K, { value: unknown }>>;
	inFlight: Partial<Record<K, { sent: unknown }>>;
	refusals: Partial<Record<K, R>>;
};

export function emptyBook<K extends string, R = unknown>(): Book<K, R> {
	return { edits: {}, inFlight: {}, refusals: {} };
}

export function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function without<T extends object>(record: T, key: PropertyKey): T {
	if (!(key in record)) return record;
	const next = { ...record };
	delete (next as Record<PropertyKey, unknown>)[key];
	return next;
}

export function visible<K extends string>(book: Book<K>, key: K, server: unknown): unknown {
	const edit = book.edits[key];
	return edit ? edit.value : server;
}

export function isDirty<K extends string>(book: Book<K>, key: K, server: unknown): boolean {
	const edit = book.edits[key];
	return edit !== undefined && !same(edit.value, server);
}

export function isSaving<K extends string>(book: Book<K>, key: K): boolean {
	return book.inFlight[key] !== undefined;
}

export function edit<K extends string, R>(book: Book<K, R>, key: K, value: unknown, server: unknown): Book<K, R> {
	const refusals = without(book.refusals, key);
	if (!isSaving(book, key) && same(value, server)) return { ...book, edits: without(book.edits, key), refusals };
	return { ...book, edits: { ...book.edits, [key]: { value } }, refusals };
}

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);

export function rebase<K extends string, R>(book: Book<K, R>, key: K, before: unknown, after: unknown): Book<K, R> {
	const edit = book.edits[key];
	if (!edit || isSaving(book, key) || !isFields(edit.value) || !isFields(before) || !isFields(after)) return book;
	const value: Fields = { ...after };
	for (const [field, typed] of Object.entries(edit.value)) if (!same(typed, before[field])) value[field] = typed;
	const refusals = without(book.refusals, key);
	if (same(value, after)) return { ...book, edits: without(book.edits, key), refusals };
	return { ...book, edits: { ...book.edits, [key]: { value } }, refusals };
}

export function discard<K extends string, R>(book: Book<K, R>, key: K): Book<K, R> {
	return { ...book, edits: without(book.edits, key), refusals: without(book.refusals, key) };
}

export function begin<K extends string, R>(
	book: Book<K, R>,
	key: K,
	server: unknown,
): { book: Book<K, R>; sent: unknown } | null {
	if (isSaving(book, key)) return null;
	const sent = visible(book, key, server);
	return {
		sent,
		book: { ...book, inFlight: { ...book.inFlight, [key]: { sent } }, refusals: without(book.refusals, key) },
	};
}

export function finish<K extends string, R>(
	book: Book<K, R>,
	key: K,
	outcome: { ok: true } | { ok: false; refusal: R },
	server: unknown,
): Book<K, R> {
	const flight = book.inFlight[key];
	const inFlight = without(book.inFlight, key);
	const refusals = outcome.ok ? without(book.refusals, key) : { ...book.refusals, [key]: outcome.refusal };
	const edit = book.edits[key];
	if (!edit) return { ...book, inFlight, refusals };
	const sentUnchanged = outcome.ok && flight !== undefined && same(edit.value, flight.sent);
	const edits = sentUnchanged || same(edit.value, server) ? without(book.edits, key) : book.edits;
	return { edits, inFlight, refusals };
}
