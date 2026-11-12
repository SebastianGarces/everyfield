// Evry email drafts and reviewed scheduling on a seeded preview (WP-028 slice 2, MAIL51-009), in both engines at phone
// width. Seed with tests/ui/people/seed.mts, then tests/ui/evry/seed.mts, and run with --env-file=<home apps/web/.env.local>
// for the admin connection. The preview runs the scripted model (EVRY_SCRIPTED_MODEL=1) and the dev mail capture: a send,
// cancel or time change lands in the capture folder, and a file named no-answer there makes the capture give no answer.
// Every test drives the Evry panel and approves the card the way a planter does, then checks the database and the capture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const owner = () => fixture("people").owner.cookie;
const member = () => fixture("people").member.cookie;
const SUBJECT = "Sunday's interest meeting";
// The preview records mail in its own temp folder. `bin/dev browser run` gives this process a private temp folder inside it.
const systemTmp = /\/browser-run-[^/]+$/.test(tmpdir()) ? dirname(tmpdir()) : tmpdir();
const outbox = process.env.EVERYFIELD_DEV_OUTBOX?.trim() || join(systemTmp, "everyfield-dev-outbox");

let db = null;
/** The seeded database, opened on first use, for counting rows the page does not show. */
async function database() {
	if (db) return db;
	// `evf ac run` starts no env file: the admin connection comes from the home checkout's, which node loads and nothing prints.
	if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_UNPOOLED) {
		const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
		}).trim();
		process.loadEnvFile(join(common, "..", "apps/web/.env.local"));
	}
	const { openSeedEnvironment } = await import("../seed-env.mts");
	const { sql } = await import("../../../packages/db/node_modules/drizzle-orm/index.js");
	const env = await openSeedEnvironment(fixture("people").origin);
	const plant = fixture("people").plant;
	const rows = async (query) => (await env.admin.execute(query)).rows;
	db = {
		sql,
		rows,
		plant,
		/** The newest message with this subject. */
		async message(subject = SUBJECT) {
			return (
				await rows(sql`SELECT id,state,revision::text,to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_at,
					subject,body_text,audience FROM communication WHERE plant_id=${plant}::uuid AND subject=${subject} ORDER BY created_at DESC LIMIT 1`)
			)[0];
		},
		async count(subject = SUBJECT) {
			return (
				await rows(sql`SELECT count(*)::int n FROM communication WHERE plant_id=${plant}::uuid AND subject=${subject}`)
			)[0].n;
		},
		async mail(id) {
			return rows(sql`SELECT m.state,m.provider_message_id,to_char(m.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_at,
				p.display_name FROM mail m LEFT JOIN person p ON p.id=m.recipient_person_id
				WHERE m.tenant_id=${plant}::uuid AND m.logical_key LIKE ${"communication/" + id + "/%"} ORDER BY p.display_name`);
		},
		async requests(id) {
			return (
				await rows(sql`SELECT count(DISTINCT r.id)::int n FROM mail_request r JOIN mail_request_member mem ON mem.request_id=r.id
					JOIN mail m ON m.id=mem.mail_id WHERE m.logical_key LIKE ${"communication/" + id + "/%"}`)
			)[0].n;
		},
		async attempts(id) {
			return (
				await rows(sql`SELECT count(*)::int n FROM mail_attempt a JOIN mail_request_member mem ON mem.request_id=a.request_id
					JOIN mail m ON m.id=mem.mail_id WHERE m.logical_key LIKE ${"communication/" + id + "/%"}`)
			)[0].n;
		},
		close: () => env.close(),
	};
	return db;
}
test.after(async () => {
	if (db) await db.close();
	await rm(join(outbox, "no-answer"), { force: true });
});

/** The capture file the email service recorded for a provider id. */
async function captured(providerId) {
	return JSON.parse(await readFile(join(outbox, `${providerId}.json`), "utf8"));
}
const silence = async (on) => {
	await mkdir(outbox, { recursive: true });
	if (on) await writeFile(join(outbox, "no-answer"), "");
	else await rm(join(outbox, "no-answer"), { force: true });
};

/** Opens Messages with a new Evry chat. */
async function openEvry(page, context, cookie = owner()) {
	await signIn(context, cookie);
	await page.goto(`${BASE}/communication`);
	await hydrated(page);
	await page.getByRole("button", { name: "Ask Evry" }).click();
	const panel = page.getByRole("dialog", { name: "Evry" });
	await panel.getByRole("button", { name: "History" }).click();
	await panel.getByRole("button", { name: "New chat" }).click();
	return panel;
}
/** Sends one request and returns the newest card whose heading matches. */
async function ask(panel, text, heading) {
	// One turn at a time: the earlier answer is finished before the next request goes in.
	await panel.getByRole("button", { name: "Stop" }).waitFor({ state: "hidden", timeout: 120_000 });
	const regions = panel.getByRole("region", { name: heading });
	const seen = await regions.count();
	const box = panel.getByLabel("Message Evry");
	await box.fill(text);
	await box.press("Enter");
	// The new card is the one after those already on screen.
	const card = regions.nth(seen);
	await card.waitFor({ timeout: 120_000 });
	return card;
}
/** The head icon's drawing, to tell the confirmed tick from the alert. A re-render may reorder an SVG's attributes, so only the path shapes count. */
const headIcon = (card) =>
	card
		.locator("h3 svg")
		.first()
		.locator("path")
		.evaluateAll((paths) => paths.map((path) => path.getAttribute("d")).join(" "));
/** Approves the way a keyboard user does (Safari does not focus a button on a mouse click). */
async function approve(card) {
	await card.getByRole("button", { name: "Approve" }).focus();
	await card.page().keyboard.press("Enter");
}
/** Messages with its history loaded: the page text once the message is listed. */
async function messages(page) {
	await page.goto(`${BASE}/communication`);
	await hydrated(page);
	await page.getByText(SUBJECT).first().waitFor({ timeout: 90_000 });
	return page.locator("main").innerText();
}
/** The status line of the newest history row with this subject. */
const newestStatus = (text) => new RegExp(`${SUBJECT}\\n([^\\n]+)`).exec(text)?.[1];
const done = (panel, heading) => panel.getByRole("region", { name: heading }).last();

/** A saved draft, then scheduled for Friday at 9am: the state most criteria start from. Returns the message. */
async function scheduledFriday(panel, d) {
	const draft = await ask(
		panel,
		"Draft an email to the launch team inviting them to Sunday's interest meeting.",
		"Review before saving",
	);
	await approve(draft);
	await done(panel, "Saved").waitFor({ timeout: 90_000 });
	const schedule = await ask(panel, "Schedule it for Friday at 9am", "Review before scheduling");
	await approve(schedule);
	await done(panel, /^Scheduled for Fri, 9:00 AM/).waitFor({ timeout: 90_000 });
	return d.message();
}

for (const [engine, launcher] of ENGINES) {
	const run = (body) => withPage(launcher, body, { width: 390, height: 844 });

	test(`AC:WP-028-1 (${engine}): a draft review shows subject, audience, recipient count and body, and saves nothing`, () =>
		run(async (page, context) => {
			const d = await database();
			const before = await d.count();
			const panel = await openEvry(page, context);
			const card = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			const text = await card.innerText();
			assert.match(text, /Subject\s*Sunday's interest meeting/);
			assert.match(text, /Launch team/);
			assert.match(text, /5 with an email address/);
			assert.match(text, /1 with no email address/);
			assert.match(text, /interest meeting on Sunday at 4 pm/);
			assert.match(text, /Nothing is sent/);
			assert.equal(await d.count(), before, "nothing is saved before the planter approves");
		}));

	test(`AC:WP-028-2 (${engine}): approving the draft saves it in Messages with no mail and no email service call`, () =>
		run(async (page, context) => {
			const d = await database();
			const before = await d.count();
			const panel = await openEvry(page, context);
			const card = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await approve(card);
			await done(panel, "Saved").waitFor({ timeout: 90_000 });
			assert.equal(await d.count(), before + 1);
			const draft = await d.message();
			assert.equal(draft.state, "draft");
			assert.deepEqual(draft.audience.groups, ["launch_team"]);
			assert.match(draft.body_text, /interest meeting on Sunday at 4 pm/);
			assert.deepEqual(await d.mail(draft.id), [], "no mail row");
			assert.equal(await d.attempts(draft.id), 0, "no mail attempt");
			assert.equal(await d.requests(draft.id), 0, "no email service call");
			// The draft is in Messages and opens for editing.
			await page.goto(`${BASE}/communication?compose=${draft.id}&step=write`);
			await hydrated(page);
			assert.equal(await page.getByLabel("Subject").inputValue(), SUBJECT);
			await page
				.getByText(/interest meeting on Sunday at 4 pm/)
				.first()
				.waitFor({ timeout: 90_000 });
		}));

	test(`AC:WP-028-3 (${engine}): the schedule review names who gets it, who is left out and why, the content and the send time`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const draft = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await approve(draft);
			await done(panel, "Saved").waitFor({ timeout: 90_000 });
			const card = await ask(panel, "Schedule it for Friday at 9am", "Review before scheduling");
			const text = await card.innerText();
			for (const name of ["Lena Ortiz", "Marcus Webb", "Rosa Bennett"]) assert.match(text, new RegExp(name));
			assert.match(text, /Will get it\s*\(3\)/);
			assert.match(text, /Left out\s*\(3\)/);
			assert.match(text, /Priya Nair\s*Blocked after a bounce/);
			assert.match(text, /Dana Cole\s*Turned off update emails/);
			assert.match(text, /Noah Quinn\s*No email address/);
			assert.match(text, /Subject\s*Sunday's interest meeting/);
			assert.match(text, /What each person sees\s*Hi (Lena Ortiz|Marcus Webb|Rosa Bennett),/);
			assert.match(
				text,
				/Sends\s*Fri, [A-Z][a-z]{2} \d+, 9:00 AM \S+ \([A-Za-z ]+\)/,
				"the day, 9:00 AM and the zone name",
			);
			assert.equal((await d.message()).state, "draft", "nothing is scheduled before approval");
			// A time past the 30-day window, and a time already gone, are refused on the card with a plain reason.
			const far = await ask(panel, "Schedule it for 45 days from now at 9am", "Review before scheduling");
			assert.match(await far.innerText(), /at most 30 days/);
			assert.equal(
				await far.getByRole("button", { name: "Approve" }).count(),
				0,
				"a time outside the window cannot be approved",
			);
			const past = await ask(panel, "Schedule it for yesterday at 9am", "Review before scheduling");
			assert.match(await past.innerText(), /already passed/);
			assert.equal(await past.getByRole("button", { name: "Approve" }).count(), 0);
		}));

	test(`AC:WP-028-4 (${engine}): a schedule that is not approved, or whose approval lapsed, is refused as review required`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const draft = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await approve(draft);
			await done(panel, "Saved").waitFor({ timeout: 90_000 });
			const before = await d.message();
			const card = await ask(panel, "Schedule it for Friday at 9am", "Review before scheduling");
			// Not approved: the draft is unchanged and the email service has had no request.
			assert.equal(await d.requests(before.id), 0);
			// The 15-minute approval lapses before the click.
			const id = await card.evaluate((el) => el.getAttribute("data-proposal"));
			await d.rows(d.sql`UPDATE proposal SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${id}::uuid`);
			await approve(card);
			const expired = panel.getByRole("region", { name: "Expired" }).last();
			await expired.waitFor({ timeout: 90_000 });
			assert.match(await expired.innerText(), /Review required/);
			const after = await d.message();
			assert.deepEqual(
				[after.state, after.revision, after.scheduled_at],
				[before.state, before.revision, before.scheduled_at],
			);
			assert.equal(await d.requests(before.id), 0, "the email service got no call");
		}));

	test(`AC:WP-028-5 (${engine}): approving the schedule makes one schedule request and Messages shows the same scheduled message`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const message = await scheduledFriday(panel, d);
			const card = done(panel, /^Scheduled for Fri, 9:00 AM/);
			const text = await card.innerText();
			assert.match(text, /Accepted\s*3/);
			assert.match(text, /Refused\s*2/);
			assert.match(text, /Unknown\s*0/);
			assert.doesNotMatch(text, /delivered/i, "the card never says delivered");
			assert.equal(message.state, "scheduled");
			assert.equal(await d.requests(message.id), 1, "one schedule request");
			const mail = await d.mail(message.id);
			assert.deepEqual(
				mail.filter((m) => m.state === "accepted").map((m) => m.display_name),
				["Lena Ortiz", "Marcus Webb", "Rosa Bennett"],
			);
			const first = await captured(mail.find((m) => m.provider_message_id).provider_message_id);
			assert.equal(first.scheduledAt, message.scheduled_at, "the email service holds the reviewed time");
			const body = await messages(page);
			assert.match(body, /Sunday's interest meeting/);
			assert.equal(newestStatus(body), "Scheduled");
			assert.doesNotMatch(body, /Delivered/);
		}));

	test(`AC:WP-028-5 (${engine}): a card with no saved result and a lapsed approval says so and offers no Try again`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const draft = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await approve(draft);
			await done(panel, "Saved").waitFor({ timeout: 90_000 });
			const schedule = await ask(panel, "Schedule it for Friday at 9am", "Review before scheduling");
			const id = await schedule.evaluate((el) => el.getAttribute("data-proposal"));
			await approve(schedule);
			await done(panel, /^Scheduled for Fri, 9:00 AM/).waitFor({ timeout: 90_000 });
			// The effect ended with no saved result and its approval lapsed: the state a killed worker can leave.
			await d.rows(
				d.sql`UPDATE proposal SET outcome='failed',receipt='{"reached":true}'::jsonb,expires_at=clock_timestamp()-interval '1 second' WHERE id=${id}::uuid`,
			);
			await page.reload();
			await hydrated(page);
			await page.getByRole("button", { name: "Ask Evry" }).click();
			const card = page.getByRole("dialog", { name: "Evry" }).locator(`[data-proposal="${id}"]`);
			await card.getByText(/approval expired/).waitFor({ timeout: 90_000 });
			assert.doesNotMatch(await card.innerText(), /Try again\./);
			assert.equal(await card.getByRole("button", { name: "Try again" }).count(), 0);
		}));

	test(`AC:WP-028-6 (${engine}): a time change shows old and new time and the new time only after the email service confirms`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const message = await scheduledFriday(panel, d);
			await silence(true);
			try {
				const card = await ask(panel, "Move the Friday email to Saturday at 9am", "Review the new time");
				const text = await card.innerText();
				assert.match(text, /Fri, [A-Z][a-z]{2} \d+, 9:00 AM/);
				assert.match(text, /Sat, [A-Z][a-z]{2} \d+, 9:00 AM/);
				assert.match(text, /Recipients and content stay the same/);
				await approve(card);
				const unconfirmed = done(panel, "Time change not confirmed");
				await unconfirmed.waitFor({ timeout: 90_000 });
				assert.doesNotMatch(await unconfirmed.getByRole("heading").innerText(), /Moved to/);
				const held = await d.mail(message.id);
				assert.ok(
					held.filter((m) => m.state === "accepted").every((m) => m.scheduled_at === message.scheduled_at),
					"no recipient moved",
				);
				// The email service answers on the next ask.
				await silence(false);
				await unconfirmed.getByRole("button", { name: "Check again" }).click();
				await done(panel, /^Moved to Sat, 9:00 AM/).waitFor({ timeout: 90_000 });
			} finally {
				await silence(false);
			}
			const moved = await d.message();
			assert.notEqual(moved.scheduled_at, message.scheduled_at);
			assert.ok(
				(await d.mail(moved.id))
					.filter((m) => m.state === "accepted")
					.every((m) => m.scheduled_at === moved.scheduled_at),
			);
			assert.equal(await d.requests(moved.id), 1, "the time change made no second send");
		}));

	test(`AC:WP-028-6 (${engine}): a schedule the email service did not answer refuses a time change on the card`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const draft = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await approve(draft);
			await done(panel, "Saved").waitFor({ timeout: 90_000 });
			const schedule = await ask(panel, "Schedule it for Friday at 9am", "Review before scheduling");
			await silence(true);
			let message;
			let before;
			try {
				await approve(schedule);
				await done(panel, /not confirmed/i).waitFor({ timeout: 90_000 });
				message = await d.message();
				before = message.scheduled_at;
			} finally {
				await silence(false);
			}
			const card = await ask(panel, "Move the Friday email to Saturday at 9am", "Review the new time");
			assert.match(await card.innerText(), /has not answered about every recipient of this message/);
			assert.equal(await card.getByRole("button", { name: "Approve" }).count(), 0, "nothing to approve");
			assert.doesNotMatch(await card.innerText(), /Approve by|Recipients and content stay the same/);
			const now = await d.message();
			assert.equal(now.id, message.id);
			assert.equal(now.scheduled_at, before, "the saved time stays");
		}));

	test(`AC:WP-028-7 (${engine}): a cancel says Cancelled only after the email service confirms, and Check again asks again`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const message = await scheduledFriday(panel, d);
			const tick = await headIcon(done(panel, /^Scheduled for Fri/));
			// Closing the review is not a cancel: the card never says the word the email service has not confirmed.
			const dismissed = await ask(panel, "Cancel the Friday email", "Review before cancelling");
			await dismissed.getByRole("button", { name: "Close review" }).click();
			const closed = done(panel, "Review closed");
			await closed.waitFor({ timeout: 90_000 });
			const closedText = await closed.innerText();
			assert.match(closedText, /The message still sends at its set time/);
			assert.doesNotMatch(closedText, /\bCancelled\b/);
			assert.notEqual(await headIcon(closed), tick);
			assert.equal((await d.mail(message.id)).filter((m) => m.state === "cancelled").length, 0);
			await silence(true);
			try {
				const card = await ask(panel, "Cancel the Friday email", "Review before cancelling");
				const text = await card.innerText();
				assert.match(text, /Subject\s*Sunday's interest meeting/);
				assert.match(text, /Was set for\s*Fri, [A-Z][a-z]{2} \d+, 9:00 AM/);
				assert.match(text, /People\s*3 people/);
				await approve(card);
				const unconfirmed = done(panel, "Cancel not confirmed");
				await unconfirmed.waitFor({ timeout: 90_000 });
				assert.notEqual(await headIcon(unconfirmed), tick, "only a confirmed result carries the tick");
				assert.equal((await d.mail(message.id)).filter((m) => m.state === "cancelled").length, 0);
				assert.equal(newestStatus(await messages(page)), "Cancel not confirmed", "Messages does not say Cancelled yet");
				await silence(false);
				await page.getByRole("button", { name: "Ask Evry" }).click();
				await done(panel, "Cancel not confirmed").getByRole("button", { name: "Check again" }).click();
				await done(panel, "Cancelled").waitFor({ timeout: 90_000 });
				assert.equal(await headIcon(done(panel, "Cancelled")), tick);
			} finally {
				await silence(false);
			}
			assert.equal((await d.mail(message.id)).filter((m) => m.state === "cancelled").length, 3);
			assert.equal(newestStatus(await messages(page)), "Cancelled");
		}));

	test(`AC:WP-028-8 (${engine}): a replacement is scheduled only when every original send is confirmed cancelled`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const original = await scheduledFriday(panel, d);
			const tick = await headIcon(done(panel, /^Scheduled for Fri/));
			const card = await ask(
				panel,
				"Replace the body of the Friday email with: We moved to 5 pm. Please arrive by 4:45.",
				"Review the replacement",
			);
			const text = await card.innerText();
			assert.match(text, /Body now/);
			assert.match(text, /interest meeting on Sunday at 4 pm/);
			assert.match(text, /Body after\s*We moved to 5 pm/);
			assert.match(text, /cancelled first/);
			assert.match(text, /only after the email service confirms every cancel/);
			// The email service gives no answer to the cancel: nothing new is scheduled.
			await silence(true);
			try {
				await approve(card);
				const blocked = done(panel, /^Not replaced/);
				await blocked.waitFor({ timeout: 90_000 });
				assert.notEqual(await headIcon(blocked), tick, "only a confirmed result carries the tick");
				const blockedText = await blocked.innerText();
				assert.match(blockedText, /Nothing new was scheduled/);
				assert.match(blockedText, /Lena Ortiz\s*Cancel not confirmed/);
			} finally {
				await silence(false);
			}
			const sameSubject = await d.rows(
				d.sql`SELECT id,state FROM communication WHERE plant_id=${d.plant}::uuid AND subject=${SUBJECT} AND created_at>(SELECT created_at FROM communication WHERE id=${original.id}::uuid)`,
			);
			assert.deepEqual(sameSubject, [], "no replacement was saved or scheduled");
			// Check again once the email service answers: every cancel is confirmed, then the replacement is scheduled.
			await done(panel, /^Not replaced/)
				.getByRole("button", { name: "Check again" })
				.click();
			await done(panel, /^Replacement scheduled for Fri, 9:00 AM/).waitFor({ timeout: 120_000 });
			assert.equal((await d.mail(original.id)).filter((m) => m.state === "cancelled").length, 3);
			const replacement = await d.rows(
				d.sql`SELECT id,state,body_text FROM communication WHERE plant_id=${d.plant}::uuid AND subject=${SUBJECT} AND id<>${original.id}::uuid ORDER BY created_at DESC LIMIT 1`,
			);
			assert.equal(replacement[0].state, "scheduled");
			assert.match(replacement[0].body_text, /We moved to 5 pm/);
			assert.equal(await d.requests(replacement[0].id), 1, "one new schedule request");
		}));

	test(`AC:WP-028-9 (${engine}): a message that changed after the review refuses the approval and offers a new review`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const message = await scheduledFriday(panel, d);
			const card = await ask(panel, "Move the Friday email to Saturday at 9am", "Review the new time");
			// Another window cancels the message in Messages before the approval.
			const messagesPage = await context.newPage();
			await messagesPage.goto(`${BASE}/communication?message=${message.id}`);
			await hydrated(messagesPage);
			await messagesPage.getByRole("button", { name: "Cancel scheduled email", exact: true }).first().click();
			await messagesPage.getByRole("alertdialog").getByRole("button", { name: "Cancel scheduled email" }).click();
			await messagesPage
				.getByText(/The email service confirmed the cancel for/)
				.first()
				.waitFor({ timeout: 90_000 });
			await messagesPage.close();
			assert.equal((await d.mail(message.id)).filter((m) => m.state === "cancelled").length, 3);
			const moved = await d.message();
			await approve(card);
			const stale = panel.getByRole("region", { name: "Message changed" }).last();
			await stale.waitFor({ timeout: 90_000 });
			const staleText = await stale.innerText();
			assert.match(staleText, /This message changed since the review/);
			assert.doesNotMatch(staleText, /stay the same/, "a stale card promises nothing");
			assert.equal(await stale.getByRole("button", { name: "Approve" }).isDisabled(), true);
			assert.equal((await d.message()).scheduled_at, moved.scheduled_at, "the time did not move");
			// Reviewing again finds nothing left to move, and says so.
			await stale.getByRole("button", { name: "Review again" }).click();
			await stale.getByText(/no longer waiting to send/).waitFor({ timeout: 90_000 });
		}));

	test(`AC:WP-028-9 (${engine}): a review whose message was deleted calls it a message and changes nothing`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const draft = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await approve(draft);
			await done(panel, "Saved").waitFor({ timeout: 90_000 });
			const message = await d.message();
			await ask(panel, "Schedule it for Friday at 9am", "Review before scheduling");
			await d.rows(d.sql`DELETE FROM communication WHERE id=${message.id}::uuid`);
			await page.reload();
			await hydrated(page);
			await page.getByRole("button", { name: "Ask Evry" }).click();
			const gone = page
				.getByRole("dialog", { name: "Evry" })
				.getByRole("region", { name: "No longer available" })
				.last();
			await gone.waitFor({ timeout: 90_000 });
			const text = await gone.innerText();
			assert.match(text, /The message in this change is no longer available to you/);
			assert.doesNotMatch(text, /person/i);
		}));

	test(`AC:WP-028-10 (${engine}): Evry finds the Friday email for "cancel the Friday email"; a member has no email write`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const friday = await scheduledFriday(panel, d);
			// A second message on another day must not be picked.
			const draft = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await approve(draft);
			await panel.getByRole("region", { name: "Saved" }).nth(1).waitFor({ timeout: 90_000 });
			const later = await ask(panel, "Schedule it for Saturday at 9am", "Review before scheduling");
			await approve(later);
			await done(panel, /^Scheduled for Sat, 9:00 AM/).waitFor({ timeout: 90_000 });
			const saturday = await d.message();
			assert.notEqual(saturday.id, friday.id);
			const card = await ask(panel, "Cancel the Friday email", "Review before cancelling");
			assert.match(await card.innerText(), /Subject\s*Sunday's interest meeting/);
			assert.match(await card.innerText(), /Was set for\s*Fri,/);
			await approve(card);
			await done(panel, "Cancelled").waitFor({ timeout: 90_000 });
			assert.equal((await d.mail(friday.id)).filter((m) => m.state === "cancelled").length, 3, "the Friday email");
			assert.equal(
				(await d.mail(saturday.id)).filter((m) => m.state === "cancelled").length,
				0,
				"not the Saturday one",
			);
			// A member can read the church's messages through Evry but is offered no email write.
			const memberPage = await context.newPage();
			await signIn(context, member());
			await memberPage.goto(`${BASE}/people`);
			await hydrated(memberPage);
			await memberPage.getByRole("button", { name: "Ask Evry" }).click();
			const memberPanel = memberPage.getByRole("dialog", { name: "Evry" });
			await memberPanel.getByRole("button", { name: "History" }).click();
			await memberPanel.getByRole("button", { name: "New chat" }).click();
			const box = memberPanel.getByLabel("Message Evry");
			await box.fill("What can you do?");
			await box.press("Enter");
			// The answer streams: wait for its read line, then for the end of the turn, before reading what it left out.
			await memberPanel
				.getByText(/Find this church's email drafts and scheduled messages/)
				.first()
				.waitFor({ timeout: 60_000 });
			await memberPanel.getByRole("button", { name: "Stop" }).waitFor({ state: "hidden", timeout: 60_000 });
			assert.doesNotMatch(
				await memberPanel.innerText(),
				/prepare these changes/,
				"no email write is offered to a member",
			);
			await memberPage.close();
		}));

	test(`AC:WP-028-10 (${engine}): the read leaves out a replaced original, so Friday's email is its replacement`, () =>
		run(async (page, context) => {
			const d = await database();
			const panel = await openEvry(page, context);
			const original = await scheduledFriday(panel, d);
			/** How many Friday messages the newest read returned. */
			const offered = async () => {
				const label = await panel
					.getByRole("region", { name: /^Messages, \d+ messages?$/ })
					.last()
					.getAttribute("aria-label");
				return Number(/\d+/.exec(label)[0]);
			};
			const card = await ask(panel, "Replace the body of the Friday email with: New words", "Review the replacement");
			const before = await offered();
			await approve(card);
			await done(panel, /^Replacement scheduled for Fri, 9:00 AM/).waitFor({ timeout: 120_000 });
			const replacement = await d.message();
			assert.notEqual(replacement.id, original.id);
			const cancel = await ask(panel, "Cancel the Friday email", "Review before cancelling");
			assert.equal(await offered(), before, "the replacement took the place of the original, which is not offered");
			await approve(cancel);
			await done(panel, "Cancelled").waitFor({ timeout: 90_000 });
			assert.equal((await d.mail(replacement.id)).filter((m) => m.state === "cancelled").length, 3);
		}));

	test(`AC:WP-028-11 (${engine}): a double click on Approve makes one schedule request`, () =>
		run(async (page, context) => {
			const d = await database();
			const before = await d.count();
			const panel = await openEvry(page, context);
			const draft = await ask(
				panel,
				"Draft an email to the launch team inviting them to Sunday's interest meeting.",
				"Review before saving",
			);
			await draft.getByRole("button", { name: "Approve" }).dblclick();
			await done(panel, "Saved").waitFor({ timeout: 90_000 });
			assert.equal(await d.count(), before + 1, "one draft");
			const card = await ask(panel, "Schedule it for Friday at 9am", "Review before scheduling");
			await card.getByRole("button", { name: "Approve" }).dblclick();
			await done(panel, /^Scheduled for Fri, 9:00 AM/).waitFor({ timeout: 90_000 });
			const message = await d.message();
			assert.equal(await d.requests(message.id), 1, "one schedule request");
			assert.equal((await d.mail(message.id)).length, 5, "one mail row for each reviewed person, none twice");
		}));
}
