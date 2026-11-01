// The lifecycle operations of the approach B format: fork, wipe and new. They are pure: each returns a new document
// and never changes its input, so a fork can never write back into the template it came from.

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A new document from a template (or from another document). The copy is complete and owns its content: later
 * template versions never reach it. Field values start empty; the app fills the ones with a source at creation.
 */
export function fork(source, newId) {
	const doc = clone(source);
	doc.kind = "document";
	doc.id = newId;
	doc.version = 1;
	doc.origin =
		source.kind === "template"
			? { templateId: source.id, templateVersion: source.version }
			: { ...(source.origin ?? { templateId: source.id, templateVersion: source.version }), forkedFrom: source.id };
	return doc;
}

/**
 * The document with every piece of content removed: body, header, footer and fields. It keeps its identity, its
 * origin, its page setup and its notices. The legal notice is not content: see DESIGN.md, "Locked or required parts".
 */
export function wipe(doc) {
	const next = clone(doc);
	next.body = [];
	next.fields = [];
	delete next.header;
	delete next.footer;
	return next;
}

/** An empty document with no template behind it. */
export function blank(id, title = "Untitled document") {
	return {
		format: "everyfield.doc",
		formatVersion: 1,
		kind: "document",
		id,
		version: 1,
		title,
		class: "operational",
		origin: null,
		notices: [],
		page: {
			size: "letter",
			orientation: "portrait",
			margins: { top: 40, right: 40, bottom: 56, left: 40 },
			imposition: null,
		},
		fields: [],
		body: [],
	};
}

/** A short, stable fingerprint of a document's JSON (FNV-1a, 32 bit), to show that a template did not change. */
export function fingerprint(doc) {
	const text = JSON.stringify(doc);
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
