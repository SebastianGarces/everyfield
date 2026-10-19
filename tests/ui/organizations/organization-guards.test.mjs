// Organization relationship screens (WP-007/ui): the guards a silent break would turn into a privacy leak, a reset of
// saved sharing or a doubled relationship effect. Each row fails when its guard is removed.
//   INV-reason-withheld: a Member never reads why a connection ended; the row says the reason is not shown
//     (historyReason, REQ-IDN-021).
//   INV-prior-sharing: connecting again with an organization shows the saved per-organization choices, not the
//     all-on first-invitation default (SharingDisclosure, REQ-IDN-022 gate "prior sharing retained").
//   INV-disclosure-first: a plant cannot send an invitation until the disclosure for that organization has loaded;
//     a failed read disables Send and offers Try again (InviteDialog, REQ-IDN-022).
//   INV-retry-same-key: when the reply to Leave is lost after the server committed it, the reason locks and Try again
//     resends the same frozen command, so the person sees one ended connection with the first reason and no refusal.
//     The design fixture refuses a reused key with different input, as the API does (useIntent, REQ-IDN-021).
// The screens run on contract-parsed fixtures at /design/organizations. It runs against a running app: set UI_BASE_URL.
//   UI_BASE_URL=https://wp-007-ui-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const CONNECTIONS = "/design/organizations/connections";
const REASON = "We moved our residents to the Austin cohort.";

const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

for (const [name, engine] of ENGINES) {
	describe(`organization guards (${name})`, () => {
		let browser;
		before(async () => {
			assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
			browser = await engine.launch();
		});
		after(async () => {
			await browser?.close();
		});

		async function open(path, run) {
			const context = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				reducedMotion: "reduce",
				ignoreHTTPSErrors: true,
			});
			try {
				const page = await context.newPage();
				await page.goto(BASE + path);
				await page.getByRole("heading", { name: "History" }).waitFor();
				await run(page);
			} finally {
				await context.close();
			}
		}

		test("INV-reason-withheld: a Member sees that a reason exists but never its text", async () => {
			await open(`${CONNECTIONS}?as=owner`, async (page) => {
				await page.getByText(REASON).waitFor();
			});
			await open(`${CONNECTIONS}?as=member`, async (page) => {
				await page.getByText("Reason not shown to your role").waitFor();
				assert.equal(await page.getByText(REASON).count(), 0);
				assert.equal(await page.getByRole("button", { name: /^Leave / }).count(), 0);
			});
		});

		test("INV-prior-sharing: connecting again shows the saved choices; a new organization shows all on", () =>
			open(CONNECTIONS, async (page) => {
				await page.getByRole("button", { name: "Connect" }).click();
				const dialog = page.getByRole("dialog", { name: "Connect with an organization" });
				await dialog.getByRole("combobox", { name: "Organization" }).click();
				await page.getByRole("option", { name: "Hill Country Network · Sending network" }).click();
				const prior = dialog.getByRole("region", { name: "Your earlier choices for Hill Country Network come back" });
				await prior.waitFor();
				assert.equal(await prior.getByText("Not shared").count(), 4);
				assert.equal(await prior.getByText("Shared", { exact: true }).count(), 3);
				await dialog.getByRole("combobox", { name: "Organization" }).click();
				await page.getByRole("option", { name: "Cedar Creek Church · Sending church" }).click();
				const first = dialog.getByRole("region", { name: "What Cedar Creek Church can see once connected" });
				await first.waitFor();
				assert.equal(await first.getByText("Not shared").count(), 0);
				assert.equal(await first.getByText("Shared", { exact: true }).count(), 7);
			}));

		test("INV-disclosure-first: Send waits until the plant has seen what the organization will see", () =>
			open(`${CONNECTIONS}?scenario=refused`, async (page) => {
				await page.getByRole("button", { name: "Connect" }).click();
				const dialog = page.getByRole("dialog", { name: "Connect with an organization" });
				await dialog.getByRole("combobox", { name: "Organization" }).click();
				await page.getByRole("option", { name: "Cedar Creek Church · Sending church" }).click();
				await dialog.getByLabel("Their Owner or Admin's email").fill("pastor@cedar.example");
				await dialog.getByText("What Cedar Creek Church would see did not load.").waitFor();
				assert.equal(await dialog.getByRole("button", { name: "Send invitation" }).isDisabled(), true);
				await dialog.getByRole("button", { name: "Try again" }).click();
				await dialog.getByRole("region", { name: "What Cedar Creek Church can see once connected" }).waitFor();
				assert.equal(await dialog.getByRole("button", { name: "Send invitation" }).isDisabled(), false);
			}));

		test("INV-retry-same-key: a lost reply to Leave locks the reason and Try again resends that same command", () =>
			open(`${CONNECTIONS}?scenario=offline-once`, async (page) => {
				await page.getByRole("button", { name: "Leave Grace Fellowship" }).click();
				const dialog = page.getByRole("alertdialog", { name: "Leave Grace Fellowship?" });
				const reason = dialog.getByLabel(/Reason/);
				await reason.fill("First reason");
				await dialog.getByRole("button", { name: "Leave", exact: true }).click();
				await dialog.getByText("We could not confirm that this went through.").waitFor();
				await reason.click();
				await page.keyboard.type(" edited");
				assert.equal(await reason.inputValue(), "First reason");
				await dialog.getByRole("button", { name: "Try again" }).click();
				await page.getByRole("status").filter({ hasText: "The connection with Grace Fellowship ended." }).waitFor();
				await page.getByText("First reason", { exact: true }).waitFor();
				assert.equal(await page.getByText("Connection with Grace Fellowship ended", { exact: true }).count(), 1);
				assert.equal(await page.getByText("First reason", { exact: true }).count(), 1);
				assert.equal(await page.getByRole("button", { name: "Leave Grace Fellowship" }).count(), 0);
			}));
	});
}
