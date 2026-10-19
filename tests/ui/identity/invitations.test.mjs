// Invitation acceptance (WP-008/ui) against the real WP-008 invitation service on a seeded preview. Each test fails when
// its guard is removed. Seed the preview first with tests/ui/identity/invitation-seed.mts (it writes the fixture this
// file reads from INVITATION_UI_FIXTURE, default /tmp/everyfield-invitation-ui.json):
//   UI_BASE_URL=https://wp-008-ui-....localhost:1355 node --test tests/ui/identity/invitations.test.mjs
//   INV-proof-hidden: the emailed proof is in the fragment and leaves the address bar as soon as the page opens.
//   INV-retry-same-key: the reply to Accept is lost after the server committed it; after a reload the page resends the
//     same command, and the person has exactly one seat (REQ-IDN-017, REQ-IDN-030).
//   BUG-99d7882: a second link in the same tab is a fragment change only; the page follows it (verifier finding).
//   INV-chosen-sharing: a resident accepts with exactly the sharing they ticked in ResidencyDisclosure, unticked by
//     default, and gets no seat (REQ-MUL-004, ruling D51).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const FIXTURE = process.env.INVITATION_UI_FIXTURE ?? "/tmp/everyfield-invitation-ui.json";
const skip = !BASE || !existsSync(FIXTURE) ? "Seed a preview and set UI_BASE_URL (see the header)." : false;
const seed = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

async function withPage(engine, run) {
	const browser = await engine.launch();
	try {
		// Portless previews use a local certificate the test browsers do not know.
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			reducedMotion: "reduce",
			ignoreHTTPSErrors: true,
		});
		await run(await context.newPage());
	} finally {
		await browser.close();
	}
}

async function signIn(page, email, submit) {
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(seed().password);
	await page.getByRole("button", { name: submit }).click();
}

for (const [name, engine] of ENGINES) {
	describe(`invitation acceptance (${name})`, { skip }, () => {
		// Runs first: it only views both links, while the tests after it use them up.
		test("BUG-99d7882: another invitation link opened in the same tab shows that invitation and cleans the address", async () => {
			const { member, resident } = seed().flows[name];
			await withPage(engine, async (page) => {
				await page.goto(member.link);
				await page.getByRole("heading", { name: "Join Harvest Point" }).waitFor();
				// Only the fragment changes, so the browser does not load the page again.
				await page.goto(resident.link);
				await page.getByRole("heading", { name: "Link your account to Grace Church" }).waitFor();
				assert.equal(await page.getByRole("heading", { name: "Join Harvest Point" }).count(), 0);
				await page.waitForFunction(() => window.location.hash === "");
			});
		});

		test("AC:TARGET-IDN-017 AC:TARGET-IDN-030 INV-proof-hidden INV-retry-same-key: a lost Accept reply leaves one seat", async () => {
			const { name: person, email, link } = seed().flows[name].member;
			await withPage(engine, async (page) => {
				await page.goto(link);
				await page.getByRole("heading", { name: "Join Harvest Point" }).waitFor();
				// The proof arrives in the fragment and leaves the address at once; no request ever carried it.
				assert.equal(new URL(page.url()).hash, "");
				assert.equal(new URL(page.url()).search, "");
				await page.getByRole("button", { name: "Sign in to accept" }).click();
				await signIn(page, email, "Sign in and join");
				const accept = page.getByRole("button", { name: "Accept and join" });
				await accept.waitFor();

				// The server commits the claim, and the answer never reaches the page.
				let dropped = 0;
				await page.route("**/api/invitation", async (route) => {
					const request = route.request();
					if (request.method() === "POST" && dropped === 0) {
						const body = request.postData() ?? "";
						if (body.includes('"accept_seat"')) {
							dropped++;
							await route.fetch();
							return route.abort("failed");
						}
					}
					return route.continue();
				});
				await accept.click();
				await page.getByRole("heading", { name: "We could not confirm your answer" }).waitFor();
				await page.unroute("**/api/invitation");
				assert.equal(dropped, 1);

				// A reload keeps the unconfirmed answer; Try again sends the same command and gets the saved result.
				await page.reload();
				await page.getByRole("heading", { name: "We could not confirm your answer" }).waitFor();
				await page.getByRole("button", { name: "Try again" }).click();
				await page.getByRole("heading", { name: "You joined Harvest Point" }).waitFor();

				await page.goto(BASE + "/settings/seats");
				const roster = page.getByRole("region", { name: "Seats" });
				await roster.getByText("(you)").waitFor();
				assert.equal(await roster.getByText(person).count(), 1);

				await page.goto(link);
				await page.getByRole("heading", { name: "This page is not available" }).waitFor();
			});
		});

		test("AC:ADR1-004 AC:TARGET-IDN-020 INV-chosen-sharing: a resident links with exactly the ticked sharing and no seat", async () => {
			const { email, link } = seed().flows[name].resident;
			await withPage(engine, async (page) => {
				await page.goto(link);
				await page.getByRole("button", { name: "Sign in to answer" }).click();
				await signIn(page, email, "Sign in and continue");
				await page.getByRole("heading", { name: "Join the residency at Grace Church" }).waitFor();
				const foundations = page.getByRole("checkbox", { name: "Share foundation progress" });
				const milestones = page.getByRole("checkbox", { name: "Share milestone progress" });
				assert.equal(await foundations.isChecked(), false);
				assert.equal(await milestones.isChecked(), false);
				await milestones.check();
				await page.getByRole("button", { name: "Accept and join" }).click();
				await page.getByRole("heading", { name: "You joined the residency at Grace Church" }).waitFor();
				await page.getByText("You share your milestone progress.").waitFor();

				await page.goto(BASE + "/settings/sharing");
				const share = (what) => page.getByRole("switch", { name: `Share ${what} progress with Grace Church` });
				await share("milestone").waitFor();
				assert.equal(await share("milestone").getAttribute("aria-checked"), "true");
				assert.equal(await share("foundation").getAttribute("aria-checked"), "false");

				await page.goto(BASE + "/settings/seats");
				await page.getByRole("heading", { name: "This page is not available" }).waitFor();
			});
		});
	});
}
