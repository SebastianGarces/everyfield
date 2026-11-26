import "../runs-in/react-server.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { shared } = JSON.parse(readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"));
const page = shared.discovery_page;

const strings = (value) =>
	typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const shown = strings({ ...page, free: { ...page.free, evry: page.free.evry.shown ? page.free.evry.line : "" } });

test("the /discovery copy keeps its Evry claim off until Evry in Discovery passes QA", () => {
	assert.equal(page.free.evry.shown, false);
	assert.equal(
		shown.some((s) => /\bEvry\b/.test(s) && !s.includes("Evry with your church's context")),
		false,
	);
});

test("the /discovery copy carries no draft marker, price or banned claim", () => {
	const banned = [/\[DRAFT\]/, /\bPrototype\b/, /\bforever\b/i, /\bno time limit\b/i, /\bDiscovery tasks\b/i];
	const amount = /[$€£]\s?\d|\b\d+(?:\.\d+)?\s?(?:dollars|usd)\b|\bper (?:month|year|seat)\b|\/mo\b/i;
	for (const s of shown) {
		for (const re of banned) assert.doesNotMatch(s, re, s);
		assert.doesNotMatch(s, amount, s);
	}
});

test("both /discovery buttons and the How it works first step use the approved words", () => {
	assert.equal(page.hero.cta_primary, "Start exploring free");
	assert.equal(page.cta.cta_primary, "Start exploring free");
	assert.equal(page.hero.note, page.cta.note);
	assert.equal(page.how.steps[0], "Sign up free. Choose I'm exploring.");
});
