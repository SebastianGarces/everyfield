// The draft rules of the settings dialog, as pure functions over plain data (WP-010/ui R2).
//
// One source of truth per section for the saved value: the server's latest reply in the section cache. A draft is
// never compared with a value captured when Save was pressed; every decision reads the server value as it is now.
// At most one save per section is in flight. The book lives in the settings store, so leaving a section and coming
// back changes nothing: the in-flight save, its refusal and the draft are still there.
//
// Invariant (tests/ui/settings/drafts-model.test.mjs checks it over random interleavings of edits, saves, section
// switches and accepted or refused replies): the visible value is the latest edit, or the server value when there
// is no edit; a section is dirty exactly when its visible value differs from the server value. The one exception is
// normalization: when a save succeeds and nothing was typed since, the server's version of what was sent ("Name"
// for "Name ") replaces the draft.
//
// No imports, so the model test loads this file directly.

export type Book<K extends string, R = unknown> = {
	/** The latest edit per section. Absent means "show the server value". */
	edits: Partial<Record<K, { value: unknown }>>;
	/** The one save in flight per section, with exactly what it sent. */
	inFlight: Partial<Record<K, { sent: unknown }>>;
	/** The last refusal per section, until the next save or edit. */
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

/** What the section shows. */
export function visible<K extends string>(book: Book<K>, key: K, server: unknown): unknown {
	const edit = book.edits[key];
	return edit ? edit.value : server;
}

/** Unsaved: the visible value differs from what the server holds now. */
export function isDirty<K extends string>(book: Book<K>, key: K, server: unknown): boolean {
	const edit = book.edits[key];
	return edit !== undefined && !same(edit.value, server);
}

export function isSaving<K extends string>(book: Book<K>, key: K): boolean {
	return book.inFlight[key] !== undefined;
}

/**
 * A person typed. The edit is kept, even when it equals the server value while a save runs: that save is about to
 * change the server value, so only its reply can tell whether the edit is clean.
 */
export function edit<K extends string, R>(book: Book<K, R>, key: K, value: unknown, server: unknown): Book<K, R> {
	const refusals = without(book.refusals, key);
	if (!isSaving(book, key) && same(value, server)) return { ...book, edits: without(book.edits, key), refusals };
	return { ...book, edits: { ...book.edits, [key]: { value } }, refusals };
}

/** Drop the section's edit (discard). An in-flight save keeps running and still reports. */
export function discard<K extends string, R>(book: Book<K, R>, key: K): Book<K, R> {
	return { ...book, edits: without(book.edits, key), refusals: without(book.refusals, key) };
}

/** Start a save of the visible value. Refused (null) while another save of the section is in flight. */
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

/**
 * The save ended. `server` is the server value now, after every step that committed. A success drops the edit if
 * it is still exactly what was sent. In every case an edit equal to the server value is dropped, and any other
 * edit stays: it is something the person typed that the server does not hold.
 */
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
