// The video preload of `evf ac run` (OPS-112). evf passes it with `node --test --import`, and node:test hands the flag to
// every test file process. With EVF_AC_VIDEO_DIR set, every context a launched browser opens records video there, as
// .agents/skills/verify-preview/scripts/capture.mjs records its flows: withPage contexts, browser.newPage and suites
// that call browser.newContext themselves. Playwright writes each file when its context or browser closes. The app
// test setup (tests/ui/setup.mjs) stays unchanged: this patches the Playwright copy it loads, found from the worktree.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.env.EVF_AC_VIDEO_DIR;
const playwright = join(process.cwd(), "apps/web/node_modules/playwright/index.mjs");

if (dir && existsSync(playwright)) {
	// Chromium and WebKit share the BrowserType prototype, so one patch of `launch` makes both record.
	const proto = Object.getPrototypeOf((await import(pathToFileURL(playwright).href)).chromium);
	const launch = proto.launch;
	proto.launch = async function (options) {
		const browser = await launch.call(this, options);
		const newContext = browser.newContext.bind(browser);
		browser.newContext = (opts = {}) =>
			newContext({ recordVideo: { dir, size: opts.viewport ?? { width: 1440, height: 900 } }, ...opts });
		return browser;
	};
}
