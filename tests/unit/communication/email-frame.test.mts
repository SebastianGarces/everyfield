import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { PreviewStage } from "../../../apps/web/src/features/communication/EmailFrame.tsx";

const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");

test("INV-security: the email preview iframe is sandboxed to allow-same-origin alone, so a message runs no script and opens no form, popup or top page", () => {
	const html: string = renderToStaticMarkup(
		createElement(PreviewStage, {
			input: {
				bodyHtml: "<p>Hello</p>",
				name: "Ana",
				hasMeeting: false,
				origin: "https://app.example.test",
				churchName: "Grace",
				mailingAddress: null,
			},
			chrome: { from: "a@example.test", to: "b@example.test", subject: "Sunday" },
		}),
	);
	const frames = [...html.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]);
	assert.equal(frames.length, 1);
	assert.deepEqual(
		[...frames[0]!.matchAll(/\ssandbox="([^"]*)"/g)].map((m) => m[1]),
		["allow-same-origin"],
	);
	assert.match(frames[0]!, /Hello/);
});
