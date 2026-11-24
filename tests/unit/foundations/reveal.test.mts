import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mount } from "../evry/fake-dom.mts";

const at = (path: string) => new URL(`../../../apps/web/src/${path}`, import.meta.url).href;
const noAction = async () => assert.fail("no action runs while rendering");
mock.module(at("access/actions.ts"), { namedExports: { stepAccessForm: noAction, submitAccessRequest: noAction } });

const attached: string[] = [];
Object.assign(globalThis, {
	IntersectionObserver: class {
		observe() {
			attached.push("attach");
		}
		disconnect() {
			attached.push("detach");
		}
	},
});

const { Reveal, revealRef } = await import("../../../apps/web/src/components/motion/Reveal.tsx");
const { AccessForm } = await import("../../../apps/web/src/access/AccessForm.tsx");

test("INV-stable-ref: revealRef answers the same function for the same direction", () => {
	assert.equal(revealRef(), revealRef(false));
	assert.equal(revealRef(true), revealRef(true));
	assert.notEqual(revealRef(true), revealRef(false));
});

test("INV-stable-ref: Reveal keeps its observer when it renders again", async () => {
	for (const up of [false, true]) {
		attached.length = 0;
		const page = await mount(Reveal, { up, children: "One" });
		await page.update({ up, children: "Two" });
		assert.equal(page.text(), "Two");
		assert.deepEqual(attached, ["attach"]);
		await page.unmount();
		assert.deepEqual(attached, ["attach", "detach"]);
	}
});

test("INV-stable-ref: the access form keeps its observer when it renders again", async () => {
	const text = (submit: string) => ({
		progress: "Step {step} of {total}",
		back: "Back",
		continue: "Continue",
		submit,
		submitting: "Sending",
		who: { title: "Who", error: "Choose one", options: { planter: "Planter", church: "Church", network: "Network" } },
		optionalLabel: "optional",
		privacyNote: { text: "Privacy policy", link: "Privacy" },
		contactEmail: "hello@example.test",
		outcomes: Object.fromEntries(
			["received", "invalid", "unavailable", "offline"].map((name) => [name, { title: name, body: name }]),
		),
	});
	const steps = [1, 2, 3].map((n) => ({ title: `Step ${n}`, fields: [] }));
	const paths = { planter: steps, church: steps, network: steps };
	attached.length = 0;
	const form = await mount(AccessForm, { paths, text: text("Send") });
	await form.update({ paths, text: text("Ask for access") });
	assert.equal(form.byTag("FORM")[0]?.getAttribute("aria-label"), "Ask for access");
	assert.deepEqual(attached, ["attach"]);
	await form.unmount();
});
