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
