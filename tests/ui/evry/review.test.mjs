// The Evry review card's approval on a seeded preview (WP-053/ui), in both engines at phone width. It needs the People
// seed (tests/ui/people/seed.mts) and a preview started with EVRY_SCRIPTED_MODEL=1 in its apps/web/.env.local.
//   AC:UI45-002 AC:INH-REGRESSION-REVISED-APPROVAL INV-revise: revising a reviewed value makes revision 2, which is
//     the one approved and saved.
//   AC:INH-REGRESSION-CONFIRM-REPLAY INV-lost-approval: an approval whose reply is lost after the server saved it shows
//     as saved, never as "not approved"; the same request is sent once more and no more (C58), the person changed
//     once, and focus stays in the card.
//   AC:INH-REGRESSION-CONFIRM-REPLAY INV-unknown-approval: an update the server saved whose reply and read are lost
//     keeps the form and its values, offers only Check again, and Check again shows revision 2. Then an approval,
//     its replay and the read all get no answer: the card says it may already be saved and offers only Check again,
//     with Revise and Cancel disabled. The browser clock then passes the review's expiry: the card stays "Not
//     confirmed" and never says nothing changed. Check again sends the same request key and the change saves once.
//   AC:INH-REGRESSION-CONFIRM-REPLAY INV-approve-runs-once (real routes, no page): a first approval's own request runs
//     the change with no other request; a replay of it returns the saved review and saves nothing again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

for (const [engine, launcher] of ENGINES)
	test(`AC:UI45-002 AC:INH-REGRESSION-CONFIRM-REPLAY INV-lost-approval: a revised change saves once (${engine})`, () =>
		withPage(
			launcher,
			async (page, context) => {
				const people = fixture("people");
				await signIn(context, people.owner.cookie);
				const approvals = [];
				await context.route("**/api/evry/proposals/*/approve", async (route) => {
					approvals.push(route.request().postData());
					// The server saves the approval; the browser never hears back.
					await route.fetch();
					await route.abort("connectionreset");
				});
				await page.goto(`${BASE}/people`);
				await hydrated(page);
				await page.getByRole("button", { name: "Ask Evry" }).click();
				const panel = page.getByRole("dialog", { name: "Evry" });
				await panel.getByRole("button", { name: "History" }).click();
				await panel.getByRole("button", { name: "New chat" }).click();
				const box = panel.getByLabel("Message Evry");
				await box.fill(`Change Maria's city to Dallas ${engine}`);
				await box.press("Enter");

				const card = panel.getByRole("region", { name: "Review before saving" });
				await card.getByRole("button", { name: "Revise" }).click({ timeout: 60_000 });
				const city = `Austin ${engine} ${Date.now().toString(36)}`;
				await card.getByLabel("City").fill(city);
				await card.getByRole("button", { name: "Update review" }).click();
				await card.getByText("Revision 2", { exact: true }).waitFor();

				// Keyboard use: Safari does not focus a button on a mouse click.
				await card.getByRole("button", { name: "Approve" }).focus();
				await page.keyboard.press("Enter");
				const saved = panel.getByRole("region", { name: "Saved" });
				await saved.waitFor({ timeout: 15_000 });
				// One replay of the same request key after the lost reply, then the card reads the saved state.
				assert.equal(approvals.length, 2);
				assert.equal(approvals[1], approvals[0]);
				assert.equal(JSON.parse(approvals[0]).revision, 2);
				assert.match(await saved.innerText(), new RegExp(city));
				// The Approve button is gone; focus moved to the card's head, not to <body>.
				assert.equal(await saved.evaluate((el) => el.contains(document.activeElement)), true);
				const person = await page.evaluate(
					(id) => fetch(`/people/${id}`).then((r) => r.text()),
					people.people["Maria Santos"],
				);
				assert.match(person, new RegExp(city));
			},
			{ width: 390, height: 844 },
		));

for (const [engine, launcher] of ENGINES)
	test(`AC:INH-REGRESSION-CONFIRM-REPLAY INV-unknown-approval: Check again settles an unknown approval (${engine})`, () =>
		withPage(
			launcher,
			async (page, context) => {
				const people = fixture("people");
				await signIn(context, people.owner.cookie);
				const approvals = [];
				let lose = false;
				let revised = 0;
				// The update reaches the server, but its reply and the read after it are lost.
				await context.route("**/api/evry/proposals/*/revise", async (route) => {
					revised++;
					await route.fetch();
					await route.abort("connectionreset");
				});
				// The approval and its replay never reach the server; the read after them gets no answer either.
				await context.route("**/api/evry/proposals/*/approve", async (route) => {
					approvals.push(route.request().postData());
					if (lose) await route.abort("connectionreset");
					else await route.continue();
				});
				await context.route("**/api/evry/proposals/*", (route) =>
					lose ? route.abort("connectionreset") : route.continue(),
				);
				// The browser's own clock, so the test can pass the review's expiry without waiting 15 minutes.
				await page.clock.install();
				await page.goto(`${BASE}/people`);
				await hydrated(page);
				await page.getByRole("button", { name: "Ask Evry" }).click();
				const panel = page.getByRole("dialog", { name: "Evry" });
				await panel.getByRole("button", { name: "History" }).click();
				await panel.getByRole("button", { name: "New chat" }).click();
				const city = `Plano ${engine} ${Date.now().toString(36)}`;
				const box = panel.getByLabel("Message Evry");
				await box.fill(`Change Maria's city to ${city}`);
				await box.press("Enter");

				const card = panel.getByRole("region", { name: "Review before saving" });
				await card.getByRole("button", { name: "Revise" }).click({ timeout: 60_000 });
				const typed = `${city} revised`;
				await card.getByLabel("City").fill(typed);
				lose = true;
				await card.getByRole("button", { name: "Update review" }).click();
				const form = panel.getByRole("region", { name: "Not confirmed" });
				await form.getByRole("button", { name: "Check again" }).waitFor({ timeout: 15_000 });
				assert.equal(await form.getByLabel("City").inputValue(), typed);
				assert.equal(await form.getByRole("button", { name: "Update review" }).isDisabled(), true);
				assert.equal(await form.getByRole("button", { name: "Keep as it is" }).isDisabled(), true);
				assert.equal(revised, 1);
				lose = false;
				await form.getByRole("button", { name: "Check again" }).click();
				await card.getByText("Revision 2", { exact: true }).waitFor();
				assert.equal(revised, 1);

				lose = true;
				await card.getByRole("button", { name: "Approve" }).click();
				const unknown = panel.getByRole("region", { name: "Not confirmed" });
				await unknown.waitFor({ timeout: 15_000 });
				assert.match(await unknown.innerText(), /may already be saved/);
				assert.equal(await unknown.getByRole("button", { name: "Approve" }).count(), 0);
				assert.equal(await unknown.getByRole("button", { name: "Revise" }).isDisabled(), true);
				assert.equal(await unknown.getByRole("button", { name: "Cancel" }).isDisabled(), true);
				assert.equal(approvals.length, 2);
				// Only the server can say the review expired without an effect; the local clock never does.
				await page.clock.fastForward("16:00");
				assert.equal(await panel.getByRole("region", { name: "Expired" }).count(), 0);
				assert.match(await unknown.innerText(), /may already be saved/);

				lose = false;
				await unknown.getByRole("button", { name: "Check again" }).click();
				const saved = panel.getByRole("region", { name: "Saved" });
				await saved.waitFor({ timeout: 15_000 });
				assert.equal(approvals.length, 3);
				assert.ok(approvals.every((body) => body === approvals[0]));
				assert.match(await saved.innerText(), new RegExp(typed));
				assert.equal(JSON.parse(approvals[0]).revision, 2);
			},
			{ width: 390, height: 844 },
		));

// A first approval with no later request, through the real routes: its own request starts the change. A replay of the
// same approval afterwards returns the saved review and saves nothing again.
test("AC:INH-REGRESSION-CONFIRM-REPLAY INV-approve-runs-once: a first approval saves its change without any other request; its replay saves nothing again", () =>
	withPage(ENGINES[0][1], async (_page, context) => {
		const people = fixture("people");
		await signIn(context, people.owner.cookie);
		const api = async (path, data) => {
			const r =
				data === undefined ? await context.request.get(BASE + path) : await context.request.post(BASE + path, { data });
			assert.equal(r.status(), 200, `${path}: ${await r.text()}`);
			return r.json();
		};
		const until = async (read, done, ms) => {
			for (const deadline = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 250))) {
				const value = await read();
				if (done(value) || Date.now() > deadline) return value;
			}
		};
		const city = `Irving ${Date.now().toString(36)}`;
		const conversation = await api("/api/evry/conversations", { requestKey: crypto.randomUUID() });
		await api(`/api/evry/conversations/${conversation.id}/turns`, {
			requestKey: crypto.randomUUID(),
			text: `Change Maria's city to ${city}`,
			references: [],
		});
		const read = await until(
			() => api(`/api/evry/conversations/${conversation.id}`),
			(r) => r.events.some((e) => e.kind === "status"),
			60_000,
		);
		const proposalId = read.events.find((e) => e.body.result?.proposalId)?.body.result.proposalId;
		assert.ok(proposalId, "Evry prepared a review");
		const review = await api(`/api/evry/proposals/${proposalId}`);
		const witness = { revision: review.revision, digest: review.digest };

		const first = await api(`/api/evry/proposals/${proposalId}/approve`, witness);
		assert.equal(first.replayed, false);
		const saved = await until(
			() => api(`/api/evry/proposals/${proposalId}`),
			(r) => r.outcome !== null,
			15_000,
		);
		assert.equal(saved.outcome, "completed", "the first approval's own request ran the change");

		const replay = await api(`/api/evry/proposals/${proposalId}/approve`, witness);
		assert.deepEqual([replay.replayed, replay.proposal.outcome], [true, "completed"]);
		const after = await until(
			() => api(`/api/evry/proposals/${proposalId}`),
			() => false,
			2_000,
		);
		assert.deepEqual(after.receipt, saved.receipt, "the replay saved nothing again");
		const person = await context.request.get(`${BASE}/people/${people.people["Maria Santos"]}`);
		assert.match(await person.text(), new RegExp(city));
	}));
