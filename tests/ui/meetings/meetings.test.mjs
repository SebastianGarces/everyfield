// The one meeting flow a silent break would cost us: a guest answers through their personal link, the Admin sees that
// answer and corrects it, and the closed link cannot answer again. Both saves lose their first reply, as on a weak
// connection: the link page still shows the recorded answer, and the correction is replayed once with the same request
// key instead of reading as a conflict. Seed with tests/ui/people/seed.mts, then tests/ui/meetings/seed.mts; set
// UI_BASE_URL. Both browser engines run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

/** Server actions are POSTs with a Next-Action header. The first `lose` of them reach the server; their answers are lost. */
async function loseReplies(context, lose) {
	let n = 0;
	await context.route("**/*", async (route) => {
		const r = route.request();
		if (r.method() !== "POST" || !r.headers()["next-action"]) return route.fallback();
		if (++n > lose) return route.fallback();
		await route.fetch();
		return route.abort("failed");
	});
	return () => n;
}

for (const [name, engine] of ENGINES) {
	test(`AC:CASE-COM-010 AC:TARGET-MTG-008 AC:TARGET-MTG-009 BUG-31d611e R3-4 R3-5 (${name}): a link answer reaches the guest list, an Admin correction wins and the link stays closed, also when replies are lost`, async () => {
		const { meetingId, links } = fixture("meetings");
		const { token, first } = links[name];
		await withPage(engine, async (page, context) => {
			await page.goto(`${BASE}/rsvp/${token}`);
			await hydrated(page);
			const linkPosts = await loseReplies(context, 1);
			await page.getByRole("button", { name: "Yes, I'll come" }).click();
			await page.getByRole("heading", { level: 1, name: `See you there, ${first}` }).waitFor();
			// The answer shows at once. Its reply is lost, so the page reads the link once; this line appears when that
			// read says the server has recorded the answer (R3-5). The buttons never come back.
			await page.getByText("This link is now closed.", { exact: false }).waitFor();
			assert.equal(await page.getByRole("button", { name: "Yes, I'll come" }).count(), 0);
			assert.equal(linkPosts(), 2, "the lost answer and one read of the link");
			await context.unroute("**/*");

			await signIn(context, fixture("people").owner.cookie);
			await page.goto(`${BASE}/meetings/${meetingId}`);
			await hydrated(page);
			const row = page.getByRole("row", { name: new RegExp(first) });
			await row.getByText("from their link").waitFor();
			assert.equal(await row.getByText("Yes", { exact: true }).count(), 1);

			const posts = await loseReplies(context, 1);
			await row.getByRole("button", { name: /^Actions for/ }).click();
			await page.getByRole("menuitem", { name: "Set to No" }).click();
			// The badge changes at once. The first reply is lost, so the same request is sent once more and its answer
			// confirms the change (R3-4): never "not changed", never a false conflict.
			await page
				.getByText(/RSVP set to No\./)
				.first()
				.waitFor();
			assert.equal(posts(), 2, "one send and one replay with the same request key");
			assert.equal(await page.getByText("Someone else changed this").count(), 0);
			await context.unroute("**/*");
			await page.reload();
			await page
				.getByRole("row", { name: new RegExp(first) })
				.getByText("set by an Admin")
				.waitFor();
			assert.equal(
				await page
					.getByRole("row", { name: new RegExp(first) })
					.getByText("No", { exact: true })
					.count(),
				1,
			);

			await page.goto(`${BASE}/rsvp/${token}`);
			await page.getByText("Your answer: I can't make it").waitFor();
			assert.equal(await page.getByRole("button", { name: "Yes, I'll come" }).count(), 0);
		});
	});
}
