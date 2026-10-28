import test from "node:test";
import assert from "node:assert/strict";
import { plainText, renderBody, sanitizeHtml } from "../../../packages/contracts/src/communication/html.ts";

const stored = [
	["<img/src=x/onerror=alert(1)>", ""],
	["<svg/onload=alert(1)>", ""],
	['<a href="jav&#x61;script:alert(1)">x</a>', "<a>x</a>"],
	['<script src="https://evil.example/x.js">', ""],
	["<scr<script></script>ipt>alert(1)</script>", "ipt&gt;alert(1)"],
] as const;

for (const [input, output] of stored) {
	test("sanitizeHtml drops executable markup: " + input.slice(0, 24), () => {
		const clean = sanitizeHtml(input);
		assert.equal(clean, output);
		assert.equal(/<script/i.test(clean), false);
		assert.equal(/onerror|onload|javascript:/i.test(clean), false);
	});
}

test("renderBody keeps the safe sentence and drops the script", () => {
	assert.equal(renderBody("<p>Hello {{name}}</p><script>alert(1)</script>", { name: "Alex" }), "<p>Hello Alex</p>");
});

const link = "https://app.example.com/rsvp/abc_DEF-123";

test("AC:COM-010 renderBody turns rsvp_link into a link and drops every other value", () => {
	const html = renderBody("<p>{{rsvp_link}}</p>", { rsvp_link: link });
	assert.equal(html, `<p><a href="${link}"><strong>Tell us if you can come</strong></a></p>`);
	for (const bad of [
		"javascript:alert(1)",
		'https://app.example.com/rsvp/x"onmouseover="alert(1)',
		"http://app.example.com/rsvp/abc",
		"https://app.example.com/other/abc",
		"https://app.example.com/rsvp/abc?x=1",
		"https://u:p@app.example.com/rsvp/abc",
		"",
	])
		assert.equal(renderBody("<p>Hi</p><p>{{rsvp_link}}</p>", { rsvp_link: bad }), "<p>Hi</p>", bad);
	assert.equal(renderBody("<p>Hi</p><p>{{ rsvp_link }}</p>", {}), "<p>Hi</p>");
});

test("AC:COM-010 a merge value never reaches an attribute through another field", () => {
	assert.equal(
		renderBody("<p>{{name}}</p>", { name: '"><a href="javascript:x">' }),
		"<p>&quot;&gt;&lt;a href=&quot;javascript:x&quot;&gt;</p>",
	);
});

test("AC:COM-010 plainText writes the RSVP URL after the link text", () => {
	const text = plainText(renderBody("<p>Hello {{name}}</p><p>{{rsvp_link}}</p>", { name: "Alex", rsvp_link: link }));
	assert.equal(text, `Hello Alex Tell us if you can come ${link}`);
});
