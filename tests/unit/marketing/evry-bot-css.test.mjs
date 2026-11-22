import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

function rules(css, scope) {
	const found = new Map();
	for (const [, selector, body] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
		const name = selector.replace(/\s+/g, " ").trim();
		if (!name.startsWith(`${scope} `)) continue;
		const declarations = Object.fromEntries(
			body
				.split(";")
				.map((d) => d.trim())
				.filter(Boolean)
				.map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
		);
		found.set(name.slice(scope.length + 1), { ...found.get(name.slice(scope.length + 1)), ...declarations });
	}
	return found;
}

const PRODUCT_SELECTOR = {
	'.evry-bot[data-eb][data-size="lg"]:not([data-hold], [data-mood="happy"]) .eb-body':
		'.evry-bot[data-eb]:is([data-size="lg"], [data-size="xl"]):not([data-hold], [data-mood="happy"]) .eb-body',
	'.evry-bot[data-mood="thinking"][data-size="lg"]::after':
		'.evry-bot[data-mood="thinking"]:not([data-size="xs"], [data-size="sm"])::after',
};

const LANDING_ONLY = {
	".evry-bot": { "--s": "24px", display: "block", flex: undefined, "vertical-align": undefined },
	'.evry-bot[data-mood="thinking"][data-size="lg"]::after': { background: "var(--color-ink-fixed)" },
};

test("INV-evry-bot: the landing pages draw Evry with the product's rules, apart from the listed landing sizing and the fixed-ink thinking dot", () => {
	const landing = rules(read("apps/web/src/styles/marketing.css"), "[data-evry-bot]");
	const product = rules(read("packages/ui/src/foundations/product.css"), "[data-product-root]");
	assert.ok(landing.size > 10);
	for (const [selector, declarations] of landing) {
		const target =
			PRODUCT_SELECTOR[selector] ?? (selector.startsWith(".evry-bot") ? selector : `.evry-bot ${selector}`);
		assert.ok(product.has(target), `product.css has no rule for ${target}`);
		const expected = Object.fromEntries(
			Object.entries({ ...product.get(target), ...LANDING_ONLY[selector] }).filter(([, v]) => v !== undefined),
		);
		assert.deepEqual(declarations, expected, selector);
	}
});
