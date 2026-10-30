// Messages: history first, the guided compose flow, the true email preview and the meeting handoff. Seed with
// tests/ui/people/seed.mts, then tests/ui/meetings/seed.mts, then tests/ui/communication/seed.mts; set UI_BASE_URL. Both browser engines run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const owner = () => fixture("people").owner.cookie;
const member = () => fixture("people").member.cookie;

/** Console errors and warnings of a page, and the count of server action POSTs. */
function watch(page) {
	const state = { logs: [], posts: 0 };
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning") state.logs.push(m.text());
	});
	page.on("request", (r) => {
		if (r.method() === "POST" && r.headers()["next-action"]) state.posts += 1;
	});
	return state;
}

const open = async (page, path) => {
	await page.goto(`${BASE}${path}`);
	await hydrated(page);
};
const heading = (page, name) => page.getByRole("heading", { level: 2, name });
const next = (page) => page.getByRole("button", { name: "Next", exact: true });

/** The text of the email shown in the preview frame. */
const emailText = (page) => page.frameLocator('iframe[title="Email preview"]').locator("body");

/** Who step with everyone selected through the group list. */
async function chooseEveryone(page) {
	await page.getByLabel("Groups and teams").click();
	await page.getByRole("option", { name: /All people/ }).click();
	await page.keyboard.press("Escape");
	await page.getByText("Will get this email").waitFor();
	await next(page).waitFor();
	await page.waitForFunction(() => !document.querySelector('button[aria-describedby="step-reason"][disabled]'));
}

for (const [name, engine] of ENGINES) {
	test(`AC:CASE-COM-003 (${name}): Messages opens on history, New message is the one writer action, and each address shows its state`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, "/communication");
			await page.getByText("Messages", { exact: true }).first().waitFor();
			assert.equal(await page.getByRole("button", { name: "New message" }).first().isVisible(), true);
			assert.equal(await page.getByRole("tab", { name: "Compose" }).count(), 0);
			assert.equal(await page.getByRole("radio", { name: "Compose" }).count(), 0);
			for (const label of ["Messages", "Templates", "Your address"])
				assert.equal(await page.getByRole("radio", { name: label }).count(), 1, label);

			await open(page, "/communication?view=templates");
			await page.getByRole("heading", { name: "System" }).waitFor();
			await page.getByRole("heading", { name: "Your church" }).waitFor();
			await open(page, "/communication?view=address");
			await page.getByText("Your address", { exact: true }).first().waitFor();

			await open(page, "/communication");
			// New message pushes an entry; Back returns to history.
			// The last step reloads and goes Back. A full navigation after a reload crashes Playwright's WebKit on any
			// Next page, so this test makes none.
			await page.getByRole("button", { name: "New message" }).first().click();
			await page.waitForURL(/compose=new&step=who/);
			await heading(page, "Who is this for?").waitFor();
			assert.equal(
				await page
					.getByRole("navigation", { name: "Steps" })
					.getByRole("button", { name: /Who/ })
					.getAttribute("aria-current"),
				"step",
			);
			await page.reload();
			await hydrated(page);
			await heading(page, "Who is this for?").waitFor();
			await page.goBack();
			await page.waitForURL((url) => !url.search.includes("compose"));
			await page.getByRole("button", { name: "New message" }).first().waitFor();
		});
	});

	test(`AC:CASE-COM-003 (${name}): a read-only seat sees history, no compose action and the read-only line`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, member());
			await open(page, "/communication");
			await page.getByText("You can read messages.", { exact: false }).waitFor();
			assert.equal(await page.getByRole("button", { name: "New message" }).count(), 0);
			assert.equal(await page.getByRole("radio", { name: "Your address" }).count(), 0);
		});
	});

	test(`AC:CASE-COM-003 AC:CASE-COM-004 (${name}): Who finds people by word prefix, shows left-out people and counts`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const state = watch(page);
			await open(page, "/communication?compose=new&step=who");
			await next(page).waitFor();
			assert.equal(await next(page).isDisabled(), true);
			await page.getByText("Choose at least one person who can get email").waitFor();

			const to = page.getByRole("combobox", { name: "Add a person" });
			await to.fill("sa");
			await page.getByRole("option", { name: /Sara Nunez/ }).waitFor();
			// The domain never matches: "test" finds nobody.
			await to.fill("test");
			// While the search is in flight the list says nothing. The empty line comes with the answer.
			assert.equal(await page.getByText("No people match.").count(), 0);
			await page.getByText("No people match.").waitFor();
			await to.fill("sara");
			await page.getByRole("option", { name: /Sara Nunez/ }).waitFor();
			await to.press("Enter");
			await page.getByRole("button", { name: "Remove Sara Nunez" }).waitFor();
			await to.press("Backspace");
			assert.equal(await page.getByRole("button", { name: "Remove Sara Nunez" }).count(), 0);

			await chooseEveryone(page);
			const tiles = page.getByText("Left out", { exact: true }).first();
			await tiles.waitFor();
			await page.getByRole("region", { name: "Left out, and why" }).getByText("No email address").first().waitFor();
			assert.equal(await next(page).isEnabled(), true);
			assert.deepEqual(
				state.logs.filter((l) => /uncontrolled to controlled/.test(l)),
				[],
			);
		});
	});

	test(`AC:CASE-COM-003 (${name}): Write keeps the template, marks unfinished fields, previews in a sandboxed frame and resizes to phone`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const state = watch(page);
			await open(page, "/communication?compose=new&step=who");
			await chooseEveryone(page);
			await next(page).click();
			await heading(page, "Write the message").waitFor();
			await page.waitForURL(/compose=[0-9a-f-]{36}&step=write/);

			// Task 13: the picker keeps the chosen template's name.
			await page.getByLabel("Start from a template").click();
			await page.getByRole("option", { name: /Vision meeting invitation/ }).click();
			assert.match(await page.getByLabel("Start from a template").innerText(), /Vision meeting invitation/);
			await page.getByLabel("Subject").fill("Sunday gathering");
			assert.match(await page.getByLabel("Start from a template").innerText(), /Vision meeting invitation/);

			// Task 15: an unfinished field shows a readable marker, never raw braces.
			const message = page.getByRole("combobox", { name: "Message" });
			await message.fill("Hello {{na");
			await emailText(page).getByText("[finish this field]").waitFor();
			assert.doesNotMatch(await emailText(page).innerText(), /[{}]/);
			await page.getByText("Finish or remove the field {{na").first().waitFor();
			assert.equal(await next(page).isDisabled(), true);
			await message.fill("Hello {{nmae}}.");
			await emailText(page).getByText("[unknown field: nmae]").waitFor();
			await message.fill("Hello {{name}}. Join us");
			await emailText(page)
				.getByText(/Hello .+\. Join us/)
				.waitFor();
			assert.doesNotMatch(await emailText(page).innerText(), /[{}]/);
			assert.equal(await next(page).isEnabled(), true);

			// The frame: sandbox, title, no inner scrollbar, cursor pointer, Desktop 600 and Phone 375.
			const frame = page.locator('iframe[title="Email preview"]');
			assert.equal(await frame.getAttribute("sandbox"), "allow-same-origin");
			// The frame gets the delivery renderer's full document in preview mode (criterion 34).
			const srcdoc = await frame.getAttribute("srcdoc");
			assert.match(srcdoc, /^<!DOCTYPE html>/);
			assert.match(srcdoc, /<p [^>]*>Hello .+\. Join us<\/p>/);
			assert.doesNotMatch(srcdoc, /\{\{|\}\}/);
			const wide = await frame.evaluate((el) => el.getBoundingClientRect().width);
			assert.ok(Math.abs(wide - 600) < 2 || wide < 600, `desktop width ${wide}`);
			await page.getByRole("radio", { name: "Phone" }).click();
			await page.waitForFunction(
				() => document.querySelector('iframe[title="Email preview"]')?.style.width === "375px",
			);
			assert.equal(
				await page.getByRole("radio", { name: "Phone" }).evaluate((el) => getComputedStyle(el).cursor),
				"pointer",
			);
			assert.equal(
				await page.getByRole("radio", { name: "Desktop" }).evaluate((el) => getComputedStyle(el).cursor),
				"pointer",
			);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
			assert.doesNotMatch(await page.locator("main").innerText(), /HTML/);
			assert.deepEqual(
				state.logs.filter((l) => /uncontrolled to controlled/.test(l)),
				[],
			);
		});
	});

	test(`AC:CASE-COM-003 (${name}): typing in Write sends no server request, because the preview renders in the browser`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const state = watch(page);
			await open(page, "/communication?compose=new&step=who");
			await chooseEveryone(page);
			await next(page).click();
			await heading(page, "Write the message").waitFor();
			await page.getByLabel("Subject").fill("Typing test");
			const message = page.getByRole("combobox", { name: "Message" });
			await message.fill("");
			await message.focus();
			const before = state.posts;
			await page.keyboard.type("Forty characters typed without a long stop", { delay: 20 });
			await emailText(page)
				.getByText(/Forty characters typed/)
				.waitFor();
			// Wait past the render pause, then count: not one request for typing or for the pause.
			await page.waitForTimeout(600);
			assert.equal(state.posts - before, 0, "zero server action requests while typing");
		});
	});

	test(`AC:CASE-COM-003 (${name}): Send now asks first, names the people and the subject, and Cancel sends nothing`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, "/communication?compose=new&step=who");
			await chooseEveryone(page);
			await next(page).click();
			await heading(page, "Write the message").waitFor();
			await page.getByLabel("Subject").fill("Dialog check");
			await page.getByRole("combobox", { name: "Message" }).fill("Hello {{name}}.");
			await next(page).click();
			await heading(page, "Review and send").waitFor();
			await page.getByRole("heading", { name: "Ready to send?" }).waitFor();
			const switcher = page.getByRole("combobox", { name: "Preview as" });
			await switcher.waitFor();
			await page.getByText(/1 of \d+/).waitFor();

			// At 1440x900, before any scroll, no bar sits over the Send now button.
			const covered = await page.getByRole("button", { name: /^Send now to \d+/ }).evaluate((button) => {
				const box = button.getBoundingClientRect();
				if (box.bottom > innerHeight) return "below the fold";
				const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
				return button.contains(top) ? null : "covered";
			});
			assert.notEqual(covered, "covered", "Send now is not under a bar");

			await page.getByRole("button", { name: /^Send now to \d+/ }).click();
			const dialog = page.getByRole("alertdialog");
			await dialog.getByText(/^Send to \d+ people now\?$/).waitFor();
			await dialog.getByText('"Dialog check"').waitFor();
			await dialog.getByText("You cannot unsend it once it leaves.").waitFor();
			await dialog.getByText(/have no email and will be skipped/).waitFor();
			await dialog.getByRole("button", { name: "Cancel" }).click();
			await dialog.waitFor({ state: "hidden" });
			// Focus returns to the trigger.
			assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /Send now to/);

			// Schedule opens the same dialog with the time in its title.
			await page.getByRole("button", { name: "More ways to send" }).click();
			await page.getByRole("menuitem", { name: /Tomorrow, 9:00 AM/ }).click();
			await page
				.getByRole("alertdialog")
				.getByText(/^Schedule for /)
				.waitFor();
			await page.getByRole("alertdialog").getByText(/on .+/).first().waitFor();
			await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

			// Nothing was sent or scheduled: the draft is a Draft in history.
			await open(page, "/communication");
			await page
				.getByRole("button", { name: /Dialog check/ })
				.first()
				.waitFor();
			assert.match(
				await page
					.getByRole("button", { name: /Dialog check/ })
					.first()
					.innerText(),
				/Draft/,
			);
		});
	});

	test(`AC:CASE-COM-003 AC:CASE-COM-012 (${name}): Schedule confirms, returns to history with the message open and its scheduled actions, and a draft row reopens Write`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, "/communication?compose=new&step=who");
			await chooseEveryone(page);
			await next(page).click();
			await heading(page, "Write the message").waitFor();
			const run = Date.now().toString(36);
			const subject = `Schedule check ${name} ${run}`;
			await page.getByLabel("Subject").fill(subject);
			await page.getByRole("combobox", { name: "Message" }).fill("Hello {{name}}.");
			await next(page).click();
			await heading(page, "Review and send").waitFor();
			await page.getByRole("button", { name: "More ways to send" }).click();
			await page.getByRole("menuitem", { name: /Sunday, 8:00 AM/ }).click();
			const dialog = page.getByRole("alertdialog");
			await dialog.getByText(/^Schedule for /).waitFor();
			await dialog.getByText("You cannot unsend it once it leaves.").waitFor();
			await dialog.getByRole("button", { name: "Schedule email" }).click();
			await page.waitForURL(/\/communication\?message=[0-9a-f-]{36}$/);
			await page
				.getByRole("status")
				.filter({ hasText: /^Scheduled for .+ It has not been sent\.$/ })
				.waitFor();
			// The new message is first in the list and open, with the scheduled actions.
			const first = page.getByRole("region", { name: "History" }).getByRole("listitem").first();
			assert.match(await first.innerText(), new RegExp(subject));
			assert.match(await first.innerText(), /Scheduled/);
			for (const label of [
				"Send now",
				"Cancel provider send",
				"Check provider result",
				"Check replacement",
				"Change send time",
			])
				await page.getByRole("button", { name: label, exact: true }).first().waitFor();

			// A draft row goes back to Write at its own address.
			await page.goto(`${BASE}/communication?compose=new&step=who`);
			await hydrated(page);
			await chooseEveryone(page);
			await next(page).click();
			await heading(page, "Write the message").waitFor();
			await page.getByLabel("Subject").fill(`Draft row ${name} ${run}`);
			await page.getByRole("button", { name: "Save draft" }).first().click();
			await page.getByText("Draft saved.").waitFor();
			// The save moves the address to the saved draft. Let that transition finish before leaving (WebKit races otherwise).
			await page.waitForURL(/compose=[0-9a-f-]{36}&step=write/);
			await page.waitForLoadState("networkidle");
			await page.goto(`${BASE}/communication`);
			await hydrated(page);
			await page.getByRole("button", { name: new RegExp(`Draft row ${name} ${run}`) }).click();
			await page.waitForURL(/compose=[0-9a-f-]{36}&step=write/);
			assert.equal(await page.getByLabel("Subject").inputValue(), `Draft row ${name} ${run}`);
		});
	});

	test(`AC:CASE-COM-003 (${name}): a message with no stored HTML opens in history with the plain-text line and its body`, async () => {
		const { legacy } = fixture("communication");
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, `/communication?message=${legacy}`);
			await page.getByText("This message was saved as plain text.").waitFor();
			await page.getByText("We hope to see you again.").waitFor();
			assert.equal(new URL(page.url()).searchParams.get("message"), legacy);
		});
	});

	test(`AC:CASE-COM-003 AC:CASE-COM-012 (${name}): a Reviewed row opens Review with the subject and body locked`, async () => {
		const { reviewed } = fixture("communication");
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, "/communication");
			await page
				.getByRole("button", { name: /Reviewed follow-up seed/ })
				.first()
				.click();
			await page.waitForURL(new RegExp(`compose=${reviewed}&step=review`));
			await heading(page, "Review and send").waitFor();
			await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: /Write/ }).click();
			await page.waitForURL(new RegExp(`compose=${reviewed}&step=write`));
			await page.getByText("This follow-up keeps the original subject and body.").waitFor();
			assert.equal(await page.getByLabel("Subject").isDisabled(), true);
			assert.equal(await page.getByRole("combobox", { name: "Message" }).isDisabled(), true);
		});
	});

	test(`AC:CASE-COM-003 (${name}): the meeting handoff opens Write with the meeting, its invitation and its guests, and names a missing meeting`, async () => {
		const { meetingId } = fixture("meetings");
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, `/communication?meeting=${meetingId}&template=invitation&recipients=guests`);
			await heading(page, "Write the message").waitFor();
			await page
				.getByText(/Vision meeting/)
				.first()
				.waitFor();
			assert.match(await page.getByLabel("Start from a template").innerText(), /Vision meeting invitation/);
			assert.notEqual(await page.getByLabel("Subject").inputValue(), "");
			await page.getByText("RSVP button").first().waitFor();
			// The live guest list is in To, as person chips, on the Who step.
			await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: /Who/ }).click();
			await heading(page, "Who is this for?").waitFor();
			await page.getByRole("button", { name: /^Leo Pratt, details/ }).waitFor();
			// The hover card of a handoff chip shows the person's email, not a placeholder.
			await page.getByRole("button", { name: /^Sara Nunez, details/ }).click();
			await page.getByRole("tooltip").getByText(/@/).waitFor();
			assert.equal(await page.getByText("Email shown at send").count(), 0);

			const gone = "00000000-0000-4000-8000-000000000000";
			await open(page, `/communication?meeting=${gone}&template=invitation&recipients=guests`);
			await heading(page, "Write the message").waitFor();
			await page.getByText("That meeting is not available. The message has no meeting.").waitFor();
			assert.equal(await page.getByLabel("Subject").inputValue(), "");
		});
	});

	test(`AC:CASE-COM-003 (${name}): the handoff fits an orientation and a team meeting, and both failure lines name what is missing`, async () => {
		const { orientation, team, practice, retired } = fixture("communication");
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const handoff = (id) => open(page, `/communication?meeting=${id}&template=invitation&recipients=guests`);
			for (const [id, title, template] of [
				[orientation, /Orientation/, /Orientation invitation/],
				[team, /Team Meeting/, /Team meeting invitation/],
			]) {
				await handoff(id);
				await heading(page, "Write the message").waitFor();
				await page.getByText(title).first().waitFor();
				assert.match(await page.getByLabel("Start from a template").innerText(), template);
				assert.notEqual(await page.getByLabel("Subject").inputValue(), "");
				await page.getByText("RSVP button").first().waitFor();
			}
			// No invitation template exists for this type: a blank message and the line.
			await handoff(practice);
			await heading(page, "Write the message").waitFor();
			await page
				.getByText("No invitation template for this meeting type. Write the message, or start from another template.")
				.waitFor();
			assert.equal(await page.getByLabel("Subject").inputValue(), "");
			// A retired meeting opens a blank message without the meeting.
			await handoff(retired);
			await heading(page, "Write the message").waitFor();
			await page.getByText("That meeting is not available. The message has no meeting.").waitFor();
			assert.equal(await page.getByLabel("Subject").inputValue(), "");
		});
	});

	test(`AC:CASE-COM-003 (${name}): a history load error offers Try again, and an empty church sees No messages yet with New message`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			let mode = "fail";
			await page.route("**/communication**", async (route) => {
				const request = route.request();
				if (request.method() !== "POST" || !request.headers()["next-action"]) return route.fallback();
				if (mode === "fail") return route.abort();
				const response = await route.fetch();
				// Keep the real action reply shape, with no messages in the list.
				const body = (await response.text())
					.split("\n")
					.map((line) => {
						const at = line.indexOf(":");
						try {
							const value = JSON.parse(line.slice(at + 1));
							if (value?.value && Array.isArray(value.value.items))
								return `${line.slice(0, at + 1)}${JSON.stringify({ ...value, value: { ...value.value, items: [], nextCursor: null } })}`;
						} catch {}
						return line;
					})
					.join("\n");
				return route.fulfill({ response, body });
			});
			await page.goto(`${BASE}/communication`);
			await hydrated(page);
			await page
				.getByRole("alert")
				.filter({ hasText: /Unable to/ })
				.first()
				.waitFor();
			mode = "empty";
			await page.getByRole("button", { name: "Try again" }).click();
			await page.getByText("No messages yet").waitFor();
			assert.equal((await page.getByRole("button", { name: "New message" }).count()) >= 1, true);
		});
	});

	test(`AC:CASE-COM-007 (${name}): a system template is read-only with Fork, and the editor uses the Write layout`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, "/communication?view=templates");
			await page
				.getByRole("region", { name: "System" })
				.getByRole("button", { name: /Vision meeting invitation/ })
				.click();
			await page.getByText("System templates stay as they are. Fork the template to change a copy.").waitFor();
			await page.getByRole("button", { name: "Fork template" }).waitFor();
			assert.equal(await page.getByLabel("Name").isDisabled(), true);
			await page.locator('iframe[title="Email preview"]').waitFor();
			assert.doesNotMatch(await page.locator("main").innerText(), /HTML/);
			await page.getByRole("button", { name: "Fork template" }).click();
			await page.getByText("Template forked. You can edit the church copy.").waitFor();
			await page.getByRole("button", { name: "Save template" }).waitFor();
			// A fresh church copy has no messages, so a delete goes through and the list returns.
			await page.getByRole("button", { name: "Delete template" }).click();
			await page.getByRole("alertdialog").getByRole("button", { name: "Delete template" }).click();
			await page.getByRole("heading", { name: "System" }).waitFor();
		});
	});

	test(`AC:CASE-COM-003 (${name}): at 1440 and 1280 the 600 px email is whole and the page has no sideways scroll`, async () => {
		for (const width of [1440, 1280]) {
			await withPage(
				engine,
				async (page, context) => {
					await signIn(context, owner());
					await open(page, "/communication?compose=new&step=who");
					await chooseEveryone(page);
					await next(page).click();
					await heading(page, "Write the message").waitFor();
					await page.getByLabel("Subject").fill("Layout");
					await page.getByRole("combobox", { name: "Message" }).fill("Hello {{name}}.");
					await emailText(page).getByText(/Hello/).waitFor();
					const box = await page.locator('iframe[title="Email preview"]').boundingBox();
					assert.ok(box.x >= 0 && box.x + box.width <= width, `frame fits at ${width}`);
					assert.ok(box.width >= 590, `frame is not cropped at ${width}: ${box.width}`);
					assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
				},
				{ width },
			);
		}
	});
}
