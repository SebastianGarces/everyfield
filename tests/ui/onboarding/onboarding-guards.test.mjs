// Onboarding guards that a silent break would turn into a second church, an invented phase or lost answers
// (WP-009/ui). They run on the design preview's fixture API (/design/onboarding). Each row fails when its guard goes:
//   AC:TARGET-IDN-013 INV-create-once: a double Create church sends one creation; afterwards Your church is a summary
//     with no basics form, also through the step pills and browser Back (BasicsForm busy, clampView, ChurchSummary).
//   AC:TARGET-IDN-013 INV-basics-required: no name or no confirmation sends nothing and focuses the problem.
//   AC:TARGET-IDN-015 INV-unsure-not-zero: Not sure yet saves {answer: unsure} with no phase and Phase 1 stays.
//   AC:TARGET-IDN-015 INV-journey-one-save: the phase and the launch answer save in one request, on Launch date.
//   AC:TARGET-IDN-015 INV-declared-once: after an existing-phase declaration both steps are read-only and send nothing.
//   AC:TARGET-IDN-015 INV-back-drafts: an unsaved phase choice survives Back, the pills and browser Back; Launch date
//     without a phase answer opens Where you are, because the two save together.
//   AC:TARGET-IDN-015 INV-retry-key: a retry after a temporary failure reuses the request key; a conflict reloads
//     the facts, says so and keeps the draft.
//   AC:TARGET-IDN-014 INV-lead-disclosure: Yes shows the role and team it creates; once saved, Yes is read-only.
//   AC:TARGET-IDN-015 INV-finish-once: a double Finish sends one completion; missing facts stay listed after it.
//   AC:TARGET-IDN-016 INV-convert-chosen: conversion sends only the ticked relationship with its current choices.
//   AC:TARGET-IDN-016 INV-start-offer: a pending planter sees no Discovery option, a pending Discovery account no
//     church form, and an active seatless account must choose (D42).
//   INV-step-focus: moving to a step puts focus on its heading.
// It runs against a running app: set UI_BASE_URL to the task preview.
//   UI_BASE_URL=http://wp-009-ui-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const PREVIEW = "/design/onboarding";
const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

for (const [name, engine] of ENGINES) {
	describe(`onboarding guards (${name})`, () => {
		let browser;
		before(async () => {
			assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
			browser = await engine.launch();
		});
		after(async () => {
			await browser?.close();
		});

		async function open(query, run) {
			const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
			try {
				const page = await context.newPage();
				await page.goto(`${BASE}${PREVIEW}?${query}`);
				await page.getByRole("heading", { level: 1 }).waitFor();
				await page.waitForFunction(() => Boolean(window.__onboardingFixture));
				await run(page);
			} finally {
				await context.close();
			}
		}
		const calls = (page, op) =>
			page.evaluate((op) => window.__onboardingFixture.calls.filter((c) => !op || c.op === op), op);
		const heading = (page) => page.getByRole("heading", { level: 1 });
		const button = (page, label) => page.getByRole("button", { name: label, exact: true });
		const idle = (page, label) =>
			page.waitForFunction((label) => {
				const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === label);
				return b && b.getAttribute("aria-busy") !== "true";
			}, label);

		async function createChurch(page) {
			await page.getByRole("textbox", { name: "Church name" }).fill("  Harvest Point  ");
			await page.getByRole("textbox", { name: "City" }).fill("Boston");
			await page.getByRole("checkbox", { name: "I’m setting up this church myself" }).click();
		}

		test("AC:TARGET-IDN-013 INV-create-once: one creation, then basics never come back", { timeout: 60_000 }, () =>
			open("as=planter&delay=600", async (page) => {
				await createChurch(page);
				await button(page, "Create church").dblclick();
				await button(page, "Create church")
					.click({ force: true })
					.catch(() => {});
				await heading(page).filter({ hasText: "Harvest Point is set up" }).waitFor();
				assert.equal((await calls(page, "createPlant")).length, 1, "one creation request");
				const sent = (await calls(page, "createPlant"))[0].command;
				assert.deepEqual(sent.input, {
					name: "Harvest Point",
					locality: { city: "Boston", stateProvince: null, country: null },
					confirmed: true,
				});

				await button(page, "Continue").click();
				await heading(page).filter({ hasText: "Where is Harvest Point today?" }).waitFor();
				await page.getByRole("button", { name: /Your church/ }).click();
				await heading(page).filter({ hasText: "is set up" }).waitFor();
				assert.equal(
					await page.getByRole("textbox", { name: "Church name" }).count(),
					0,
					"no basics form after creation",
				);
				await page.goBack();
				await page.goBack();
				await heading(page).waitFor();
				assert.equal(await page.getByRole("textbox", { name: "Church name" }).count(), 0, "browser Back shows no form");
				assert.equal((await calls(page, "createPlant")).length, 1);
			}),
		);

		test(
			"AC:TARGET-IDN-013 INV-basics-required: nothing is sent without a name and confirmation",
			{ timeout: 60_000 },
			() =>
				open("as=planter&delay=100", async (page) => {
					await button(page, "Create church").click();
					await page.getByText("Enter your church’s name.").waitFor();
					assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "name");
					await page.getByRole("textbox", { name: "Church name" }).fill("Harvest Point");
					await button(page, "Create church").click();
					await page.getByText("Confirm that you are setting up this church yourself.").waitFor();
					assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "checkbox");
					assert.equal((await calls(page)).length, 0, "no request");
				}),
		);

		test("AC:TARGET-IDN-015 INV-unsure-not-zero and INV-journey-one-save", { timeout: 60_000 }, () =>
			open("as=planter&delay=100", async (page) => {
				await createChurch(page);
				await button(page, "Create church").click();
				await button(page, "Continue").click();
				await page.getByText("I’m not sure yet").click();
				await button(page, "Continue").click();
				await heading(page).filter({ hasText: "When do you plan to launch?" }).waitFor();
				assert.equal((await calls(page, "declareJourney")).length, 0, "the phase step alone sends nothing");
				await page.getByText("No date yet").click();
				await button(page, "Save and continue").click();
				await heading(page).filter({ hasText: "Will you lead" }).waitFor();
				const sent = await calls(page, "declareJourney");
				assert.equal(sent.length, 1, "one request for both answers");
				assert.deepEqual(sent[0].command.input, { journey: { answer: "unsure" }, launch: { answer: "no_date" } });
				await button(page, "Skip for now").click();
				await heading(page).filter({ hasText: "Ready to start?" }).waitFor();
				await page.getByText("Phase 1, Core group development").waitFor();
				await page.getByText("You weren’t sure yet. Nothing declared.").waitFor();
			}),
		);

		test("AC:TARGET-IDN-015 INV-declared-once: a declared phase is read-only", { timeout: 60_000 }, () =>
			open("as=declared&delay=100&step=journey", async (page) => {
				await page.getByText("You declared Phase 3, Training and preparation").waitFor();
				assert.equal(await page.getByRole("radio").count(), 0, "no phase choices");
				await button(page, "Continue").click();
				await page.getByText(/Launch date: /).waitFor();
				assert.equal(await page.getByRole("radio").count(), 0, "no launch choices");
				await button(page, "Continue").click();
				await heading(page).filter({ hasText: "Will you lead" }).waitFor();
				assert.equal((await calls(page, "declareJourney")).length, 0, "nothing sent");
			}),
		);

		test("AC:TARGET-IDN-015 INV-back-drafts: Launch date needs a phase answer first", { timeout: 60_000 }, () =>
			open("as=created&delay=100&step=launch", async (page) => {
				await heading(page).filter({ hasText: "Where is Harvest Point today?" }).waitFor();
				await page.getByRole("button", { name: /Launch date/ }).click();
				await heading(page).filter({ hasText: "Where is Harvest Point today?" }).waitFor();
				assert.equal(await page.getByRole("button", { name: "Save and continue" }).count(), 0);
			}),
		);

		test("AC:TARGET-IDN-015 INV-back-drafts: an unsaved phase survives Back", { timeout: 60_000 }, () =>
			open("as=resume&delay=100&step=journey", async (page) => {
				await page.getByText("Training and preparation").click();
				await button(page, "Continue").click();
				await heading(page).filter({ hasText: "When do you plan to launch?" }).waitFor();
				await button(page, "Back").click();
				assert.equal(await page.getByRole("radio", { name: /Training and preparation/ }).isChecked(), true, "Back");
				await page.getByRole("button", { name: /Launch date/ }).click();
				await page.getByRole("button", { name: /Where you are/ }).click();
				assert.equal(await page.getByRole("radio", { name: /Training and preparation/ }).isChecked(), true, "pills");
				await page.getByRole("button", { name: /Launch date/ }).click();
				await page.goBack();
				await heading(page).filter({ hasText: "today?" }).waitFor();
				assert.equal(
					await page.getByRole("radio", { name: /Training and preparation/ }).isChecked(),
					true,
					"browser Back",
				);
				assert.equal((await calls(page)).length, 0);
			}),
		);

		test(
			"AC:TARGET-IDN-015 INV-retry-key: a retry reuses the key; a conflict reloads and keeps the draft",
			{ timeout: 60_000 },
			() =>
				open("as=resume&delay=100&step=journey&fail=declareJourney:temporary", async (page) => {
					await page.getByText("Launch team formation").click();
					await button(page, "Continue").click();
					await page.getByText("No date yet").click();
					await button(page, "Save and continue").click();
					await page.getByText("We couldn’t save just now. Try again in a moment.").waitFor();
					await idle(page, "Save and continue");
					await button(page, "Save and continue").click();
					await heading(page).filter({ hasText: "Will you lead" }).waitFor();
					const sent = await calls(page, "declareJourney");
					assert.equal(sent.length, 2);
					assert.equal(sent[0].requestKey, sent[1].requestKey, "the retry replays the same intent");

					await page.evaluate(() => window.__onboardingFixture.bumpRevision());
					await page.getByText("No, someone else leads it").click();
					await button(page, "Save and continue").click();
					await page.getByText(/Something changed while you were on this step/).waitFor();
					assert.equal(
						await page.getByRole("radio", { name: /someone else leads it/ }).isChecked(),
						true,
						"draft kept",
					);
					await idle(page, "Save and continue");
					await button(page, "Save and continue").click();
					await heading(page).filter({ hasText: "Ready to start?" }).waitFor();
					const lead = await calls(page, "answerLead");
					assert.equal(lead.length, 2);
					assert.notEqual(
						lead[0].command.expectedRevision,
						lead[1].command.expectedRevision,
						"the second try uses the reloaded revision",
					);
				}),
		);

		test("AC:TARGET-IDN-014 INV-lead-disclosure: Yes shows what it creates and saves once", { timeout: 60_000 }, () =>
			open("as=resume&delay=100&step=team", async (page) => {
				await page.getByText("Yes, I lead it").click();
				await page.getByRole("textbox", { name: "Role" }).fill("Church planter");
				await page
					.getByText("We create the Church planter role in a new Leadership team and assign it to you.")
					.waitFor();
				await button(page, "Save and continue").click();
				await heading(page).filter({ hasText: "Ready to start?" }).waitFor();
				const sent = await calls(page, "answerLead");
				assert.deepEqual(sent[0].command.input, {
					answer: "yes",
					assignment: {
						kind: "minimal_role",
						roleName: "Church planter",
						container: { kind: "minimal", name: "Leadership" },
					},
				});
				await page.getByRole("button", { name: /Your team/ }).click();
				await page.getByText("You hold the lead role").first().waitFor();
				assert.equal(await page.getByRole("radio").count(), 0, "a saved Yes is read-only");
			}),
		);

		test("AC:TARGET-IDN-015 INV-finish-once: one completion; missing facts stay listed", { timeout: 60_000 }, () =>
			open("as=resume&delay=600&step=finish", async (page) => {
				await page.getByText("Still to do").waitFor();
				await button(page, "Finish setup").dblclick();
				await heading(page).filter({ hasText: "Setup is finished" }).waitFor();
				assert.equal((await calls(page, "complete")).length, 1);
				await page.getByText("Still to do").waitFor();
				await page.getByText("No lead role assigned.").waitFor();
				assert.equal(await button(page, "Finish setup").count(), 0);
			}),
		);

		test("AC:TARGET-IDN-016 INV-convert-chosen: only the ticked relationship moves", { timeout: 60_000 }, () =>
			open("as=discovery&delay=100", async (page) => {
				await page.getByText("2 of 6 read.", { exact: false }).waitFor();
				await button(page, "Start your church").click();
				await createChurch(page);
				await page.getByRole("checkbox", { name: "Sending church relationship" }).click();
				await button(page, "Create church").click();
				await heading(page).filter({ hasText: "Harvest Point is set up" }).waitFor();
				const [sent] = await calls(page, "convertDiscovery");
				assert.equal(sent.command.input.relationships.length, 1);
				assert.equal(sent.command.input.relationships[0].organization.organizationKind, "sending_church");
				assert.deepEqual(sent.command.input.relationships[0].choices, {
					people: true,
					meetings: true,
					tasks: false,
					ministry_teams: false,
					wiki: false,
					activity: false,
					shared_findings: false,
				});
			}),
		);

		test(
			"AC:TARGET-IDN-016 INV-start-offer: the registration choice decides while pending (D42)",
			{ timeout: 60_000 },
			async () => {
				await open("as=planter", async (page) => {
					await heading(page).filter({ hasText: "Start your church" }).waitFor();
					assert.equal(await page.getByText("Explore in Discovery").count(), 0);
				});
				await open("as=discovery-new", async (page) => {
					await heading(page).filter({ hasText: "Explore before you plant" }).waitFor();
					assert.equal(await page.getByRole("textbox", { name: "Church name" }).count(), 0);
				});
				await open("as=either&delay=100", async (page) => {
					await button(page, "Continue").click();
					await page.getByText("Choose how you want to start.").waitFor();
					await page.getByText("Explore in Discovery").click();
					await button(page, "Continue").click();
					await button(page, "Open Discovery").click();
					await heading(page)
						.filter({ hasText: /^Discovery$/ })
						.waitFor();
					assert.equal((await calls(page, "createDiscovery")).length, 1);
					assert.equal((await calls(page, "createPlant")).length, 0);
				});
			},
		);

		test("INV-step-focus: the new step's heading takes focus", { timeout: 60_000 }, () =>
			open("as=resume&delay=100&step=journey", async (page) => {
				await page.getByText("Pre-launch", { exact: true }).click();
				await button(page, "Continue").click();
				await heading(page).filter({ hasText: "When do you plan to launch?" }).waitFor();
				await page.waitForFunction(() => document.activeElement?.tagName === "H1");
			}),
		);
	});
}
