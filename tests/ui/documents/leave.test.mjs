// WP-036 slice 3: the leave guard of the Church Document editor, in Chromium against a real preview. After each kind of
// edit, every in-app way out of the page is tried 20 times in a row. Each try starts from the saved document, makes one
// edit and takes the way out at once. The Everyfield dialog must ask every time, and Cancel must keep the page and the
// edit. No browser dialog may open.
//   UI_BASE_URL=https://wp-....localhost:1355 UI_ENGINE=chromium node --test tests/ui/documents/leave.test.mjs
// Seed People first: tests/ui/people/seed.mts up <preview-url>.
//   AC:DOC-EDIT-LEAVE        every way out after every kind of edit, 20 rounds, at 1440 px and at 390 px
//   AC:DOC-EDIT-LEAVE-RACE   an edit and the click in the same task (the guard read React state before, and missed it)
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const SHOTS = process.env.SHOT_DIR;
const PAPER = ".ef-paper .ProseMirror";
const ROUNDS = 20;
const DOC_PATH = /\/documents\/church\/[0-9a-f-]{36}$/;

const onPage = (run, size) =>
	withPage(
		chromium,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			const native = [];
			page.on("dialog", async (dialog) => {
				native.push(dialog.type());
				await dialog.dismiss();
			});
			await run(page);
			assert.deepEqual(native, [], "no browser dialog opened");
		},
		size,
	);

async function fork(page) {
	await page.goto(`${BASE}/documents/church`);
	await hydrated(page);
	await page.getByRole("button", { name: "New from template" }).first().click();
	await page.getByRole("button", { name: /^Core Group Commitment Card/ }).click();
	await page.waitForURL(DOC_PATH, { timeout: 90_000 });
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
}

const status = (page) => page.getByRole("status").filter({ hasText: /Saved|Unsaved|Saving|Not saved/ });
const json = (page) => page.locator(PAPER).evaluate((el) => JSON.stringify(el.editor.getJSON()));
const panel = (page) => page.getByRole("region", { name: "Page setup" });
const ask = (page) => page.getByRole("dialog", { name: "Leave without saving?" });

/** Puts the cursor at the end of the last text block inside the first node of `type` (the body when type is "doc"). */
const cursorIn = (page, type) =>
	page.locator(PAPER).evaluate((el, t) => {
		const ed = el.editor;
		let end = null;
		const scan = (node, start) =>
			node.descendants((child, offset) => {
				if (child.isTextblock && child.type.name === "paragraph") end = start + offset + 1 + child.content.size;
				return true;
			});
		if (t === "doc") {
			let pos = 0;
			ed.state.doc.forEach((child, offset) => {
				if (!["pageHeader", "pageFooter", "box"].includes(child.type.name) && child.isTextblock)
					pos = offset + 1 + child.content.size;
			});
			end = pos;
		} else {
			let found = false;
			ed.state.doc.descendants((node, pos) => {
				if (found) return false;
				if (node.type.name === t) {
					found = true;
					scan(node, pos + 1);
					return false;
				}
				return true;
			});
		}
		if (!end) throw new Error(`no text in ${t}`);
		ed.chain().focus().setTextSelection(end).run();
		// Lets the browser apply the cursor move before the next key: a key straight after it can be dropped.
		return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
	}, type);

/** Undoes back to the saved document `saved` (JSON); the status must then read "Saved" again. */
async function backToSaved(page, saved, what = "") {
	for (let i = 0; i < 20 && (await json(page)) !== saved; i++) {
		await page.locator(PAPER).evaluate((el) => el.editor.commands.undo());
	}
	assert.equal(await json(page), saved, `${what}: Undo goes back to the saved document`);
	await status(page)
		.filter({ hasText: /^Saved/ })
		.waitFor({ timeout: 5_000 });
}

/**
 * The kinds of edit. Each one changes the saved document with the real control a person uses, and the way out follows
 * at once. "after Save" saves first, so the edit is the first one after a save.
 */
function edits(page, savedMargin) {
	return {
		"body text": async () => {
			await cursorIn(page, "doc");
			await page.keyboard.type("b");
		},
		"layout block": async (round) => {
			await cursorIn(page, "column");
			await page
				.getByRole("group", { name: "Block settings" })
				.getByRole("radio", { name: `${3 + (round % 2)} columns` })
				.click();
		},
		"page setup": async (round) => {
			if (!(await panel(page).count())) await page.getByRole("button", { name: "Page setup", exact: true }).click();
			const value = [0.6, 0.7, 0.8].filter((v) => Math.abs(v - savedMargin) > 0.01)[round % 2];
			await page.getByLabel("Left margin").fill(String(value));
		},
		header: async () => {
			await cursorIn(page, "pageHeader");
			await page.keyboard.type("h");
		},
		footer: async () => {
			await cursorIn(page, "pageFooter");
			await page.keyboard.type("f");
		},
		save: async () => {
			await cursorIn(page, "doc");
			await page.keyboard.type("s");
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await status(page)
				.filter({ hasText: /^Saved/ })
				.waitFor();
		},
		"after Save": async () => {
			await cursorIn(page, "doc");
			await page.keyboard.type("a");
		},
	};
}

/**
 * Every in-app way out: Back, the account menu pages, and each link on the page that goes to another page of the app.
 * The links are read from the page, so a new one is tried too. A link in the closed mobile menu opens the menu first.
 */
async function exits(page) {
	const links = await page.evaluate(() =>
		[...document.querySelectorAll("a[href]")]
			.filter((a) => {
				const url = new URL(a.href);
				return url.origin === location.origin && url.pathname !== location.pathname && !a.hasAttribute("download");
			})
			.map((a) => ({
				href: a.getAttribute("href"),
				name: (a.getAttribute("aria-label") || a.textContent || "").trim(),
				nav: a.closest("nav")?.getAttribute("aria-label") ?? "",
			})),
	);
	const unique = [...new Map(links.map((l) => [`${l.nav}|${l.href}|${l.name}`, l])).values()];
	const out = unique.map((l) => {
		const scope = l.nav ? page.getByRole("navigation", { name: l.nav }) : page.locator("body");
		const link = scope
			.getByRole("link", { name: l.name, exact: true })
			.and(page.locator(l.nav ? `a[href="${l.href}"]` : `a[href="${l.href}"]:not(nav a)`))
			.filter({ visible: true })
			.first();
		return {
			name: `link "${l.name}" (${l.nav || "page"}) to ${l.href}`,
			take: async () => {
				if (!(await link.count())) await page.getByRole("button", { name: "Menu", exact: true }).click();
				await link.click();
			},
		};
	});
	out.push({ name: "browser Back", take: () => page.evaluate(() => history.back()) });
	for (const [label, href] of [
		["Seats and invitations", "/settings/seats"],
		["Sharing and privacy", "/settings/sharing"],
	]) {
		out.push({
			name: `account menu "${label}" to ${href}`,
			take: async () => {
				await page.getByRole("button", { name: /account menu/ }).click();
				await page.getByRole("menuitem", { name: label }).click();
			},
		});
	}
	return out;
}

async function guardHolds(page, size, kinds) {
	await fork(page);
	const path = new URL(page.url()).pathname;
	// A header for the header edits, saved, so every round starts from the saved document.
	await page.getByRole("button", { name: "Page setup", exact: true }).click();
	await panel(page).getByRole("switch", { name: "Header" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await status(page)
		.filter({ hasText: /^Saved/ })
		.waitFor();
	const savedMargin = Number(await page.getByLabel("Left margin").inputValue());
	await panel(page).getByRole("button", { name: "Close", exact: true }).click();
	const ways = await exits(page);
	const names = ways.map((w) => w.name);
	for (const required of [
		'link "Documents" (Breadcrumb) to /documents',
		'link "Church documents" (Breadcrumb) to /documents/church',
		"browser Back",
	])
		assert.ok(names.includes(required), `${required} is tried: ${names.join("; ")}`);
	const make = edits(page, savedMargin);
	let tries = 0;
	let shot = false;
	for (const kind of kinds) {
		for (let round = 0; round < ROUNDS; round++) {
			for (const way of ways) {
				if (kind === "after Save") await make.save();
				const saved = await json(page);
				await make[kind](round);
				const before = await json(page);
				assert.notEqual(before, saved, `${kind}: the edit changes the document`);
				await way.take();
				await ask(page)
					.waitFor({ timeout: 5_000 })
					.catch(() => assert.fail(`round ${round + 1}, ${kind}, ${way.name}: left with no dialog (${page.url()})`));
				if (SHOTS && !shot) {
					await page.screenshot({ path: `${SHOTS}/leave-dialog-${size.width}.png` });
					shot = true;
				}
				await ask(page).getByRole("button", { name: "Cancel" }).click();
				await ask(page).waitFor({ state: "detached" });
				assert.equal(new URL(page.url()).pathname, path, `${kind}, ${way.name}: Cancel keeps the page`);
				assert.equal(await json(page), before, `${kind}, ${way.name}: Cancel keeps the edit`);
				assert.equal(await status(page).innerText(), "Unsaved changes", `${kind}, ${way.name}: still unsaved`);
				// "after Save" saves at the start of each try; Undo would also take the typing just before that save.
				if (kind !== "after Save") await backToSaved(page, saved, `round ${round + 1}, ${kind}, ${way.name}`);
				tries++;
			}
		}
	}
	return { tries, ways: names };
}

const KINDS = ["body text", "layout block", "page setup", "header", "footer", "after Save"];

test("AC:DOC-EDIT-LEAVE: every in-app way out asks after every kind of edit, 20 rounds in a row, at 1440 px", async () => {
	await onPage(async (page) => {
		const { tries, ways } = await guardHolds(page, { width: 1440 }, KINDS);
		assert.equal(tries, KINDS.length * ROUNDS * ways.length);
		console.log(`1440 px: ${tries} tries, no miss; ways out: ${ways.join("; ")}`);
	});
});

test("AC:DOC-EDIT-LEAVE: every in-app way out asks after every kind of edit, 20 rounds in a row, at 390 px", async () => {
	await onPage(
		async (page) => {
			const { tries, ways } = await guardHolds(page, { width: 390 }, KINDS);
			assert.equal(tries, KINDS.length * ROUNDS * ways.length);
			console.log(`390 px: ${tries} tries, no miss; ways out: ${ways.join("; ")}`);
		},
		{ width: 390, height: 844 },
	);
});

test("AC:DOC-EDIT-LEAVE-RACE: an edit and the way out in the same task still ask, 20 times for each way out", async () => {
	await onPage(async (page) => {
		await fork(page);
		const path = new URL(page.url()).pathname;
		const hrefs = ["/documents", "/documents/church", "/people", "/settings"];
		for (let round = 0; round < ROUNDS; round++) {
			for (const href of [...hrefs, "back"]) {
				await status(page)
					.filter({ hasText: /^Saved/ })
					.waitFor();
				const saved = await json(page);
				await page.locator(PAPER).evaluate((el, to) => {
					el.editor.commands.insertContentAt(1, "r");
					if (to === "back") history.back();
					else document.querySelector(`a[href="${to}"]`).click();
				}, href);
				await ask(page)
					.waitFor({ timeout: 5_000 })
					.catch(() => assert.fail(`round ${round + 1}, ${href}: left with no dialog (${page.url()})`));
				await ask(page).getByRole("button", { name: "Cancel" }).click();
				await ask(page).waitFor({ state: "detached" });
				assert.equal(new URL(page.url()).pathname, path);
				await backToSaved(page, saved);
			}
		}
	});
});
