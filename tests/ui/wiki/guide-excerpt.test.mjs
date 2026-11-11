// WP-034/api: the Guide sheet and Wiki search show clean text from the domain. Needs a People-seeded preview: set
// UI_BASE_URL and PEOPLE_UI_FIXTURE (tests/ui/people/seed.mts, which writes the real articles every Guide route reads).
// Both browser engines run. Each test first runs the pure cut check of its criterion (tests/integration/wiki/
// excerpt-checks.mjs, which CI runs too), then reads the rendered Guide or search result on the preview.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionExcerpt } from "../../../packages/domain/src/wiki/excerpt.ts";
import { checks, PHASE_ROWS, seedBody } from "../../integration/wiki/excerpt-checks.mjs";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const RAW = [/(^|\s)#{1,6}\s/, /\*\*/, /(^|\s)---(\s|$)/, /\|/, /`/, /\]\(/, /<\/?[A-Za-z][^>]*>/];

/** Opens `path` signed in as the People owner, opens the Guide from the rail and returns its rendered article. */
async function openGuide(page, context, path) {
	await signIn(context, fixture("people").owner.cookie);
	await page.goto(`${BASE}${path}`);
	await hydrated(page);
	await page.locator('aside[aria-label="Secondary"] button', { hasText: "Guide" }).click();
	const sheet = page.getByRole("dialog", { name: "Guide" });
	await sheet.getByText("From the Wiki").waitFor({ timeout: 30_000 });
	return sheet.locator("article");
}

/** The Guide's visible text, checked for raw markdown and a doubled ellipsis. */
async function assertRenderedClean(article, label) {
	const text = (await article.innerText()).replace(/\s*Open the article\s*$/, "").trim();
	for (const raw of RAW) assert.doesNotMatch(text, raw, `${label}: ${raw}`);
	assert.doesNotMatch(text, /…\s*…|\.\.\.…/, `${label}: one ellipsis at most`);
	return text;
}

/**
 * The body rows of `table` as cell texts. Every row has the header's cells: the sheet adds no ellipsis of its own, so a
 * whole last table row gains no extra "…" cell.
 */
async function bodyRows(table) {
	const rows = await table
		.locator("tr")
		.evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("th, td")].map((td) => td.textContent.trim())));
	const [head, ...body] = rows;
	for (const row of body) assert.equal(row.length, head.length, row.join(" | "));
	return body;
}

/** Types `query` into the Wiki search dialog on /wiki and returns the visible text of each hit's snippet. */
async function searchSnippets(page, context, query) {
	await signIn(context, fixture("people").owner.cookie);
	await page.goto(`${BASE}/wiki`);
	await hydrated(page);
	await page.getByRole("searchbox", { name: "Search the wiki" }).click();
	const dialog = page.getByRole("dialog", { name: "Search the wiki" });
	await dialog.getByRole("searchbox", { name: "Search words" }).fill(query);
	await dialog.locator("mark").first().waitFor({ timeout: 30_000 });
	await dialog.getByText("Searching.").waitFor({ state: "detached" });
	const hits = dialog.locator("li a");
	const snippets = [];
	for (let index = 0; index < (await hits.count()); index++) {
		const hit = hits.nth(index);
		const parts = hit.locator("span.mt-1");
		if (!(await parts.count())) continue;
		snippets.push({
			title: await hit.locator("span.font-medium").first().innerText(),
			text: await parts.innerText(),
			marks: await parts.locator("mark").allInnerTexts(),
		});
	}
	assert.ok(snippets.length > 0, "search shows snippets");
	return snippets;
}

for (const [name, engine] of ENGINES) {
	test(`AC:WP-034/api-1: the /intelligence Guide shows the heading, the intro and the whole phase table (${name})`, async () => {
		checks[1]();
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/intelligence");
			await article.getByRole("heading", { name: "How to Navigate the Playbook" }).waitFor();
			await article.getByText(/^The Launch Playbook is organized into phases/).waitFor();
			const rows = await bodyRows(article.locator("table"));
			assert.deepEqual(
				rows,
				PHASE_ROWS.map((row) =>
					row
						.split("|")
						.slice(1, -1)
						.map((cell) => cell.trim().replaceAll("**", "")),
				),
			);
			assert.equal(await article.locator("table td strong").count(), 7);
			await assertRenderedClean(article, "/intelligence");
		});
	});

	test(`AC:WP-034/api-2: the /meetings Guide ends on a whole word, not "Present the vis" (${name})`, async () => {
		checks[2]();
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/meetings");
			const text = await assertRenderedClean(article, "/meetings");
			assert.doesNotMatch(text, /Present the vis…?$/);
			assert.match(text, /Present the…$/);
		});
	});

	test(`AC:WP-034/api-3: each Guide route ends at a block, sentence or whole word with no raw markdown (${name})`, async () => {
		checks[3]();
		const people = fixture("people").people;
		const person = Object.values(people)[0];
		await withPage(engine, async (page, context) => {
			for (const path of [
				"/people",
				`/people/${person}`,
				"/people/import",
				"/meetings",
				"/tasks/follow-ups",
				"/ministries",
				"/documents",
				"/intelligence",
			]) {
				const article = await openGuide(page, context, path);
				const text = await assertRenderedClean(article, path);
				if ((await article.locator("table").count()) > 0) await bodyRows(article.locator("table").last());
				assert.match(text, /([.!?:)]|[\p{L}\p{N}]…|[\p{L}\p{N}])$/u, `${path}: ${text.slice(-40)}`);
			}
		});
	});

	test(`AC:WP-034/api-4: a paragraph cut keeps whole sentences, else whole words with one … (${name})`, async () => {
		checks[4]();
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/ministries/00000000-0000-4000-8000-000000000001");
			const text = await assertRenderedClean(article, "/ministries/[teamId]");
			// The seeded section crosses the limit inside a paragraph with a sentence end, so it ends on that sentence.
			assert.match(text, /The best Facilities Leader actually enjoys logistics\.$/);
		});
	});

	test(`AC:WP-034/api-5: a list keeps only whole items (${name})`, async () => {
		checks[5]();
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/tasks/follow-ups");
			await assertRenderedClean(article, "/tasks/follow-ups");
			const items = await article.locator("li").allInnerTexts();
			assert.deepEqual(items.slice(-2), [
				"Personal phone call — Every attendee gets a call",
				"One-on-one meeting — Scheduled with high-interest individuals",
			]);
		});
	});

	test(`AC:WP-034/api-6: a table that starts inside the limit stays whole, and the sheet ellipsis is only one last cell (${name})`, async () => {
		checks[6]();
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/people");
			await assertRenderedClean(article, "/people");
			// Both seeded tables stay whole: the second starts inside the limit and ends past it.
			assert.equal(await article.locator("table").count(), 2);
			assert.deepEqual(
				(await bodyRows(article.locator("table").last())).map((row) => row[0]),
				[
					"How they heard about us",
					"First Vision Meeting attended",
					"Vision Meetings attended",
					"Current status",
					"Assigned to",
				],
			);
		});
	});

	test(`AC:WP-034/api-7: an MDX component that fits stays whole (${name})`, async () => {
		checks[7]();
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/people/import");
			const text = await assertRenderedClean(article, "/people/import");
			assert.match(text, /Outdated data is worse than no data—it creates false confidence\.$/);
		});
	});

	test(`AC:WP-034/api-8: the same cut holds with no heading and for safe_nodes text (${name})`, async () => {
		checks[8]();
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/documents");
			await assertRenderedClean(article, "/documents");
			await article.getByRole("heading", { name: "Overview of the Three Documents" }).waitFor();
		});
	});

	test(`AC:WP-034/api-9: the Guide shows the section cut that referenceExcerpt returns (${name})`, async () => {
		// referenceExcerpt has no screen; tests/integration/wiki/wiki.test.mts checks it equals the Guide body on the
		// database. Here the Guide renders exactly the cut sectionExcerpt makes for that article and heading.
		const cut = sectionExcerpt(
			"safe_mdx",
			seedBody("core-group/vision-meetings/planning-your-vision-meeting"),
			"Building Your Agenda",
		);
		await withPage(engine, async (page, context) => {
			const article = await openGuide(page, context, "/meetings/00000000-0000-4000-8000-000000000001");
			await assertRenderedClean(article, "/meetings/[meetingId]");
			const rows = cut.split("\n").filter((line) => /^\| \d/.test(line));
			assert.deepEqual(
				await bodyRows(article.locator("table")),
				rows.map((row) =>
					row
						.split("|")
						.slice(1, -1)
						.map((cell) => cell.trim()),
				),
			);
		});
	});

	test(`AC:WP-034/api-10: search snippets for "Phase" show no markdown and mark each match (${name})`, async () => {
		await withPage(engine, async (page, context) => {
			const snippets = await searchSnippets(page, context, "Phase");
			assert.ok(snippets.some((hit) => hit.title === "Welcome to the Launch Playbook"));
			for (const hit of snippets) {
				for (const raw of [/(^|\s)#{1,6}\s/, /\*\*/, /__/, /---/, /\|/, /`/, /\]\(/, /<[^>]*>/])
					assert.doesNotMatch(hit.text, raw, `${hit.title}: ${hit.text}`);
				assert.ok(hit.marks.length > 0, hit.title);
				for (const mark of hit.marks) assert.match(mark, /^phase/i, hit.title);
			}
		});
	});

	test(`AC:WP-034/api-11: snippets start and end on whole words, with a space between cells and lines (${name})`, async () => {
		const welcome = seedBody("getting-started/welcome-to-the-launch-playbook");
		await withPage(engine, async (page, context) => {
			const snippets = await searchSnippets(page, context, "Phase");
			for (const hit of snippets) {
				assert.doesNotMatch(hit.text, /^\s|\s$|\s{2}/, hit.title);
				for (const word of hit.text.split(" ")) assert.match(word, /[\p{L}\p{N}]/u, `${hit.title}: "${word}"`);
			}
			const playbook = snippets.find((hit) => hit.title === "Welcome to the Launch Playbook");
			// Each snippet word is a whole word of the article, never two cells or lines run together.
			for (const word of playbook.text.split(" ")) {
				const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
				const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				assert.match(welcome, new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u"), word);
			}
		});
	});
}
