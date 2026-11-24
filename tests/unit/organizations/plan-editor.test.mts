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
Object.assign(globalThis, { HTMLSelectElement: Control, HTMLInputElement: Control });

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { createElement } = web("react");
const { PlanEditor } = await import("../../../apps/web/src/features/organizations/programs/PlanEditor.tsx");

const KEYS = ["stage-key-5f0c", "milestone-key-91ab", "milestone-key-77de"] as const;
const draft = {
	rhythm: "weekly",
	expectedMonths: "12",
	stages: [{ key: KEYS[0], label: "Learn", min: "1", max: "3" }],
	milestones: [KEYS[1], KEYS[2]].map((key, i) => ({
		key,
		lineage: `lineage-${i}`,
		title: `Milestone ${i}`,
		description: "",
		handsOn: false,
	})),
	readings: [],
};
let submits = 0;
const Page = () =>
	createElement(
		"form",
		{
			onSubmit: () => {
				submits++;
			},
		},
		createElement(PlanEditor, { value: draft, onChange: () => {} }),
	);

test("INV-plan-editor: the reading list is no form inside the form, and Enter in its search searches without submitting", async () => {
	const asked: string[] = [];
	globalThis.fetch = (async (url: string) => {
		asked.push(String(url));
		return Response.json({ status: "ok", value: [] });
	}) as typeof fetch;
	const page = await mount(Page, {});
	assert.equal(page.byTag("FORM").length, 1, "only the outer form");
	assert.equal(page.all().filter((n) => n.getAttribute("role") === "search").length, 1);
	const search = page.byTag("INPUT").find((n) => n.getAttribute("aria-label") === "Search Wiki articles");
	assert.ok(search);
	const press = async (key: string) => {
		let prevented = false;
		await page.run(() => propsOf(search).onKeyDown?.({ key, preventDefault: () => (prevented = true) }));
		return prevented;
	};
	assert.equal(await press("a"), false, "other keys type");
	assert.equal(asked.length, 0);
	assert.equal(await press("Enter"), true, "Enter does not submit the outer form");
	assert.equal(asked.length, 1, "Enter searches");
	assert.equal(submits, 0);
	const submitters = page.byTag("BUTTON").filter((n) => n.getAttribute("type") !== "button");
	assert.deepEqual(
		submitters.map((n) => n.textContent),
		[],
		"no control of the editor submits the outer form",
	);
	await page.unmount();
});

test("INV-plan-editor: no row's random key is an HTML id or a reference to one", async () => {
	const page = await mount(Page, {});
	const references = page
		.all()
		.flatMap((n) => [...n.attributes].filter(([name]) => name === "id" || name === "for" || name.startsWith("aria-")));
	assert.ok(
		references.some(([name, value]) => name === "id" && value.includes("hands-on")),
		"the checkboxes have ids",
	);
	for (const [name, value] of references)
		for (const key of KEYS) assert.ok(!value.includes(key), `${name}="${value}" holds a row key`);
	await page.unmount();
});
