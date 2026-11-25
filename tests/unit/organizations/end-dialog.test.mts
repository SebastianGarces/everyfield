import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mount, propsOf } from "../evry/fake-dom.mts";

class Control {
	get value() {
		return "";
	}
	set value(_: string) {}
}
const body = document.createElement("div");
Object.assign(Object.getPrototypeOf(body), {
	insertAdjacentElement() {},
	querySelectorAll: () => [],
	hasAttribute: () => false,
	remove() {},
	children: [],
});
Object.assign(document, {
	body,
	documentElement: document.createElement("html"),
	defaultView: globalThis,
	querySelectorAll: () => [],
	getElementById: () => body,
	createTreeWalker: () => ({ nextNode: () => null }),
});
Object.assign(globalThis, {
	HTMLTextAreaElement: Control,
	HTMLInputElement: Control,
	HTMLElement: Control,
	NodeFilter: {},
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	MutationObserver: class {
		observe() {}
		disconnect() {}
	},
});

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { createElement } = web("react");
const { EndDialog } = await import("../../../apps/web/src/features/organizations/EndDialog.tsx");

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const relationship = {
	id: id(1),
	revision: "3",
	pair: {
		kind: "plant",
		subject: { kind: "plant", id: id(2) },
		organization: { kind: "organization", id: id(3), organizationKind: "sending_church" },
	},
};
const SIDES = [
	{
		side: "subject",
		otherName: "First Church",
		title: "Leave First Church?",
		confirm: "Leave",
		consequences: [
			"First Church stops seeing anything your church shares, right away.",
			"Your other connections do not change.",
			"Your sharing choices are kept. If you connect with First Church again, they come back.",
		],
	},
	{
		side: "organization",
		otherName: "Harvest",
		title: "End the connection with Harvest?",
		confirm: "End connection",
		consequences: [
			"You stop seeing anything Harvest shared, right away.",
			"Harvest's other connections do not change.",
			"Harvest gets a notice that the connection ended.",
		],
	},
];
type Node = Parameters<typeof propsOf>[0];

for (const { side, otherName, title, confirm, consequences } of SIDES)
	test(`AC:AF-020 the ${side} side sees the exact connection and its consequences before anything ends, and a retry sends the same request`, async () => {
		const sent: { requestKey: string; expectedRevision: string; input: unknown }[] = [];
		const ended: unknown[] = [];
		const page = await mount(EndDialog, {
			side,
			relationship,
			otherName,
			end: async (command: (typeof sent)[number]) => {
				sent.push(command);
				if (sent.length === 1) throw new TypeError("Failed to fetch");
				return { items: [] };
			},
			onEnded: (history: unknown) => ended.push(history),
			trigger: createElement("button", null, "Open"),
		});
		const press = (label: string) =>
			page.run(() => {
				const found = (body as unknown as Node)
					.all()
					.find((n) => n.tagName === "BUTTON" && n.textContent.trim() === label);
				assert.ok(found, `${label} in: ${body.textContent}`);
				return propsOf(found).onClick?.({ preventDefault() {}, defaultPrevented: false });
			});
		await page.click("Open");
		for (const line of [title, ...consequences]) assert.ok(body.textContent!.includes(line), line);
		assert.equal(sent.length, 0, "opening the confirmation ends nothing");
		await press("Cancel");
		assert.deepEqual([sent.length, body.textContent], [0, ""]);
		await page.click("Open");
		await press(confirm);
		await press("Try again");
		assert.equal(sent.length, 2);
		assert.deepEqual(sent[1], sent[0]);
		assert.deepEqual(sent[0], {
			requestKey: sent[0]?.requestKey,
			expectedRevision: "3",
			input: { relationshipId: relationship.id, pair: relationship.pair, confirmed: true, reason: null },
		});
		assert.deepEqual(ended.at(-1), { items: [] });
		await page.unmount();
	});
