// Escaped People bugs require real producer state and a seeded production preview.
// Set UI_BASE_URL and PEOPLE_UI_FIXTURE from seed.mts; both browser engines run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, signIn, withPage as onPreview } from "../setup.mjs";

const seed = () => fixture("people");

/** Opens a page signed in as `who` (owner, member, seatless or null for signed out). */
const withPage = (engine, who, run, size = {}) =>
	onPreview(
		engine,
		async (page, context) => {
			if (who) await signIn(context, seed()[who].cookie);
			await run(page, context);
		},
		size,
	);

/** Server actions are POSTs with a Next-Action header. `handle` gets each one and decides what reaches the server. */
async function onActions(context, handle) {
	let n = 0;
	await context.route("**/*", async (route) => {
		const r = route.request();
		if (r.method() === "POST" && r.headers()["next-action"]) return handle(route, ++n);
		return route.fallback();
	});
}

const unique = (engine) => `Test ${engine} ${Date.now().toString(36)}`;
async function addPerson(page, name) {
	await page.goto(`${BASE}/people`);
	await page.getByRole("button", { name: "Add person" }).first().click();
	const dialog = page.getByRole("dialog", { name: "Add a person" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Add person" }).click();
	await page.getByRole("heading", { level: 1, name }).waitFor({ timeout: 30_000 });
	return page.url();
}

/** Where focus is now: the element's tag, its type and whether it is the dialog's refusal. */
const focused = (page) =>
	page.evaluate(() => {
		const a = document.activeElement;
		return {
			tag: a?.tagName,
			type: a?.getAttribute("type"),
			alert: a?.getAttribute("role") === "alert",
			invalid: a?.getAttribute("aria-invalid"),
		};
	});
/** Answers every choice group that has no answer yet with its first option. */
async function answerChoices(dialog) {
	for (const group of await dialog.getByRole("radiogroup").all())
		if ((await group.getByRole("radio", { checked: true }).count()) === 0)
			await group.getByRole("radio").first().click();
}
/** A name longer than the field allows: the browser limit is lifted, so the server refuses it with no field named. */
async function overlong(input) {
	await input.evaluate((e) => e.removeAttribute("maxlength"));
	await input.fill("N".repeat(600));
}
const ahead = () => new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
/** Tab and Shift+Tab from the focused refusal keep the focus inside the dialog (its focus trap knows where it is). */
async function staysInDialog(page, what) {
	for (const key of ["Tab", "Shift+Tab"]) {
		await page.keyboard.press(key);
		const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
		assert.ok(inside, `${what}: ${key} keeps the focus inside the dialog`);
	}
}

for (const [name, engine] of ENGINES) {
	test(`BUG-249-focus (${name}): a reopened record form focuses the field its refusal names, else the refusal`, async () => {
		// RecordDialog alone decides where focus starts (F4b-V1, V2): no field inside it may take focus on its own.
		const cards = [
			{
				card: "commitment",
				open: /^Record (a commitment card for |commitment$)/,
				fill: async (d) => d.locator('input[type="date"]').fill(ahead()),
				save: "Save commitment",
				expect: { tag: "INPUT", type: "date", invalid: "true" },
			},
			{
				card: "4 C's",
				open: /^Record (a 4 C's assessment for |the 4 C)/,
				fill: async (d) => (await answerChoices(d), d.getByLabel("Assessed on").fill(ahead())),
				save: "Save assessment",
				expect: { tag: "INPUT", type: "date", invalid: "true" },
			},
			{
				card: "interview",
				open: /^Record (an interview with |an interview$)/,
				fill: async (d) => (await answerChoices(d), d.getByLabel("Interviewed on").fill(ahead())),
				save: "Save interview",
				expect: { tag: "INPUT", type: "date", invalid: "true" },
			},
			{
				card: "skills",
				open: /^Add a skill/,
				fill: async (d, page) => {
					await overlong(d.getByLabel("Skill", { exact: true }));
					await d.getByRole("combobox", { name: "Category" }).click();
					await page.getByRole("option").first().click();
				},
				save: "Add skill",
				expect: { alert: true },
			},
			{
				card: "household",
				open: /^Start a household/,
				fill: async (d) => overlong(d.getByLabel("Household name")),
				save: "Start household",
				expect: { alert: true },
			},
		];
		await withPage(engine, "owner", async (page) => {
			await addPerson(page, unique(name));
			// Escape returns the focus to the button that opened the dialog (F4b-V4): the dialog's own focus step must
			// capture the opener before the form takes the focus.
			const opener = page.getByRole("button", { name: cards[0].open }).first();
			await opener.focus();
			await page.keyboard.press("Enter");
			await page.getByRole("dialog").waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("dialog").waitFor({ state: "detached" });
			await page
				.waitForFunction(() => document.activeElement !== document.body, null, { timeout: 5_000 })
				.catch(() => {});
			assert.ok(await opener.evaluate((e) => e === document.activeElement), "Escape returns the focus to the opener");
			for (const c of cards) {
				await page.getByRole("button", { name: c.open }).first().click();
				const d = page.getByRole("dialog");
				await c.fill(d, page);
				await d.getByRole("button", { name: c.save, exact: true }).click();
				await d.getByRole("alert").waitFor({ timeout: 30_000 });
				await page.waitForTimeout(300);
				const f = await focused(page);
				for (const [k, v] of Object.entries(c.expect)) assert.equal(f[k], v, `${c.card}: ${JSON.stringify(f)}`);
				await staysInDialog(page, c.card);
				await d.getByRole("button", { name: "Cancel" }).click();
				await d.waitFor({ state: "detached" });
			}
			// Forms with only buttons (F4b-V3): WebKit skips buttons on Tab, so only the trap keeps the focus in the dialog.
			// The household's address differs from the person's, so Copy address is offered. The real server refuses an ID
			// that is not a UUID.
			await page
				.getByRole("button", { name: /^Start a household/ })
				.first()
				.click();
			const start = page.getByRole("dialog");
			await start.getByLabel("Household name").fill(unique(name));
			await start.getByLabel(/^Street/).fill("100 Synthetic Lane");
			await start.getByRole("button", { name: "Start household", exact: true }).click();
			await start.waitFor({ state: "detached" });
			const actions = page.getByRole("button", { name: "Household actions", exact: true });
			await actions.click();
			await page.getByRole("menuitem", { name: "Edit household", exact: true }).click();
			const edit = page.getByRole("dialog");
			await edit.getByLabel(/^Street/).fill("200 Synthetic Lane");
			await edit.getByRole("button", { name: "Save household", exact: true }).click();
			await edit.waitFor({ state: "detached" });
			for (const [item, button] of [
				["Copy address to members", /^Copy to /],
				[/^Take .* out$/, /^Take out of household$/],
			]) {
				await actions.click();
				await page.getByRole("menuitem", { name: item }).click();
				const d = page.getByRole("dialog");
				await page.route("**/*", (route) => {
					const r = route.request();
					if (r.method() !== "POST" || !r.headers()["next-action"]) return route.fallback();
					const body = (r.postData() ?? "").replace(/"(personId|householdId)":"[0-9a-f-]+"/, '"$1":"not-a-uuid"');
					return route.continue({ postData: body });
				});
				await d.getByRole("button", { name: button }).click();
				await d.getByRole("alert").waitFor({ timeout: 30_000 });
				await page.unroute("**/*");
				assert.equal((await focused(page)).alert, true, `${item}: the refusal of a button-only form is focused`);
				await staysInDialog(page, String(item));
				await d.getByRole("button", { name: "Cancel" }).click();
				await d.waitFor({ state: "detached" });
			}

			// A task due at 2:30 on the morning clocks spring forward in Austin: the refusal names the time.
			await page.goto(`${BASE}/tasks`);
			await page.getByRole("button", { name: "New task", exact: true }).first().click();
			const d = page.getByRole("dialog");
			await page.waitForTimeout(300);
			assert.equal((await focused(page)).tag, "INPUT", "a new form focuses its first field, the title");
			await d.getByLabel("Title", { exact: true }).fill(unique(name));
			await d.getByRole("combobox", { name: "Due", exact: true }).click();
			await page.getByRole("option", { name: "Due at a time", exact: true }).click();
			await d.getByLabel("Day", { exact: true }).fill("2027-03-14");
			await d.getByLabel("Time", { exact: false }).fill("02:30");
			await d.getByRole("button", { name: "Add task", exact: true }).click();
			await d.getByRole("alert").waitFor({ timeout: 30_000 });
			await page.waitForTimeout(300);
			const f = await focused(page);
			assert.deepEqual({ type: f.type, invalid: f.invalid }, { type: "time", invalid: "true" }, JSON.stringify(f));
			await staysInDialog(page, "task");
		});
	});

	test(`BUG-hydration (${name}): a person page with dated activity hydrates without a page error`, async () => {
		await withPage(engine, "owner", async (page) => {
			const errors = [];
			page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
			await page.goto(`${BASE}/people/${seed().people["Maria Santos"]}`, { waitUntil: "networkidle" });
			await page.getByRole("heading", { name: "Activity" }).waitFor();
			assert.equal(await page.getByRole("heading", { name: "Maria Santos", level: 1 }).count(), 1);
			assert.equal(
				await page.getByText("Wants to lead worship one Sunday a month after the baby comes.", { exact: true }).count(),
				1,
			);
			await page.waitForTimeout(1000);
			assert.deepEqual(errors, []);
		});
	});

	test(`AC:TARGET-PPL-001 INV-pages (${name}): page numbers and filters share the address; past the end shows the last page`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people?retired=include`);
			await page.getByRole("button", { name: "Page 2", exact: true }).click();
			// Client navigation changes the address without a page load, so wait on the address itself.
			await page.waitForFunction(() => new URLSearchParams(location.search).get("page") === "2", null, {
				timeout: 30_000,
			});
			await page
				.getByRole("main")
				.getByText(/^Showing 25–/)
				.waitFor();
			assert.equal(
				await page.getByRole("button", { name: "Page 2", exact: true }).getAttribute("aria-current"),
				"page",
			);
			await page.getByRole("button", { name: /^Source/ }).click();
			await page.getByRole("option", { name: "Other" }).click();
			await page.waitForFunction(() => new URLSearchParams(location.search).get("source") === "other", null, {
				timeout: 30_000,
			});
			const url = new URL(page.url());
			assert.equal(url.searchParams.get("page"), null, "a filter change goes back to page one");
			assert.equal(url.searchParams.get("retired"), "include", "the sibling filter stays");
			// D67: a page number past the end shows the last page, never an error.
			await page.goto(`${BASE}/people?retired=include&page=9999`);
			const range = await page
				.getByRole("main")
				.getByText(/^Showing \d+/)
				.textContent();
			const [, first, total] = range.match(/^Showing (\d+)(?:–\d+)? of (\d+)/);
			const last = Math.ceil(Number(total) / 24);
			assert.equal(Number(first), (last - 1) * 24 + 1, range);
			assert.equal(
				await page.getByRole("button", { name: `Page ${last}`, exact: true }).getAttribute("aria-current"),
				"page",
			);
			assert.equal(await page.getByRole("button", { name: "Next page" }).isDisabled(), true);
		});
		// A member reads the same pages without write controls.
		await withPage(engine, "member", async (page) => {
			await page.goto(`${BASE}/people?retired=include&page=2`);
			await page
				.getByRole("main")
				.getByText(/^Showing 25–/)
				.waitFor();
			assert.equal(await page.getByRole("button", { name: "Add person" }).count(), 0);
		});
	});

	test(`AC:TARGET-PPL-007 BUG-124-focus (${name}): after keyboard moves in two columns, focus stays on the last moved card`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people?view=pipeline`);
			/** Moves the second card of a column up with the keyboard; gives its name once the server order shows it first. */
			const moveSecondUp = async (label) => {
				const column = page.getByRole("list", { name: label });
				await column.waitFor();
				const revision = () =>
					page.evaluate(
						(l) =>
							document
								.querySelector(`[aria-label="${l}"]:not([hidden] *)`)
								?.closest("[data-revision]")
								?.getAttribute("data-revision"),
						label,
					);
				const before = await revision();
				const second = (await column.getByRole("article").nth(1).getAttribute("aria-label")) ?? "";
				await page.getByRole("button", { name: `Move ${second}` }).focus();
				await page.keyboard.press("Enter");
				await page.getByRole("menuitem", { name: "Move up" }).waitFor();
				await page.keyboard.press("Home");
				await page.keyboard.press("Enter");
				await page.waitForFunction(
					([l, n]) =>
						document.querySelector(`[aria-label="${l}"]:not([hidden] *) article`)?.getAttribute("aria-label") === n,
					[label, second],
					{ timeout: 30_000 },
				);
				// Wait for the refresh: the column shows the server's new revision, so a remount would have happened.
				await page.waitForFunction(
					([l, r]) =>
						document
							.querySelector(`[aria-label="${l}"]:not([hidden] *)`)
							?.closest("[data-revision]")
							?.getAttribute("data-revision") !== r,
					[label, before],
					{ timeout: 60_000 },
				);
				await page.waitForTimeout(500);
				return second;
			};
			const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
			const first = await moveSecondUp("Following up people");
			assert.equal(await focused(), `Move ${first}`);
			const core = await moveSecondUp("Core group people");
			assert.equal(await focused(), `Move ${core}`);
			const last = await moveSecondUp("Following up people");
			await page.waitForTimeout(1500);
			assert.equal(await focused(), `Move ${last}`, "an earlier column's request does not pull focus back");
		});
	});

	test(`AC:TARGET-PPL-007 BUG-124-conflict (${name}): a stale page's Move up refuses and says why after the refresh`, async () => {
		await withPage(engine, "owner", async (a, context) => {
			const b = await context.newPage();
			const column = (p) => p.getByRole("list", { name: "Following up people" });
			for (const p of [a, b]) {
				await p.goto(`${BASE}/people?view=pipeline`);
				await column(p).waitFor();
			}
			const second = (await column(a).getByRole("article").nth(1).getAttribute("aria-label")) ?? "";
			await a.getByRole("button", { name: `Move ${second}` }).click();
			await a.getByRole("menuitem", { name: "Move up" }).click();
			await a.getByText(`${second} moved up.`).waitFor({ state: "attached", timeout: 30_000 });
			await b.getByRole("button", { name: `Move ${second}` }).click();
			await b.getByRole("menuitem", { name: "Move up" }).click();
			const message = b.getByText("The order changed somewhere else.", { exact: false });
			await message.waitFor({ timeout: 30_000 });
			// The refusal refreshes page B to the server's order; the message must survive that refresh.
			await b.waitForFunction(
				(n) =>
					document
						.querySelector('[aria-label="Following up people"]:not([hidden] *) article')
						?.getAttribute("aria-label") === n,
				second,
				{ timeout: 30_000 },
			);
			await b.waitForTimeout(1500);
			assert.equal(await message.count(), 1, "the refusal is still shown after the refresh");
		});
	});

	test(`AC:TARGET-PPL-002 BUG-church-date (${name}): adult or child needs an explicit date; a church-future date is refused`, async () => {
		await withPage(engine, "owner", async (page) => {
			await addPerson(page, unique(name));
			await page.getByRole("button", { name: "More actions" }).click();
			await page.getByRole("menuitem", { name: "Record adult or child" }).click();
			const dialog = page.getByRole("dialog", { name: "Record adult or child" });
			const date = dialog.getByLabel("As of");
			// No default from the reader's clock: it can be the church's tomorrow (verifier finding on f0ea75d).
			assert.equal(await date.inputValue(), "");
			await dialog.getByLabel("Reason").fill("Said so at the vision meeting");
			await dialog.getByRole("button", { name: "Record" }).click();
			await dialog.getByText("Choose the date you learned this.").waitFor();
			// Three days ahead is in the future in every time zone.
			const ahead = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
			await date.fill(ahead);
			await dialog.getByRole("button", { name: "Record" }).click();
			await dialog.getByText("This date is after today at your church.").waitFor({ timeout: 30_000 });
			await date.fill("2026-01-15");
			await dialog.getByRole("button", { name: "Record" }).click();
			await dialog.waitFor({ state: "detached", timeout: 30_000 });
			await page.waitForFunction(() => document.body.innerText.includes("Adult or child recorded"), null, {
				timeout: 30_000,
			});
		});
	});

	test(`AC:REQ-PPL-026 F15 (${name}): a birth date sets adult or child and hides the manual record; Activity is newest first`, async () => {
		await withPage(engine, "owner", async (page) => {
			await addPerson(page, unique(name));
			const menu = async () => {
				await page.getByRole("button", { name: "More actions" }).click();
				const offered = await page.getByRole("menuitem", { name: /^(Record|Correct) adult or child$/ }).count();
				await page.keyboard.press("Escape");
				return offered;
			};
			// No birth date: the manual record is offered, as before.
			assert.equal(await menu(), 1);
			const activity = page.getByRole("list", { name: "Activity, newest first" });
			await page.getByText("Newest first", { exact: true }).waitFor();
			assert.match(await activity.getByRole("listitem").first().innerText(), /Added to People/);

			await page.getByRole("button", { name: "Edit profile" }).first().click();
			const profile = page.getByRole("dialog", { name: "Edit profile" });
			const thirty = new Date(Date.now() - 30 * 365.25 * 864e5).toISOString().slice(0, 10);
			await profile.getByLabel("Birth date").fill(thirty);
			await profile.getByRole("button", { name: "Save changes" }).click();
			await profile.waitFor({ state: "detached", timeout: 30_000 });
			// The card shows the derived value and its source at once, and the menu no longer offers the record.
			await page.getByText("From birth date", { exact: true }).waitFor({ timeout: 30_000 });
			const card = page
				.locator("section,div")
				.filter({ hasText: /^Adult or child/ })
				.last();
			assert.match(await card.innerText(), /Adult/);
			assert.equal(await menu(), 0);
			// The edit is the newest event, so it is on top of the first page without a reload.
			assert.match(await activity.getByRole("listitem").first().innerText(), /Details changed/);
			await page.reload();
			assert.match(
				await page.getByRole("list", { name: "Activity, newest first" }).getByRole("listitem").first().innerText(),
				/Details changed/,
			);
			await page.getByText("From birth date", { exact: true }).waitFor();
		});
	});

	test(`AC:TARGET-PPL-007 BUG-124-replay (${name}): a replayed reorder shows the column's latest order with its revision`, async () => {
		await withPage(engine, "owner", async (a, context) => {
			// The accessible list only: right after a load, WebKit can still hold React's hidden streamed copy of the page
			// (<div hidden id="S:0">), which a document query would count twice.
			const order = (p) =>
				p
					.getByRole("list", { name: "Following up people" })
					.getByRole("article")
					.evaluateAll((a) => a.map((x) => x.getAttribute("aria-label")));
			await a.goto(`${BASE}/people?view=pipeline`);
			await a.getByRole("list", { name: "Following up people" }).waitFor();
			const [x, y] = await order(a);
			// A's first save commits on the server, but its answer is lost on the way back.
			let dropped = false;
			await a.route("**/*", async (route) => {
				const r = route.request();
				if (
					!dropped &&
					r.method() === "POST" &&
					r.headers()["next-action"] &&
					(r.postData() ?? "").includes("afterId")
				) {
					dropped = true;
					await route.fetch();
					return route.abort();
				}
				return route.fallback();
			});
			await a.getByRole("button", { name: `Move ${y}` }).click();
			await a.getByRole("menuitem", { name: "Move up" }).click();
			await a.getByText("We did not hear back from the server").waitFor({ timeout: 30_000 });
			// B sees A's committed order and moves the other person back up.
			const b = await context.newPage();
			await b.goto(`${BASE}/people?view=pipeline`);
			await b.getByRole("list", { name: "Following up people" }).waitFor();
			assert.deepEqual(await order(b), [y, x]);
			await b.getByRole("button", { name: `Move ${x}` }).click();
			await b.getByRole("menuitem", { name: "Move up" }).click();
			await b.getByText(`${x} moved up.`).waitFor({ state: "attached", timeout: 30_000 });
			// A retries the same request: the server replays A's result, and A shows the column as it is now (B's order).
			await a.getByRole("button", { name: `Move ${y}` }).click();
			await a.getByRole("menuitem", { name: "Move up" }).click();
			await a
				.getByText("The order changed somewhere else. The column shows the latest order.")
				.waitFor({ state: "attached", timeout: 30_000 });
			assert.deepEqual(await order(a), [x, y], "A shows B's order, not its own replayed one");
			// A's next move uses the revision that belongs to that order, so it saves instead of being refused.
			await a.getByRole("button", { name: `Move ${y}` }).click();
			await a.getByRole("menuitem", { name: "Move up" }).click();
			await a.getByText(`${y} moved up.`).waitFor({ state: "attached", timeout: 30_000 });
			assert.equal(await a.getByText("The order changed somewhere else. The column now shows").count(), 0);
		});
	});

	test(`BUG-124-target-size (${name}): person card links are at least 24px tall in the pipeline and card views (WCAG 2.2)`, async () => {
		await withPage(
			engine,
			"owner",
			async (page) => {
				for (const view of ["pipeline", "card"]) {
					await page.goto(`${BASE}/people?view=${view}`);
					const links = page.getByRole("article").getByRole("link");
					await links.first().waitFor();
					assert.ok(await links.count(), "the active view exposes person links");
					const small = await page
						.getByRole("article")
						.getByRole("link")
						.evaluateAll((links) =>
							links.map((l) => ({ name: l.textContent, h: l.getBoundingClientRect().height })).filter((l) => l.h < 24),
						);
					assert.deepEqual(small, [], view);
				}
			},
			{ width: 390 },
		);
	});

	test(`AC:TARGET-PPL-001 BUG-132-view-switch (${name}): list to cards to list sends nothing; the pipeline loads once`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people?retired=include`);
			await page.getByRole("button", { name: "Next page", exact: true }).click();
			await page.waitForFunction(() => new URLSearchParams(location.search).get("page") === "2", null, {
				timeout: 30_000,
			});
			await page
				.getByRole("main")
				.getByText(/^Showing 25/)
				.waitFor();
			await page.waitForLoadState("networkidle");
			// Only a production build prefetches links, so only it can show a request per person link a switch reveals
			// (verifier finding on 87e1a8e). The development build shows Next.js's dev indicator.
			assert.equal(await page.locator("nextjs-portal").count(), 0, "Run this test on a production preview.");
			await page.waitForTimeout(1500);
			const sent = [];
			page.on("request", (r) => {
				if (["document", "fetch", "xhr"].includes(r.resourceType())) sent.push(`${r.method()} ${r.url()}`);
			});
			const view = (label) => page.getByRole("radio", { name: label }).click();
			const settled = () => page.waitForTimeout(800);
			const address = () => new URL(page.url()).searchParams;

			await view("Cards");
			await page.getByRole("list", { name: "People" }).waitFor();
			await settled();
			assert.equal(address().get("view"), "card");
			assert.equal(address().get("page"), "2", "cards keep the page");
			await page
				.getByRole("main")
				.getByText(/^Showing 25/)
				.waitFor();
			await view("List");
			await page.getByRole("table", { name: "People" }).waitFor();
			await settled();
			assert.equal(address().get("view"), null);
			assert.deepEqual(sent, [], "list and cards switch without a request");

			await view("Pipeline");
			await page.getByRole("region", { name: "Pipeline" }).waitFor();
			await settled();
			assert.equal(address().get("view"), "pipeline");
			assert.equal(sent.length, 1, `the first pipeline view is one request: ${sent.join(", ")}`);
			await view("List");
			await page
				.getByRole("main")
				.getByText(/^Showing 25/)
				.waitFor();
			assert.equal(address().get("page"), "2", "back to the same page");
			await view("Pipeline");
			await page.getByRole("region", { name: "Pipeline" }).waitFor();
			await settled();
			assert.equal(sent.length, 1, `returning to the pipeline sends nothing: ${sent.join(", ")}`);
			// The view is in the address: a reload opens the pipeline.
			await page.reload();
			await page.getByRole("region", { name: "Pipeline" }).waitFor();
		});
	});

	test(`AC:TARGET-PPL-001 BUG-132-pager-visible (${name}): the pager is in the first viewport on desktop and phone`, async () => {
		for (const [width, height] of [
			[1440, 900],
			[390, 844],
		])
			await withPage(
				engine,
				"owner",
				async (page) => {
					for (const view of ["", "&view=card"]) {
						await page.goto(`${BASE}/people?retired=include${view}`);
						const next = page.getByRole("button", { name: "Next page", exact: true });
						await next.waitFor();
						const box = await next.boundingBox();
						assert.ok(box && box.y >= 0 && box.y + box.height <= height, `${width}x${height}${view}: ${box?.y}`);
						await next.click();
						await page
							.getByRole("main")
							.getByText(/^Showing 25/)
							.waitFor();
					}
				},
				{ width, height },
			);
	});

	test(`AC:TARGET-PPL-007 D68-one-request (${name}): a move sends one POST and no GET, and the card moves before the answer`, async () => {
		// Desktop and phone: on a phone the board scrolls sideways, and a move must still send no prefetch (verifier
		// finding on 52980ca: a profile GET after a stage move at 390 px).
		for (const width of [1440, 390])
			await withPage(
				engine,
				"owner",
				async (page) => {
					await page.goto(`${BASE}/people?view=pipeline`);
					const column = (label) => page.getByRole("list", { name: label });
					const names = (label) =>
						column(label)
							.getByRole("article")
							.evaluateAll((a) => a.map((x) => x.getAttribute("aria-label")));
					await column("Following up people").waitFor();
					await page.waitForLoadState("networkidle");
					await page.waitForTimeout(1000);
					const sent = [];
					const ms = [];
					page.on("request", (r) => {
						if (["document", "fetch", "xhr"].includes(r.resourceType())) sent.push(r.method());
					});
					// While `hold` is set, a server action's answer waits for it, so the test sees the card move before the answer.
					let hold = null;
					await page.route("**/*", async (route) => {
						const r = route.request();
						if (r.method() !== "POST" || !r.headers()["next-action"]) return route.fallback();
						const held = hold;
						const start = performance.now();
						const response = await route.fetch();
						if (held) ms.push(Math.round(performance.now() - start));
						await held?.wait;
						return route.fulfill({ response });
					});
					const held = () => {
						let release;
						hold = { wait: new Promise((r) => (release = r)) };
						return () => {
							hold = null;
							release();
						};
					};
					const settle = () => page.waitForTimeout(1500);

					// Reorder inside a column.
					const [, second] = await names("Following up people");
					let release = held();
					sent.length = 0;
					await page.getByRole("button", { name: `Move ${second}` }).click();
					await page.getByRole("menuitem", { name: "Move up" }).click();
					await page.waitForFunction(
						(n) =>
							document
								.querySelector('[aria-label="Following up people"]:not([hidden] *) article')
								?.getAttribute("aria-label") === n,
						second,
						{ timeout: 5_000 },
					);
					release();
					await page.getByText(`${second} moved up.`).waitFor({ state: "attached", timeout: 30_000 });
					await settle();
					assert.deepEqual(sent, ["POST"], "a reorder is one POST and no GET");

					// Change stage there and back: each move is one POST once the dialog's warnings are loaded.
					const stageMove = async (person, stage, from, to) => {
						await page.getByRole("button", { name: `Move ${person}` }).click();
						await page.getByRole("menuitem", { name: stage }).click();
						const dialog = page.getByRole("dialog");
						const save = dialog.getByRole("button", { name: `Move to ${stage.toLowerCase()}` });
						await dialog.getByLabel("Reason").fill("Checking one request per move");
						await page.waitForFunction(
							(label) => {
								const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent === label);
								return b && !b.disabled;
							},
							`Move to ${stage.toLowerCase()}`,
							{ timeout: 30_000 },
						);
						await page.waitForTimeout(500);
						release = held();
						sent.length = 0;
						await save.click();
						// The dialog hides the board from the accessibility tree while it is open, so read the DOM directly.
						const inList = (label, n) =>
							page.evaluate(
								([l, n]) =>
									[...document.querySelectorAll(`[aria-label="${l}"]:not([hidden] *) article`)].some(
										(a) => a.getAttribute("aria-label") === n,
									),
								[label, n],
							);
						await page.waitForFunction(
							([l, n]) =>
								[...document.querySelectorAll(`[aria-label="${l}"]:not([hidden] *) article`)].some(
									(a) => a.getAttribute("aria-label") === n,
								),
							[to, person],
							{ timeout: 5_000 },
						);
						assert.equal(await inList(from, person), false, `${person} left ${from}`);
						release();
						await dialog.waitFor({ state: "detached", timeout: 30_000 });
						await settle();
						assert.deepEqual(sent, ["POST"], `moving ${person} to ${stage} is one POST and no GET`);
					};
					// Verifier sequence on #145: reorder, away, back, away again. Each move must save; none may be refused as
					// "changed while you were working", because this page made every change.
					await stageMove(second, "Attendee", "Following up people", "Attendee people");
					await stageMove(second, "Following up", "Attendee people", "Following up people");
					await stageMove(second, "Attendee", "Following up people", "Attendee people");
					// The page shows the saved order: a reload shows the same columns.
					const shown = [await names("Following up people"), await names("Attendee people")];
					await page.reload();
					await column("Following up people").waitFor();
					assert.deepEqual([await names("Following up people"), await names("Attendee people")], shown);
					// Put the person back for the other tests.
					await page.waitForLoadState("networkidle");
					await stageMove(second, "Following up", "Attendee people", "Following up people");
					console.log(`D68 ${name} ${width}px move answer times (ms): ${ms.join(", ")}`);
				},
				{ width },
			);
	});

	test(`AC:TARGET-PPL-008 UI-round-no-reload (${name}): each person change is one POST, no page request, and Activity shows it`, async () => {
		await withPage(engine, "owner", async (page) => {
			await addPerson(page, unique(name));
			await page.waitForLoadState("networkidle");
			const sent = [];
			page.on("request", (r) => {
				if (!["document", "fetch", "xhr"].includes(r.resourceType())) return;
				sent.push(r.headers()["next-action"] ? `${r.method()} action` : `${r.method()} ${new URL(r.url()).pathname}`);
			});
			const activity = page.getByRole("list", { name: "Activity, newest first" });
			/** Runs one change and checks it sent exactly one server action and that Activity shows `entry`. */
			const one = async (what, change, entry) => {
				sent.length = 0;
				await change();
				await activity.getByText(entry, { exact: true }).waitFor({ timeout: 30_000 });
				await page.waitForTimeout(1000);
				assert.deepEqual(sent, ["POST action"], `${what}: one request, no page reload`);
			};

			const note = `Met at the park ${Date.now().toString(36)}`;
			await one(
				"a note",
				async () => {
					await page.getByLabel(/^Add a note about/).fill(note);
					await page.getByRole("button", { name: "Save note" }).click();
				},
				note,
			);

			await page.getByRole("button", { name: "Edit profile" }).first().click();
			const profile = page.getByRole("dialog", { name: "Edit profile" });
			await profile.getByLabel("Phone").fill("512-555-0101");
			await one(
				"a profile edit",
				() => profile.getByRole("button", { name: "Save changes" }).click(),
				"Details changed",
			);

			// The stage dialog reads its warnings when it opens; the move itself is one request once they are shown.
			await page.getByRole("button", { name: "Change stage" }).click();
			const stage = page.getByRole("dialog");
			await stage.getByLabel("New stage").click();
			await page.getByRole("option", { name: "Attendee" }).click();
			await stage.getByLabel("Reason").fill("Came to the Sunday gathering");
			const move = stage.getByRole("button", { name: "Move to attendee" });
			await page.waitForFunction((b) => b && !b.disabled, await move.elementHandle(), { timeout: 30_000 });
			await one("a stage change", () => move.click(), "Stage changed from prospect to attendee");
			assert.equal(await page.getByText(note, { exact: true }).count(), 1, "earlier entries stay");

			// Retire reads open duties when it opens; its own save must not read them again (found by the request log).
			await page.getByRole("button", { name: "More actions" }).click();
			await page.getByRole("menuitem", { name: "Retire person" }).click();
			const retire = page.getByRole("dialog");
			await retire.getByLabel("Reason").fill("Moved away");
			const confirm = retire.getByRole("button", { name: "Retire person" });
			await page.waitForFunction((b) => b && !b.disabled, await confirm.elementHandle(), { timeout: 30_000 });
			await one("a retire", () => confirm.click(), "Retired");
		});
	});

	// WebKit's request interception cannot replay a multipart file body, so the lost reply is simulated in Chromium only.
	test(
		`AC:TARGET-PPL-018 INV-lost-reply (${name}): an import whose reply is lost reads its receipt and never sends twice`,
		{ skip: name !== "chromium" && "WebKit cannot replay the multipart body" },
		async () => {
			await withPage(engine, "owner", async (page, context) => {
				const tag = `${name}${Date.now().toString(36)}`;
				const csv =
					"\ufefffirst_name,last_name,email,notes\r\n" +
					`Mara,${tag},mara-${tag}@example.test,"First line\r\nSecond line"\r\n` +
					`Lia,${tag},lia-${tag}@example.test,=1+1\r\n` +
					`Lee,${tag},lee@,\r\n`;
				let posts = 0;
				// The server saves the import; the browser never sees the answer.
				await context.route("**/api/people/import", async (route) => {
					if (route.request().method() !== "POST") return route.fallback();
					posts++;
					await route.fetch({ postData: route.request().postDataBuffer() });
					await route.abort("failed");
				});
				await page.goto(`${BASE}/people/import`);
				await page
					.locator("input[type=file]")
					.setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
				await page.getByRole("heading", { name: "Rows to check" }).waitFor({ timeout: 30_000 });
				await page.getByRole("button", { name: "Import 2 people" }).click();
				await page.getByRole("heading", { name: "2 people added" }).waitFor({ timeout: 60_000 });
				assert.equal(posts, 1, "a lost reply is checked through the receipt, not sent again");
				assert.match(page.url(), /\/people\/import\?import=[0-9a-f-]{36}$/);
				const failed = page.getByRole("list", { name: "Rows not imported" });
				assert.equal(await failed.getByRole("listitem").count(), 1);
				assert.match(await failed.innerText(), /Email is not a complete address/);
				// A reload of the same address shows the same receipt and starts nothing.
				await page.reload();
				await page.getByRole("heading", { name: "2 people added" }).waitFor({ timeout: 30_000 });
				assert.equal(posts, 1);
			});
		},
	);

	test(`AC:TARGET-PPL-018 BUG-198-focus (${name}): a refused import moves focus to the alert, not the step heading`, async () => {
		await withPage(engine, "owner", async (page, context) => {
			await context.route("**/api/people/import", (route) =>
				route.request().method() === "POST"
					? route.fulfill({ json: { status: "refused", code: "review_stale" } })
					: route.fallback(),
			);
			const tag = `${name}${Date.now().toString(36)}`;
			await page.goto(`${BASE}/people/import`);
			await page.locator("input[type=file]").setInputFiles({
				name: "people.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(`first_name,email\r\nZed,zed-${tag}@example.test\r\n`),
			});
			await page.getByRole("button", { name: "Import 1 person" }).click({ timeout: 30_000 });
			await page.locator("[data-import-problem]").waitFor();
			await page.waitForTimeout(500);
			assert.match(
				await page.evaluate(() => document.activeElement?.textContent ?? ""),
				/^People changed since you checked this file/,
			);
		});
	});

	test(`AC:TARGET-PPL-018 BUG-198-unconfirmed (${name}): an unconfirmed import never claims nothing was saved and sends nothing again`, async () => {
		await withPage(engine, "owner", async (page, context) => {
			let posts = 0;
			// The import never reaches the server; the receipt then answers "unavailable", which also covers a seat that
			// lost access, so the screen must not say whether rows were saved or offer to send it again (ruling C34).
			await context.route("**/api/people/import", (route) =>
				route.request().method() === "POST" && ++posts ? route.abort("failed") : route.fallback(),
			);
			const tag = `${name}${Date.now().toString(36)}`;
			await page.goto(`${BASE}/people/import`);
			await page.locator("input[type=file]").setInputFiles({
				name: "people.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(`first_name,email\r\nUma,uma-${tag}@example.test\r\n`),
			});
			await page.getByRole("button", { name: "Import 1 person" }).click({ timeout: 30_000 });
			await page.getByRole("heading", { name: "We cannot show this import" }).waitFor({ timeout: 30_000 });
			assert.equal(await page.getByText("Nothing was saved").count(), 0);
			assert.equal(await page.getByRole("button", { name: /again/i }).count(), 0);
			assert.equal(await page.getByRole("link", { name: "Go to People" }).count(), 1);
			assert.equal(posts, 1);
		});
	});

	test(`AC:TARGET-PPL-019 INV-filters (${name}): a Member's export holds exactly the people the filtered directory counts`, async () => {
		await withPage(engine, "member", async (page) => {
			await page.goto(`${BASE}/people?stage=prospect`);
			const shown = Number(
				(await page.getByText(/^Showing .* of \d+ (people|person)$/).innerText()).match(/of (\d+)/)[1],
			);
			await page.getByRole("button", { name: "Export CSV" }).click();
			const dialog = page.getByRole("dialog", { name: "Export people" });
			assert.match(await dialog.innerText(), /Stage: Prospect/);
			const download = page.waitForEvent("download");
			await dialog.getByRole("button", { name: "Download CSV" }).click();
			await dialog.getByText(`has ${shown} ${shown === 1 ? "person" : "people"}.`).waitFor({ timeout: 30_000 });
			const text = (await (await download).createReadStream()).toArray();
			const lines = Buffer.concat(await text)
				.toString("utf8")
				.split("\r\n")
				.filter((l) => /^[^,]*,[^,]*,/.test(l));
			assert.ok(lines[0].startsWith("\ufefffirst_name,last_name,email"));
			assert.equal(lines.filter((l) => l.includes(",prospect,")).length, shown, "every exported row is a prospect");
		});
	});

	test(`AC:TARGET-PPL-009 F10-create (${name}): with no households, Add to a household leads to creating one, with no reload`, async () => {
		const mine = seed().empty[name];
		await onPreview(engine, async (page, context) => {
			await signIn(context, mine.cookie);
			const posts = [];
			const documents = [];
			await onActions(context, (route) => (posts.push(route.request().postData() ?? ""), route.fallback()));
			await page.goto(`${BASE}/people/${mine.person}`);
			await page.getByRole("heading", { level: 1, name: "Pia Rivera" }).waitFor({ timeout: 30_000 });
			await page.getByRole("button", { name: "Add to a household", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Add Pia to a household" });
			await dialog.getByText("No households yet", { exact: true }).waitFor({ timeout: 30_000 });
			assert.equal(await dialog.getByText("Choose a household.").count(), 0);
			// The footer action opens the create form; it never submits a join.
			const before = posts.length;
			await dialog.getByRole("button", { name: "Create household", exact: true }).last().click();
			const create = page.getByRole("dialog", { name: "Create a household" });
			await create.getByLabel("Household name").waitFor();
			assert.equal(await create.getByLabel("Household name").inputValue(), "Rivera household");
			assert.equal(await create.getByText("Choose a role.").count(), 0);
			assert.equal((await create.getByText(/will be the head/).count()) > 0, true);
			assert.equal(await create.getByLabel(/^Street/).count(), 1);
			assert.equal(await page.getByRole("dialog").count(), 1, "one dialog, not two");
			assert.equal((await focused(page)).tag, "INPUT", "focus moves to the household name");
			// An empty name refuses and sends nothing.
			await create.getByLabel("Household name").fill("");
			await create.getByRole("button", { name: "Create household", exact: true }).click();
			await create.getByText("Name the household, such as Santos household.").waitFor();
			assert.equal(posts.slice(before).filter((b) => b.includes("headPersonId")).length, 0);
			// Back to the empty state, then create from the button in the list area.
			await create.getByRole("button", { name: "Back to the list", exact: true }).click();
			await dialog.getByText("No households yet", { exact: true }).waitFor();
			assert.equal(await dialog.getByText("Choose a household.").count(), 0);
			assert.equal(await dialog.getByText("Choose a role.").count(), 0);
			await dialog.getByRole("button", { name: "Create household", exact: true }).first().click();
			await create.getByLabel("Household name").waitFor();
			// The form keeps what was typed while the person looked at the list: the emptied name stays empty.
			assert.equal(await create.getByLabel("Household name").inputValue(), "");
			await create.getByLabel("Household name").fill("Rivera household");
			page.on("request", (r) => r.isNavigationRequest() && documents.push(r.url()));
			await create.getByRole("button", { name: "Create household", exact: true }).click();
			await create.waitFor({ state: "detached" });
			const members = page.getByRole("list", { name: "Members of Rivera household" });
			await members.waitFor({ timeout: 30_000 });
			await members.getByText("Head", { exact: true }).waitFor();
			await page.getByText("Saving…").waitFor({ state: "detached", timeout: 30_000 });
			assert.equal(posts.filter((b) => b.includes("headPersonId")).length, 1, "one startHousehold POST");
			assert.equal(posts.filter((b) => b.includes('"role"')).length, 0, "no second write sets a role");
			assert.deepEqual(documents, [], "no navigation or document request");
			// Leave the church with no households for the next run.
			await page.getByRole("button", { name: "Household actions", exact: true }).click();
			await page.getByRole("menuitem", { name: /^Take .* out$/ }).click();
			const leave = page.getByRole("dialog");
			await leave.getByRole("button", { name: "Take out of household", exact: true }).click();
			await leave.waitFor({ state: "detached" });
			await page.getByText("Pia is not in a household.").waitFor({ timeout: 30_000 });
			// The card shows the leave at once; wait for the answer so the write lands before the browser closes.
			await page.getByText("Saving…").waitFor({ state: "detached", timeout: 30_000 });
		});
	});

	test(`AC:TARGET-PPL-009 F10-choose (${name}): with households, an early press asks for a choice, then a chosen household takes the person`, async () => {
		await withPage(engine, "owner", async (page, context) => {
			const hh = unique(name);
			const posts = [];
			await onActions(context, (route) => (posts.push(route.request().postData() ?? ""), route.fallback()));
			// A household of its own: another person starts it.
			const startUrl = await addPerson(page, unique(name));
			await page
				.getByRole("button", { name: /^Start a household/ })
				.first()
				.click();
			const start = page.getByRole("dialog");
			await start.getByLabel("Household name").fill(hh);
			await start.getByRole("button", { name: "Start household", exact: true }).click();
			await start.waitFor({ state: "detached" });
			await page.getByRole("list", { name: `Members of ${hh}` }).waitFor({ timeout: 30_000 });
			await page.getByText("Saving…").waitFor({ state: "detached", timeout: 30_000 });

			const joinerUrl = await addPerson(page, unique(name));
			await page.getByRole("button", { name: "Add to a household", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: /^Add .* to a household$/ });
			await dialog.getByLabel("Search households").fill(hh);
			await dialog.getByRole("radio", { name: new RegExp(hh) }).waitFor({ timeout: 30_000 });
			assert.equal(await dialog.getByText("Choose a household.").count(), 0, "no error on open");
			assert.equal(await dialog.getByText("Choose a role.").count(), 0, "no error on open");
			assert.equal(await dialog.getByRole("button", { name: "Create a new household", exact: true }).count(), 1);
			await dialog.getByRole("button", { name: "Add to household", exact: true }).click();
			await dialog.getByText("Choose a household.").waitFor();
			await dialog.getByText("Choose a role.").waitFor();
			const writes = () => posts.filter((b) => b.includes("personId")).length;
			assert.equal(writes(), 0);
			await dialog.getByRole("radio", { name: new RegExp(hh) }).click();
			await dialog.getByRole("combobox", { name: /role/ }).click();
			await page.getByRole("option", { name: "Spouse", exact: true }).click();
			await dialog.getByRole("button", { name: "Add to household", exact: true }).click();
			await dialog.waitFor({ state: "detached" });
			await page.getByRole("list", { name: `Members of ${hh}` }).waitFor({ timeout: 30_000 });
			await page.getByText("Saving…").waitFor({ state: "detached", timeout: 30_000 });
			assert.equal(writes(), 1, "one joinHousehold POST");
			assert.equal(
				await page
					.getByRole("list", { name: `Members of ${hh}` })
					.getByText("Spouse", { exact: true })
					.count(),
				1,
			);

			// Clean up: the joiner leaves, then the starter leaves and the empty household goes with them.
			for (const url of [joinerUrl, startUrl]) {
				await page.goto(url);
				await page.getByRole("button", { name: "Household actions", exact: true }).click();
				await page.getByRole("menuitem", { name: /^Take .* out$/ }).click();
				const leave = page.getByRole("dialog");
				await leave.getByRole("button", { name: "Take out of household", exact: true }).click();
				await leave.waitFor({ state: "detached" });
				await page.getByText(/is not in a household\./).waitFor({ timeout: 30_000 });
			}
		});
	});
}
