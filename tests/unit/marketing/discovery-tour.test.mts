import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mount, propsOf } from "../evry/fake-dom.mts";

let reduced = false;
const motionListeners = new Set<() => void>();
Object.assign(globalThis, {
	matchMedia: () => ({
		get matches() {
			return reduced;
		},
		addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
		removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener),
	}),
});
const visibilityListeners = new Set<() => void>();
Object.assign(document, {
	hidden: false,
	getElementById: () => null,
	addEventListener: (type: string, listener: () => void) =>
		type === "visibilitychange" && visibilityListeners.add(listener),
	removeEventListener: (_: string, listener: () => void) => visibilityListeners.delete(listener),
});

const { Tour } = await import("../../../apps/web/src/marketing/discovery/Tour.tsx");

const TABS = ["Wiki", "Documents", "Templates", "Tasks", "Evry", "When you're ready"].map((label) => ({
	id: label.split(" ")[0]!.toLowerCase(),
	label,
	line: `${label} line`,
	icon: null,
}));

async function tour() {
	const page = await mount(Tour, { label: "Tour", tabs: TABS, panels: TABS.map((t) => t.label) });
	type Node = ReturnType<typeof page.all>[number];
	const tabs = () => page.byTag("BUTTON");
	const lineOf = (tab: Node) => tab.childNodes.find((n) => n.getAttribute("aria-hidden") === "true")!;
	const selected = () => tabs().filter((t) => t.getAttribute("aria-selected") === "true");
	const shown = () => {
		const [tab, ...others] = selected();
		assert.equal(others.length, 0);
		const id = tab!.getAttribute("aria-controls");
		const panels = page.all().filter((n) => n.getAttribute("role") === "tabpanel");
		assert.deepEqual(
			panels.filter((p) => p.getAttribute("tabindex") === "0").map((p) => p.getAttribute("id")),
			[id],
		);
		assert.deepEqual(
			tabs().filter((t) => t.getAttribute("tabindex") === "0"),
			[tab],
		);
		return TABS.find((t) => tab!.textContent.startsWith(t.label))!.label;
	};
	const line = () => lineOf(selected()[0]!);
	const timeRunsOut = () => page.run(() => propsOf(line()).onAnimationEnd?.({}));
	const tourRoot = () => page.all().find((n) => n.getAttribute("id") === "tour")!;
	return {
		page,
		label: shown,
		line,
		lineClass: () => line().getAttribute("class") ?? "",
		held: () => tourRoot().getAttribute("data-held") === "true",
		timeRunsOut,
		click: (name: string) => page.run(() => propsOf(tabs().find((t) => t.textContent.startsWith(name))!).onClick?.({})),
		key: (key: string) => page.run(() => propsOf(selected()[0]!).onKeyDown?.({ key, preventDefault() {} })),
		focus: (visible: boolean) => page.run(() => propsOf(tourRoot()).onFocus?.({ target: { matches: () => visible } })),
		blurOut: () => page.run(() => propsOf(tourRoot()).onBlur?.({ currentTarget: tourRoot(), relatedTarget: null })),
	};
}

test("with no interaction the tour walks all six tabs in order every 7 s and loops", async () => {
	reduced = false;
	const t = await tour();
	const seen = [t.label()];
	for (let i = 0; i < TABS.length * 2; i++) {
		assert.match(t.lineClass(), /animate-mk-tab-fill\b(?!-)/);
		assert.doesNotMatch(t.lineClass(), /animate-mk-tab-fill-picked/);
		await t.timeRunsOut();
		seen.push(t.label());
	}
	assert.deepEqual(
		seen,
		[...TABS, ...TABS, TABS[0]].map((tab) => tab!.label),
	);
	await t.page.unmount();
});

test("a clicked or keyed tab is shown at once with a 15 s line, then the walk resumes at 7 s", async () => {
	reduced = false;
	const t = await tour();
	await t.click("Evry");
	assert.equal(t.label(), "Evry");
	assert.match(t.lineClass(), /animate-mk-tab-fill-picked/);
	await t.timeRunsOut();
	assert.equal(t.label(), "When you're ready");
	assert.doesNotMatch(t.lineClass(), /animate-mk-tab-fill-picked/);

	await t.key("ArrowRight");
	assert.equal(t.label(), "Wiki");
	assert.match(t.lineClass(), /animate-mk-tab-fill-picked/);
	await t.key("End");
	assert.equal(t.label(), "When you're ready");
	assert.match(t.lineClass(), /animate-mk-tab-fill-picked/);
	await t.page.unmount();
});

test("keyboard focus inside the tour holds the walk until focus leaves; mouse focus does not", async () => {
	reduced = false;
	const t = await tour();
	await t.focus(true);
	assert.equal(t.held(), true);
	await t.blurOut();
	assert.equal(t.held(), false);
	assert.equal(t.label(), "Wiki");

	await t.focus(true);
	await t.timeRunsOut();
	assert.equal(t.label(), "Wiki");
	assert.equal(t.held(), true);
	await t.blurOut();
	assert.equal(t.label(), "Documents");
	assert.equal(t.held(), false);
	await t.timeRunsOut();
	assert.equal(t.label(), "Templates");

	await t.focus(false);
	assert.equal(t.held(), false);
	await t.timeRunsOut();
	assert.equal(t.label(), "Tasks");
	await t.page.unmount();
});

test("under reduced motion the line is full and static, nothing advances, and clicks and keys still switch tabs", async () => {
	reduced = true;
	const t = await tour();
	assert.doesNotMatch(t.lineClass(), /animate-mk-tab-fill/);
	await t.timeRunsOut();
	assert.equal(t.label(), "Wiki");
	await t.click("Documents");
	assert.equal(t.label(), "Documents");
	await t.key("ArrowRight");
	assert.equal(t.label(), "Templates");
	await t.page.unmount();

	reduced = false;
	const live = await tour();
	reduced = true;
	await live.page.run(() => {
		for (const changed of motionListeners) changed();
	});
	assert.doesNotMatch(live.lineClass(), /animate-mk-tab-fill/);
	await live.timeRunsOut();
	assert.equal(live.label(), "Wiki");
	await live.page.unmount();
	reduced = false;
});

test("a hidden browser tab holds the line and flushes its style at once, so the pause lands while hidden", async () => {
	reduced = false;
	const t = await tour();
	const flushes: boolean[] = [];
	Object.assign(t.line(), { getAnimations: () => (flushes.push(t.held()), []) });
	const turn = (hidden: boolean) =>
		t.page.run(() => {
			Object.assign(document, { hidden });
			for (const changed of visibilityListeners) changed();
		});
	await turn(true);
	assert.equal(t.held(), true);
	assert.deepEqual(flushes, [true]);
	await turn(false);
	assert.equal(t.held(), false);
	assert.equal(t.label(), "Wiki");
	await t.page.unmount();
	assert.equal(visibilityListeners.size, 0);
});
