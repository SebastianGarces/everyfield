import test from "node:test";
import assert from "node:assert/strict";
import { renderEmailHtml } from "../../../packages/contracts/src/communication/email.ts";
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

test("AC:COM-010 renderBody turns rsvp_link into a bulletproof button and drops every other value", () => {
	const html = renderBody("<p>{{rsvp_link}}</p>", { rsvp_link: link });
	assert.ok(html.startsWith('<table data-rsvp-button="" role="presentation"'), html);
	assert.ok(!html.includes("<p>"), "the button is not wrapped in a paragraph");
	assert.ok(
		html.includes(`<a href="${link}" style="display:block;padding:13px 22px;background-color:#1AF197;color:#181D19;`),
	);
	assert.ok(html.includes("font-size:15px;font-weight:600"));
	assert.ok(html.includes(`<!--[if mso]><v:rect`) && html.includes(`href="${link}"`));
	assert.equal(html.match(/Tell us if you can come/g)?.length, 2);
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

test("AC:COM-010 the email layout is inline-styled tables around the rendered body", () => {
	const html = renderEmailHtml(
		"<h1>Join us</h1><p>Hi {{name}}</p><p>{{rsvp_link}}</p>",
		{ name: "Alex", rsvp_link: link },
		{ churchName: "Harvest Point Church" },
	);
	assert.ok(html.startsWith("<!DOCTYPE html>"));
	assert.equal(/<style|<link|@import|@font-face/i.test(html), false);
	assert.ok(html.includes("max-width:600px"));
	assert.ok(html.includes("background-color:#F4F2EE"));
	assert.ok(html.includes("padding:30px 30px 28px 30px"));
	assert.ok(html.includes("You get this email because you are part of Harvest Point Church."));
	assert.ok(html.includes(">HP</td>"));
	assert.ok(html.includes('<p style="margin:0 0 14px 0;font-size:16px;line-height:1.6;color:#3A3F3B;">Hi Alex</p>'));
	assert.ok(html.includes("<h1 style="));
	const body = html.slice(html.indexOf("<h1"), html.indexOf('</td></tr><tr><td align="center"'));
	assert.ok(body.includes("data-rsvp-button"));
	// Author markup is still sanitized and the church name is escaped.
	const hostile = renderEmailHtml("<script>alert(1)</script><p onclick=x>Hi</p>", {}, { churchName: "<b>Bad</b>" });
	assert.equal(/<script|onclick|<b>Bad/.test(hostile), false);
});
