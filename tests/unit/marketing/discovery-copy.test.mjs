import "../runs-in/react-server.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { shared } = JSON.parse(readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"));
const page = shared.discovery_page;

const strings = (value) =>
	typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const held = ({ shown, line }) => (shown ? line : "");
const shown = strings({
	...page,
	free: { ...page.free, evry: held(page.free.evry) },
	ready: { ...page.ready, carry: held(page.ready.carry) },
	faq: { ...page.faq, items: page.faq.items.filter((i) => i.shown !== false) },
});

test("the /discovery copy keeps its Evry claim off until Evry in Discovery passes QA", () => {
	assert.equal(page.free.evry.shown, false);
	assert.equal(
		shown.some((s) => /\bEvry\b/.test(s) && !s.includes("Evry with your church's context")),
		false,
	);
});

test("the /discovery copy keeps its notes-carry-over claims off until documents after starting a church pass QA", () => {
	assert.equal(page.ready.carry.shown, false);
	assert.equal(page.faq.items.find((i) => i.id === "notes")?.shown, false);
	assert.equal(
		shown.some((s) => /comes? with you/i.test(s)),
		false,
	);
});

test("the /discovery copy carries no draft marker, price or banned claim, and says 'trial' only in 'No trial clock'", () => {
	const banned = [/\[DRAFT\]/, /\bPrototype\b/, /\bforever\b/i, /\bno time limit\b/i, /\bDiscovery tasks\b/i];
	const amount = /[$€£]\s?\d|\b\d+(?:\.\d+)?\s?(?:dollars|usd)\b|\bper (?:month|year|seat)\b|\/mo\b/i;
	for (const s of shown) {
		for (const re of banned) assert.doesNotMatch(s, re, s);
		assert.doesNotMatch(s.replace("No trial clock", ""), /\btrial/i, s);
		assert.doesNotMatch(s, amount, s);
	}
});

test("both /discovery buttons and the How it works first step use the approved words", () => {
	assert.equal(page.hero.cta_primary, "Start exploring free");
	assert.equal(page.cta.cta_primary, "Start exploring free");
	assert.equal(page.hero.note, page.cta.note);
	assert.equal(page.how.steps[0], "Sign up free. Choose I'm exploring.");
});

test("the /discovery Templates tab uses the copy owner's templates line", () => {
	assert.equal(
		page.tour.tabs.find((t) => t.id === "templates")?.line,
		"Start from a template. It opens as a private document with your name already filled in.",
	);
});
