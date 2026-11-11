// The plain-text editor maps typed text to stored HTML and back, and the preview pre-pass and send check read the
// merge fields, so the preview equals the sent email.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeHtml } from "../../../packages/contracts/src/communication/html.ts";
import { systemTemplates } from "../../../packages/contracts/src/communication/catalog.ts";
import { bodyToText, bodyToTextResult, textToBody } from "../../../apps/web/src/features/communication/body.ts";
import {
	fieldProblem,
	fieldProblemText,
	prepareBody,
	UNFINISHED_MARKER,
	unknownMarker,
} from "../../../apps/web/src/features/communication/fields.ts";

const texts = [
	"Hello {{name}}.\n\nJoin us on Sunday.",
	"One line\nsecond line\nthird line",
	"# Welcome\n\nWe **love** to *see* you.",
	"## Plan\n\n- Coffee\n- Songs\n- Talk",
	"### Steps\n\n1. Arrive\n2. Sit\n3. Listen",
	"> Be kind\n> Always\n\nThanks",
	"Read [the map](https://example.test/map?a=1&b=2) first.",
	"- one\n- two\n\n1. first\n2. second",
	"Fish & chips < 5 > 3",
];

test("INV-communication-editor: typed text is stored as HTML the sanitizer keeps unchanged and reads back as the same text", () => {
	for (const t of texts) {
		const html = textToBody(t);
		assert.equal(sanitizeHtml(html), html, t);
		assert.equal(bodyToText(html), t, t);
	}
});

test("INV-communication-editor: every system template body survives the editor", () => {
	for (const template of systemTemplates) {
		const html = template.bodyHtml;
		assert.equal(sanitizeHtml(textToBody(bodyToText(html))), sanitizeHtml(html), template.name);
	}
});

test("INV-communication-editor: b and i read as bold and italic, u and span keep text and flag it", () => {
	assert.equal(bodyToText("<p><b>a</b> <i>b</i></p>"), "**a** *b*");
	const lossy = bodyToTextResult("<p><u>under</u> <span>span</span></p>");
	assert.equal(lossy.text, "under span");
	assert.equal(lossy.lossy, true);
	assert.equal(bodyToTextResult("<p>plain</p>").lossy, false);
});

test("INV-communication-preview: the pre-pass marks unfinished and unknown fields and leaves valid bodies alone", () => {
	const keys = ["name"];
	assert.equal(prepareBody("<p>Hello {{na</p>", keys), `<p>Hello ${UNFINISHED_MARKER}</p>`);
	assert.equal(prepareBody("<p>Hi {{nmae}}.</p>", keys), `<p>Hi ${unknownMarker("nmae")}.</p>`);
	const valid = "<p>Hello {{name}}. Join us</p>";
	assert.equal(prepareBody(valid, keys), valid);
	assert.equal(prepareBody("<p>{{rsvp_link}}</p>", keys), "<p>[RSVP button needs a meeting]</p>");
	assert.doesNotMatch(prepareBody("<p>Hello {{na</p>", keys), /[{}]/);
});

test("INV-communication-fields: field problems name what the person typed", () => {
	assert.equal(fieldProblem("Hello {{na", ["name"]), "{{na");
	assert.equal(fieldProblem("Hello {{nmae}}", ["name"]), "{{nmae}}");
	assert.equal(fieldProblem("Hello {{name}}", ["name"]), null);
});

test("INV-communication-fields: a meeting-only field without a meeting says it needs a meeting; a typo says to fix it", () => {
	assert.equal(
		fieldProblemText("{{rsvp_link}}"),
		"The RSVP button needs a meeting. Attach a meeting or remove {{rsvp_link}}",
	);
	assert.equal(fieldProblemText("{{nmae}}"), "Finish or remove the field {{nmae}}");
});
