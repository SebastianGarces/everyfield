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

				await card.getByRole("button", { name: "Approve" }).focus();
				await page.keyboard.press("Enter");
				const saved = panel.getByRole("region", { name: "Saved" });
				await saved.waitFor({ timeout: 15_000 });
				assert.equal(approvals.length, 2);
				assert.equal(approvals[1], approvals[0]);
				assert.equal(JSON.parse(approvals[0]).revision, 2);
				assert.match(await saved.innerText(), new RegExp(city));
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
				await context.route("**/api/evry/proposals/*/revise", async (route) => {
					revised++;
					await route.fetch();
					await route.abort("connectionreset");
				});
				await context.route("**/api/evry/proposals/*/approve", async (route) => {
					approvals.push(route.request().postData());
					if (lose) await route.abort("connectionreset");
					else await route.continue();
				});
				await context.route("**/api/evry/proposals/*", (route) =>
					lose ? route.abort("connectionreset") : route.continue(),
				);
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

for (const [engine, launcher] of ENGINES)
	test(`INV-open-reviews: opening a conversation with review cards reads no review by id (${engine})`, () =>
		withPage(
			launcher,
			async (page, context) => {
				const people = fixture("people");
				await signIn(context, people.owner.cookie);
				const reads = [];
				page.on("request", (r) => {
					if (r.method() === "GET" && /^\/api\/evry\/proposals\/[^/]+$/.test(new URL(r.url()).pathname))
						reads.push(r.url());
				});
				await page.goto(`${BASE}/people`);
				await hydrated(page);
				await page.getByRole("button", { name: "Ask Evry" }).click();
				const panel = page.getByRole("dialog", { name: "Evry" });
				await panel.getByRole("button", { name: "History" }).click();
				await panel.getByRole("button", { name: "New chat" }).click();
				const box = panel.getByLabel("Message Evry");
				const tag = `${engine} ${Date.now().toString(36)}`;
				const cards = panel.getByRole("region", { name: "Review before saving" });
				const approve = panel.getByRole("button", { name: "Approve" });
				for (const [n, ask] of [
					`Change Maria's city to Dallas ${tag}`,
					`Change James's city to Austin ${tag}`,
				].entries()) {
					await box.fill(ask);
					await box.press("Enter");
					await approve.nth(n).waitFor({ timeout: 60_000 });
					await panel.getByRole("button", { name: "Stop" }).waitFor({ state: "hidden", timeout: 60_000 });
				}
				assert.equal(new Set(reads).size, 2);

				reads.length = 0;
				await page.reload();
				await hydrated(page);
				await page.getByRole("button", { name: "Ask Evry" }).click();
				await approve.nth(1).waitFor({ timeout: 15_000 });
				assert.equal(await cards.count(), 2);
				assert.deepEqual(reads, []);

				await panel.getByRole("button", { name: "History" }).click();
				await panel.getByRole("button", { name: "New chat" }).click();
				await panel.getByRole("button", { name: "History" }).click();
				await panel.getByRole("button", { name: new RegExp(`Change Maria's city to Dallas ${tag}`) }).click();
				await approve.nth(1).waitFor({ timeout: 15_000 });
				assert.equal(await cards.count(), 2);
				assert.deepEqual(reads, []);
			},
			{ width: 390, height: 844 },
		));

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
