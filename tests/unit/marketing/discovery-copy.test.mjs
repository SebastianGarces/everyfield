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

test("both /discovery buttons and the How it works first step ask for access, not a self-serve sign-up", () => {
	assert.equal(page.hero.cta_primary, "Request free access");
	assert.equal(page.cta.cta_primary, "Request free access");
	assert.equal(page.cta.headline, "Take the time the call deserves.");
	assert.equal(page.hero.note, page.cta.note);
	assert.equal(page.how.steps[0], "Request free access. We'll invite you when early access opens.");
});

test("the /discovery FAQ answers time and sending with the approved words", () => {
	const answer = (id) => page.faq.items.find((i) => i.id === id)?.a;
	assert.equal(answer("time"), "No. Stay in Discovery as long as you're discerning.");
	assert.equal(answer("sending"), "No. You can request access on your own. Linking one is optional.");
});

test("the /discovery seat lines wait for early access to open", () => {
	assert.equal(page.ready.seat.headline, "Once early access opens, starting a church plant is when a seat comes in.");
	assert.deepEqual(page.ready.seat.items, [
		"We'll encourage you to ask your sending church or network to cover it, since that's how Everyfield is meant to work.",
		"If you're planting independently, you can pay for your own seat.",
	]);
	assert.equal(
		page.senders.body,
		"Discovery is free for them, and you don't need to set anything up. Once early access opens, when they're ready to start their church plant, you can cover their seat.",
	);
});

const screens = readFileSync(new URL("../../../apps/web/src/marketing/discovery/screens.tsx", import.meta.url), "utf8");
const start = screens.indexOf("const STARTER_STEPS");
const starterSteps = screens.slice(start, screens.indexOf("] as const;", start));

test("the /discovery copy and starter steps never promise sign-up, say a bare plant or spell neighbourhood", () => {
	assert.ok(starterSteps.includes("List the people already praying for this church plant"));
	assert.ok(starterSteps.includes("Agree the commitments this church plant will ask of your family"));
	assert.ok(starterSteps.includes("Walk the neighborhood and write down what you see"));
	for (const s of [...shown, starterSteps]) {
		assert.doesNotMatch(s, /Start exploring free|sign up|I'm exploring|neighbourhood/i, s);
		assert.doesNotMatch(s, /\bthis plant\b/i, s);
	}
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
