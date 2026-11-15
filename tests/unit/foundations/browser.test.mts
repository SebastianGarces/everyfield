import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const ui = await import("../../../packages/ui/src/foundations/index.ts");

test("INV-hydration: every browser hook renders its neutral server value, so hydration never mismatches", () => {
	function Probe() {
		return createElement(
			"output",
			null,
			JSON.stringify({
				wide: ui.useMediaQuery("(min-width: 900px)"),
				wideOnServer: ui.useMediaQuery("(min-width: 900px)", true),
				reduced: ui.useReducedMotion(),
				hidden: ui.useDocumentHidden(),
				hash: ui.useLocationHash(),
				hydrated: ui.useHydrated(),
				zone: ui.useBrowserZone(),
				now: ui.useMinuteClock(),
			}),
		);
	}
	const html = renderToStaticMarkup(createElement(Probe));
	const values = JSON.parse(html.replace(/^<output>|<\/output>$/g, "").replaceAll("&quot;", '"'));
	assert.deepEqual(values, {
		wide: false,
		wideOnServer: true,
		reduced: false,
		hidden: false,
		hash: "",
		hydrated: false,
		zone: null,
		now: null,
	});
});

test("INV-debounce: only the last call runs, once; cancel, flush and detaching its node settle what is pending", (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const ran: string[] = [];
	const debouncer = ui.createDebouncer(300);

	debouncer.run(() => ran.push("a"));
	mock.timers.tick(200);
	debouncer.run(() => ran.push("b"));
	mock.timers.tick(299);
	assert.deepEqual(ran, []);
	mock.timers.tick(1);
	assert.deepEqual(ran, ["b"]);
	mock.timers.tick(1000);
	assert.deepEqual(ran, ["b"]);

	debouncer.run(() => ran.push("c"));
	debouncer.flush();
	debouncer.flush();
	mock.timers.tick(1000);
	assert.deepEqual(ran, ["b", "c"]);

	debouncer.run(() => ran.push("d"));
	debouncer.cancel();
	const detach = debouncer.cancelOnDetach(null);
	debouncer.run(() => ran.push("e"));
	detach();
	mock.timers.tick(1000);
	assert.deepEqual(ran, ["b", "c"]);
});

test("INV-cn: a call-site class wins over the primitive's conflicting class, and theme sizes never read as colours", async () => {
	const { buttonVariants } = await import("../../../packages/ui/src/controls/index.ts");
	const keepBoth = ui.cn(buttonVariants({ variant: "secondary" }), "flex-1").split(" ");
	assert.ok(keepBoth.includes("flex-1") && !keepBoth.includes("flex-none"));
	assert.equal(ui.cn("max-w-[720px] bg-surface-raised", "max-w-[1040px] bg-surface"), "max-w-[1040px] bg-surface");
	assert.equal(ui.cn("gap-[26px] max-app-sm:gap-5", "gap-5 max-app-sm:gap-3"), "gap-5 max-app-sm:gap-3");
	assert.equal(ui.cn("text-md text-ink", "text-text-2"), "text-md text-text-2");
	assert.equal(ui.cn("text-title-sm text-ink", "text-[14px]"), "text-ink text-[14px]");
	assert.equal(ui.cn("leading-[1.05] text-ink", "text-[52px]"), "leading-[1.05] text-ink text-[52px]");
	assert.equal(ui.cn("shadow-card rounded-card", "shadow-none rounded-full"), "shadow-none rounded-full");
	assert.equal(
		ui.cn("text-display-lg text-ink font-title", false, null, undefined),
		"text-display-lg text-ink font-title",
	);
});
