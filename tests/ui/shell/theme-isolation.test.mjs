// INV-theme: product dark mode never changes the light-only marketing pages (WP-088 acceptance gate 2).
// It runs against a running app: set UI_BASE_URL to the task preview, for example the URL from `pnpm stack:status`.
// Each test sets its own browser state (theme cookie and system color scheme) and reads nothing else.
//   UI_BASE_URL=http://wp-088-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const MARKETING_CANVAS = "rgb(252, 251, 248)";
const PRODUCT_DARK_FRAME = "rgb(15, 17, 21)";

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`INV-theme (${name}): a dark product visit leaves marketing pages light`, { timeout: 60_000 }, async () => {
    assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });
      await context.addCookies([{ name: "ef-theme", value: "dark", url: BASE }]);
      const page = await context.newPage();
      const state = () => page.evaluate(() => ({
        theme: document.documentElement.getAttribute("data-theme"),
        scheme: getComputedStyle(document.documentElement).colorScheme,
        body: getComputedStyle(document.body).backgroundColor,
      }));

      await page.goto(BASE + "/");
      assert.deepEqual(await state(), { theme: null, scheme: "light", body: MARKETING_CANVAS }, "marketing under a dark system setting and a dark product cookie");

      await page.goto(BASE + "/design/shell/owner");
      const product = await page.evaluate(() => getComputedStyle(document.querySelector("[data-product-root]")).backgroundColor);
      assert.equal(product, PRODUCT_DARK_FRAME, "the product reads the dark cookie");

      await page.getByRole("link", { name: "Open the marketing home page" }).click();
      await page.waitForURL(BASE + "/");
      assert.deepEqual(await state(), { theme: null, scheme: "light", body: MARKETING_CANVAS }, "marketing after a client navigation from the dark product");
    } finally {
      await browser.close();
    }
  });

  test(`BUG-PR83 (${name}): Back to a cached product page keeps the theme chosen there`, { timeout: 60_000 }, async () => {
    assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
    const browser = await engine.launch();
    try {
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      const themes = () => page.evaluate(() => ({
        html: document.documentElement.getAttribute("data-theme"),
        root: document.querySelector("[data-product-root]")?.getAttribute("data-theme") ?? null,
      }));

      await page.goto(BASE + "/design/shell/owner");
      await page.getByRole("radio", { name: "Dark mode" }).click();
      assert.deepEqual(await themes(), { html: "dark", root: "dark" }, "the switch selects dark");

      await page.getByRole("link", { name: "Open the marketing home page" }).click();
      await page.waitForURL(BASE + "/");
      assert.deepEqual(await themes(), { html: null, root: null }, "marketing stays light");

      await page.goBack();
      await page.waitForURL(BASE + "/design/shell/owner");
      await page.waitForTimeout(1000);
      assert.deepEqual(await themes(), { html: "dark", root: "dark" }, "the restored product page keeps dark");
    } finally {
      await browser.close();
    }
  });
}
