// Wiki diagram blocks (WP-034/ui criteria 7 to 9). Needs a People-seeded preview (tests/ui/people/seed.mts): its
// "Diagram blocks" article holds one block of each type, a plain code fence and one malformed diagram. Both engines run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const AXE = readFileSync(
	new URL("../../../node_modules/.pnpm/axe-core@4.14.0/node_modules/axe-core/axe.min.js", import.meta.url),
	"utf8",
);

const open = (engine, width, run) =>
	withPage(
		engine,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await page.goto(`${BASE}/wiki/diagram-blocks`);
			await hydrated(page);
			await page.locator("h1").waitFor();
			await run(page);
		},
		{ width },
	);

/** Every figure: its accessible name, the list role and each item's own text in source order. */
const figures = (page) =>
	page.locator("figure").evaluateAll((all) =>
		all.map((figure) => {
			const name = (figure.getAttribute("aria-labelledby") ?? "")
				.split(" ")
				.map((id) => document.getElementById(id)?.textContent ?? "")
				.join(" ");
			const list = figure.querySelector("ol, ul");
			const own = (li) =>
				[...li.children]
					.filter((el) => !/^(UL|OL)$/.test(el.tagName))
					.map((el) => el.textContent)
					.join("");
			return {
				name,
				list: list?.tagName,
				nested: figure.querySelectorAll("ul ul").length,
				items: [...figure.querySelectorAll("li")].map(own),
				hidden: [...figure.querySelectorAll("svg")].every((svg) => svg.closest('[aria-hidden="true"]')),
			};
		}),
	);

for (const [name, engine] of ENGINES) {
	test(`WP-034/ui: each diagram is a named figure with its nodes as a list in source order (${name})`, async () => {
		await open(engine, 1440, async (page) => {
			const all = await figures(page);
			assert.deepEqual(
				all.map((figure) => figure.name),
				[
					"How a guest becomes a member Flow diagram, 4 steps. Repeats: Each new guest starts again at the first visit",
					"Six phases from vision to launch Stages diagram, 6 stages",
					"The weekly ministry rhythm Cycle diagram, 4 steps. Repeats: Every week",
					"Leadership structure Hierarchy diagram, 7 items",
					"The first year after launch Timeline diagram, 5 milestones",
				],
			);
			assert.deepEqual(
				all.map((figure) => figure.list),
				["OL", "OL", "OL", "UL", "OL"],
			);
			assert.equal(all[3].nested, 4);
			assert.deepEqual(all[0].items, [
				"1First visitGreeted at the door and given a welcome cardWeek 1",
				"2Connect cardA personal follow-up within 48 hours",
				"3Newcomers lunchMeet the pastor and two team leadersMonth 1",
				"4Membership class",
			]);
			assert.deepEqual(all[3].items, [
				"Lead pastorVision and preaching",
				"Ministry directorSunday teams",
				"Team leaderHospitality",
				"VolunteerGreeter",
				"Team leaderKids",
				"Small group coachWeekday groups",
				"Small group leader",
			]);
			assert.deepEqual(all[4].items.slice(0, 2), [
				"Week 0Launch SundayThe first public service",
				"Week 1First guest follow-upEvery card answered",
			]);
			assert.ok(
				all.every((figure) => figure.hidden),
				"Every drawn connector is hidden from assistive tech",
			);
			// The roles a screen reader meets: figures named by title and alternative, lists and their items.
			const flow = page.getByRole("figure", { name: /^How a guest becomes a member Flow diagram, 4 steps/ });
			assert.equal(await flow.getByRole("list").getByRole("listitem").count(), 4);
			assert.equal(await page.getByRole("figure").count(), 5);
		});
	});

	test(`WP-034/ui: a malformed diagram shows its source as code and no parser message (${name})`, async () => {
		await open(engine, 390, async (page) => {
			const code = await page.locator("pre code").allTextContents();
			assert.deepEqual(code, [
				"Cash total:        $________\n                   ---------\n- this dash line stays text",
				"title: This block has a fault\n- One | two | three | four",
			]);
			assert.equal(await page.getByText(/at most three fields/).count(), 0);
		});
	});

	for (const width of [390, 1440])
		test(`WP-034/ui: diagrams stay inside the article column and axe finds no violation at ${width}px (${name})`, async () => {
			await open(engine, width, async (page) => {
				const layout = await page.evaluate(() => {
					const column = document.querySelector("figure").parentElement.getBoundingClientRect();
					return {
						page: document.documentElement.scrollWidth <= innerWidth,
						outside: [...document.querySelectorAll("figure, pre")].filter((el) => {
							const box = el.getBoundingClientRect();
							return box.left < column.left - 1 || box.right > column.right + 1;
						}).length,
						clipped: [...document.querySelectorAll("figure *:not(.sr-only)")].filter(
							(el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible",
						).length,
						vertical: getComputedStyle(document.querySelector('figure[data-diagram="flow"] ol')).flexDirection,
					};
				});
				assert.deepEqual(layout, {
					page: true,
					outside: 0,
					clipped: 0,
					vertical: width === 390 ? "column" : "row",
				});
				await page.addScriptTag({ content: AXE });
				const violations = await page.evaluate(async () => {
					const result = await window.axe.run(document, {
						runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
					});
					return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
				});
				assert.deepEqual(violations, []);
			});
		});
}
