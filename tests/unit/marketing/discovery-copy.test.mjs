import "../runs-in/react-server.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { shared } = JSON.parse(readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"));
const page = shared.discovery_page;

const strings = (value) =>
	typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const shown = strings(page);

test("the /discovery copy shows Maya's Evry and carry-over lines in their exact words", () => {
	assert.equal(
		page.tour.tabs.find((t) => t.id === "evry")?.line,
		"Ask Evry, Everyfield's assistant, questions about the wiki and your own documents.",
	);
	assert.equal(
		page.ready.body,
		"Start your church plant in Everyfield and the rest opens up: your people, meetings, tasks, your launch journey toward Launch Sunday, and Evry with your church's context.",
	);
	assert.equal(page.ready.carry, "Everything you wrote in Discovery comes with you and stays private to you.");
	assert.deepEqual(page.faq.items.at(-1), {
		id: "notes",
		q: "What happens to my notes when I start my church plant?",
		a: "They come with you and stay private to you.",
	});
	assert.equal(shown.filter((s) => s.includes("questions about the wiki and your own documents")).length, 1);
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

test("the /discovery tour shows Tasks after Templates with the real /tasks wording, then Evry before When you're ready", () => {
	assert.deepEqual(
		page.tour.tabs.map((t) => t.id),
		["wiki", "documents", "templates", "tasks", "evry", "ready"],
	);
	assert.equal(
		page.tour.tabs.find((t) => t.id === "tasks")?.line,
		"Your starter steps for the discovery season. Check each one off as you go.",
	);
});
