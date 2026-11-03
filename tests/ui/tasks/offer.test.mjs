// WP-026 round 2: two devices answer one phase offer. The laptop accepts first; the phone's "Decline all" then shows
// what was already decided. Close ends the card: the old offer and its answer buttons do not come back.
//   AC:TARGET-TSK-010 INV-one-answer: after Close on the second device no offer and no answer button shows, and a reload
//     shows none either.
// The test moves the seeded church one phase forward through the phase writer, as the phase screen does, so the offer
// is real. Run it with --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx on a fresh People seed
// (tests/ui/people/seed.mts; a declined checklist is never offered again), then set UI_BASE_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn } from "../setup.mjs";

/** Moves the seeded church to the next phase as its Owner. */
async function movePhase() {
	const { openSeedEnvironment } = await import("../seed-env.mts");
	const { sql } = await import("../../../packages/db/node_modules/drizzle-orm/index.js");
	const { RequestActor } = await import("../../../packages/domain/src/access/session.ts");
	const { createPhaseWriter } = await import("../../../packages/domain/src/phases/index.ts");
	const people = fixture("people");
	const env = await openSeedEnvironment(people.origin);
	try {
		const session = await env.admin.execute(sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id = s.user_id
			WHERE u.email = 'owner@people-preview.example.test' ORDER BY s.created_at DESC LIMIT 1`);
		const actor = await env.runtime.transaction((tx) => RequestActor.resolve(tx, session.rows[0].id));
		const plant = await env.admin.execute(sql`SELECT revision::text AS r, phase FROM plant WHERE id = ${people.plant}`);
		const { r, phase } = plant.rows[0];
		const moved = await createPhaseWriter({ async notices() {} }).transition(env.runtime, actor, {
			requestKey: randomUUID(),
			expectedRevision: r,
			input: { toPhase: Number(phase) + 1, reason: "The core group reached thirty committed adults" },
		});
		assert.equal(moved.status, "ok", JSON.stringify(moved));
	} finally {
		await env.close();
	}
}

const offer = (page) => page.getByRole("region", { name: /^Checklists for Phase/ });

for (const [name, engine] of ENGINES)
	test(`Close on the second device ends an answered offer (${name})`, async () => {
		await movePhase();
		const browser = await engine.launch();
		try {
			const device = async (width) => {
				const context = await browser.newContext({
					viewport: { width, height: 900 },
					reducedMotion: "reduce",
					ignoreHTTPSErrors: true,
				});
				await signIn(context, fixture("people").owner.cookie);
				const page = await context.newPage();
				await page.goto(`${BASE}/tasks`);
				await hydrated(page);
				await offer(page).waitFor();
				return page;
			};
			const [laptop, phone] = [await device(1440), await device(390)];

			await offer(laptop).getByRole("checkbox").first().click();
			await offer(laptop)
				.getByRole("button", { name: /^Add \d+ tasks?$/ })
				.click();
			await offer(laptop).waitFor({ state: "detached" });

			await offer(phone).getByRole("button", { name: "Decline all" }).click();
			const answered = phone.getByRole("status", { name: "Phase offer already answered" });
			await answered.waitFor();
			assert.ok((await answered.locator("li").count()) >= 1, "the phone lists the tasks the laptop added");
			await answered.getByRole("button", { name: "Close" }).click();
			await answered.waitFor({ state: "detached" });
			assert.equal(await offer(phone).count(), 0, "the answered offer does not come back");
			assert.equal(await phone.getByRole("button", { name: "Decline all" }).count(), 0);

			await phone.reload();
			await hydrated(phone);
			await phone.getByRole("heading", { level: 1 }).first().waitFor();
			assert.equal(await offer(phone).count(), 0, "no offer after a reload");
		} finally {
			await browser.close();
		}
	});
