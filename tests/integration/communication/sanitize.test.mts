import test from "node:test";
import assert from "node:assert/strict";
import { renderBody, sanitizeHtml } from "../../../packages/contracts/src/communication/html.ts";

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
