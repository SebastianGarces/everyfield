import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
import type { DeliveryTotals } from "../../../apps/web/src/features/communication/model.ts";
const { deliveryName, Totals } = await import("../../../apps/web/src/features/communication/SentTotals.tsx");

const zero: DeliveryTotals = {
	communicationId: "6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
	state: "sending",
	selected: 0,
	reachable: 0,
	attempted: 0,
	accepted: 0,
	sent: 0,
	delivered: 0,
	opened: 0,
	clicked: 0,
	bounced: 0,
	failed: 0,
	suppressed: 0,
	unsubscribed: 0,
	unknown: 0,
	cancelled: 0,
	cancelOpen: 0,
	asOf: "2026-11-12T10:00:00.000Z",
	rate: null,
	outcomes: [],
	sentForAll: false,
};
const anaSkipped: DeliveryTotals = {
	...zero,
	selected: 3,
	reachable: 2,
	attempted: 2,
	accepted: 2,
	unsubscribed: 1,
	rate: 0,
	outcomes: ["accepted"],
};

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

function summary(totals: DeliveryTotals) {
	const html = renderToStaticMarkup(createElement(Totals, { totals }));
	const tiles: Record<string, number> = {};
	for (const [, value, label] of html.matchAll(/<span[^>]*>(\d+)<\/span><span[^>]*>([^<]+)<\/span>/g))
		tiles[label] = Number(value);
	const groups: Record<string, Record<string, number>> = {};
	for (const [, title, body] of html.matchAll(/<h3[^>]*>([^<]+)<\/h3><dl[^>]*>(.*?)<\/dl>/g)) {
		groups[title] = {};
		for (const [, label, value] of body.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>(\d+)<\/dd>/g))
			groups[title][label] = Number(value);
	}
	const words = /Provider words: ([^.]*)\./.exec(text(html))?.[1] ?? null;
	return { tiles, groups, words };
}

test("AC:CASE-NTF-016: after the send, Not delivered leaves Ana out and a Skipped count of her own reads 1", () => {
	const { tiles, groups, words } = summary(anaSkipped);
	assert.deepEqual(tiles, { Reachable: 2, Delivered: 0, Opened: 0, "Not delivered": 0 });
	assert.deepEqual(groups["Not delivered"], { Bounced: 0, Failed: 0, Suppressed: 0, Unknown: 0 });
	assert.deepEqual(groups.Skipped, { Unsubscribed: 1 });
	assert.deepEqual(Object.keys(groups), ["Delivery", "Engagement", "Not delivered", "Skipped"]);
	assert.equal(deliveryName("unsubscribed"), "Skipped: unsubscribed");
	assert.equal(words, "Accepted");
});

test("AC:CASE-NTF-016: a send with a bounce and a failure and no unsubscribes counts both as Not delivered and shows Skipped 0", () => {
	const { tiles, groups } = summary({
		...anaSkipped,
		selected: 4,
		reachable: 4,
		attempted: 4,
		accepted: 3,
		delivered: 2,
		bounced: 1,
		failed: 1,
		suppressed: 1,
		unknown: 1,
		unsubscribed: 0,
		outcomes: ["accepted", "rejected"],
	});
	assert.equal(tiles["Not delivered"], 4);
	assert.deepEqual(groups["Not delivered"], { Bounced: 1, Failed: 1, Suppressed: 1, Unknown: 1 });
	assert.deepEqual(groups.Skipped, { Unsubscribed: 0 });
});
