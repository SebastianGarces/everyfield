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

// Each engine adds its own three people to the one future meeting, so the two runs never share a guest.
const CHOICES = {
	chromium: [
		["eli", "Eli Park"],
		["mia h", "Mia Hall"],
		["tom b", "Tom Baker"],
	],
	webkit: [
		["david k", "David Kim"],
		["james", "James Okafor"],
		["rosa", "Rosa Bennett"],
	],
};
for (const [name, engine] of ENGINES) {
	const [[q1, p1], [q2, p2], [q3, p3]] = CHOICES[name];
	test(`AC:TARGET-MTG-007 AC:TARGET-MTG-011 (${name}): Add guest picks people across searches, adds them with one click and keeps the ones that were not reached`, async () => {
		const { meetingId } = fixture("meetings");
		const ids = fixture("people").people;
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await page.goto(`${BASE}/meetings/${meetingId}`);
			await hydrated(page);
			await page.getByRole("button", { name: "Add guest" }).first().click();
			const dialog = page.getByRole("dialog", { name: "Add guest" });
			assert.equal(await dialog.getByText("Invited by").count(), 0);
			assert.equal(await dialog.getByText("Not recorded").count(), 0);
			const search = dialog.getByRole("searchbox", { name: /Search people/ });
			const pick = async (query, person) => {
				await search.fill(query);
				const box = dialog.getByRole("checkbox", { name: new RegExp(person) });
				await box.waitFor();
				await box.check();
			};
			// "s" finds names that start a word with s, never the email domain (example.test).
			await search.fill("s");
			await dialog.getByRole("checkbox", { name: /Maria Santos/ }).waitFor();
			assert.equal(await dialog.getByRole("checkbox", { name: new RegExp(p1) }).count(), 0);
			await pick(q1, p1);
			await pick(q2, p2);
			await pick(q3, p3);
			// The earlier choices stay chosen after the search changed, and each has a remove control.
			await dialog.getByText("Chosen (3)").waitFor();
			await dialog.getByRole("button", { name: `Remove ${p1}` }).waitFor();

			// The third person's save is lost both times: the others are added and the form keeps only that person.
			let lost = 0;
			await context.route("**/*", async (route) => {
				const r = route.request();
				if (r.method() === "POST" && r.headers()["next-action"] && (r.postData() ?? "").includes(ids[p3])) {
					lost++;
					return route.abort("failed");
				}
				return route.fallback();
			});
			await dialog.getByRole("button", { name: "Add 3 guests" }).click();
			const again = page.getByRole("dialog", { name: "Add guest" });
			await again.getByText(`${p3} was not added`, { exact: false }).waitFor();
			await again.getByText("Chosen (1)").waitFor();
			assert.equal(lost, 2);
			await context.unroute("**/*");
			for (const person of [p1, p2]) await page.locator("tr", { hasText: person }).waitFor();
			await again.getByRole("button", { name: "Add guest" }).click();
			await page.locator("tr", { hasText: p3 }).waitFor();
			assert.equal(await page.getByRole("dialog", { name: "Add guest" }).count(), 0);
		});
	});
}

for (const [name, engine] of ENGINES) {
	test(`AC:TARGET-MTG-007 (${name}): the walk-in "In People" picker and the inviter picker use the name-start rule`, async () => {
		const { meetingId } = fixture("meetings");
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			// Add a walk-in, "In People": "example" is only an email domain and finds no one; "ruth a" finds Ruth Allen.
			await page.goto(`${BASE}/meetings/${meetingId}/check-in`);
			await hydrated(page);
			await page.getByRole("button", { name: "Add a walk-in" }).click();
			const walkIn = page.getByRole("dialog", { name: "Add a walk-in" });
			const search = walkIn.getByRole("searchbox", { name: /Search people/ });
			await search.fill("example");
			await walkIn.getByText("No one matches", { exact: false }).waitFor();
			assert.equal(await walkIn.getByRole("radiogroup", { name: "Person" }).getByRole("radio").count(), 0);
			await search.fill("ruth a");
			await walkIn.getByRole("radio", { name: /Ruth Allen/ }).waitFor();
			await page.keyboard.press("Escape");

			// "Who invited them?" on a guest row.
			await page.goto(`${BASE}/meetings/${meetingId}`);
			await hydrated(page);
			await page
				.getByRole("button", { name: /^Actions for / })
				.first()
				.click();
			await page.getByRole("menuitem", { name: "Change who invited them" }).click();
			const inviter = page.getByRole("dialog", { name: "Who invited them?" });
			const find = inviter.getByRole("searchbox", { name: /Search people/ });
			await find.fill("example");
			await inviter.getByText("No one matches", { exact: false }).waitFor();
			await find.fill("ruth a");
			await inviter.getByRole("radio", { name: /Ruth Allen/ }).waitFor();
		});
	});
}
