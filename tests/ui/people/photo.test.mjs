// T-144 (people/peo-51, peo-52) on the real server, seeded by tests/ui/people/seed.mts, Chromium only: the person photo
// (REQ-PPL-005) through the person page header.
//   A 1.5 MB JPEG saves: the header shows the saved version from the app's own photo route.
//   A replay after a lost answer: the server saved the photo but its answer never arrived; the save lane sends the same
//     request key again and the page says the photo saved, showing the version the first send stored.
//   A photo of exactly 3 MiB (PHOTO_MAX_BYTES) reaches the server and saves; the server action body limit does not
//     refuse it. A file one byte over, sent to the same action without the page's own check, is refused as invalid
//     input by the action, not by the transport.
// PHOTO_SHOTS names the directory for the 390 and 1440 px screenshots (default /tmp/everyfield-photo-shots).
//   UI_BASE_URL=https://wp-....localhost:1355 UI_ENGINE=chromium node --test tests/ui/people/photo.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const SHOTS = process.env.PHOTO_SHOTS ?? "/tmp/everyfield-photo-shots";
mkdirSync(SHOTS, { recursive: true });
const sharp = createRequire(import.meta.url)("../../../apps/web/node_modules/sharp");
const MiB = 1024 * 1024;

/** A valid JPEG of exactly `size` bytes: a photo-sized image padded with comment segments after its start marker. */
async function jpegOf(size, background) {
	const image = await sharp({ create: { width: 480, height: 480, channels: 3, background } })
		.jpeg()
		.toBuffer();
	const parts = [image.subarray(0, 2)];
	for (let left = size - image.length; left > 0; ) {
		const payload = Math.min(65533, left - 4);
		const segment = Buffer.alloc(4 + payload, 0x20);
		segment.writeUInt16BE(0xfffe, 0);
		segment.writeUInt16BE(payload + 2, 2);
		parts.push(segment);
		left -= segment.length;
	}
	parts.push(image.subarray(2));
	const buffer = Buffer.concat(parts);
	assert.equal(buffer.length, size);
	return { name: "photo.jpg", mimeType: "image/jpeg", buffer };
}

async function addPerson(page, name) {
	await page.goto(`${BASE}/people`);
	await hydrated(page);
	await page.getByRole("button", { name: "Add person" }).first().click();
	const dialog = page.getByRole("dialog", { name: "Add a person" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Add person" }).click();
	await page.getByRole("heading", { level: 1, name }).waitFor({ timeout: 30_000 });
	return page.url().split("/").pop();
}

/** Picks `file` from the header's photo menu and waits for "Photo saved." and the saved version in the header. */
async function pickPhoto(page, name, file) {
	await page.getByRole("button", { name: new RegExp(`^(Add|Change) photo of ${name}$`) }).click();
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("menuitem", { name: /^(Upload a photo|Replace photo)$/ }).click();
	await (await chooser).setFiles(file);
	await page.getByText("Photo saved.").first().waitFor({ timeout: 60_000 });
	const img = page.getByRole("button", { name: `Change photo of ${name}` }).locator('img[src*="/photo/"]');
	await img.waitFor({ timeout: 30_000 });
	return img.getAttribute("src");
}

async function shots(page, name) {
	for (const [width, height] of [
		[390, 844],
		[1440, 900],
	]) {
		await page.setViewportSize({ width, height });
		await page.screenshot({ path: `${SHOTS}/${name}-${width}.png` });
	}
}

const [, chromium] = ENGINES.find(([engine]) => engine === "chromium") ?? [];
const isUpload = (r) =>
	r.method() === "POST" && r.headers()["next-action"] && (r.postDataBuffer()?.includes('_file"') ?? false);

test("peo-51 peo-52 a photo over 1 MB saves, a replay after a lost answer says saved, and 3 MiB reaches the server", async (t) => {
	if (!chromium) return t.skip("Chromium only");
	const { owner } = fixture("people");
	await withPage(chromium, async (page, context) => {
		await signIn(context, owner.cookie);

		// A 1.5 MB JPEG saves, and the header shows the saved version.
		const first = `Photo ${Date.now().toString(36)}`;
		const firstId = await addPerson(page, first);
		const photo = await jpegOf(1_500_000, "#2e7d32");
		assert.ok(photo.buffer.length > MiB, "the fixture is over 1 MB");
		const saved = await pickPhoto(page, first, photo);
		assert.match(saved, new RegExp(`^/people/${firstId}/photo/[0-9a-f-]{36}$`));
		const served = await page.request.get(BASE + saved);
		assert.equal(served.status(), 200);
		assert.equal((await served.body()).length, photo.buffer.length);
		await shots(page, "photo-saved");
		await page.setViewportSize({ width: 1440, height: 900 });

		// The first send reaches the server and saves; its answer is lost. The lane sends the same key again.
		const sent = [];
		await context.route("**/*", async (route) => {
			const r = route.request();
			if (!isUpload(r)) return route.fallback();
			sent.push(r.postDataBuffer());
			if (sent.length > 1) return route.continue();
			await route.fetch();
			return route.abort("failed");
		});
		const second = `Replay ${Date.now().toString(36)}`;
		await addPerson(page, second);
		const replayed = await pickPhoto(page, second, await jpegOf(1_200_000, "#1f4e79"));
		assert.equal(sent.length, 2, "one send, then one replay");
		const key = (body) => /name="1_requestKey"\r\n\r\n([^\r]+)/.exec(body.toString("latin1"))?.[1];
		assert.ok(key(sent[0]));
		assert.equal(key(sent[1]), key(sent[0]), "the replay carries the same request key");
		await page.reload();
		await hydrated(page);
		const after = page.getByRole("button", { name: `Change photo of ${second}` }).locator('img[src*="/photo/"]');
		assert.equal(await after.getAttribute("src"), replayed, "the saved photo is the one the page showed");
		await shots(page, "photo-replayed");
		await page.setViewportSize({ width: 1440, height: 900 });
		await context.unroute("**/*");

		// Exactly 3 MiB passes the server action's body limit and saves.
		const third = `Largest ${Date.now().toString(36)}`;
		const thirdId = await addPerson(page, third);
		let action = null;
		page.on("request", (r) => {
			if (isUpload(r)) action = r.headers()["next-action"];
		});
		await pickPhoto(page, third, await jpegOf(3 * MiB, "#d4a017"));
		assert.ok(action);

		// One byte over, sent straight to the action as the page would send it: the action itself refuses it.
		const over = await page.evaluate(
			async ({ action, personId, size }) => {
				const f = new FormData();
				f.set("1_requestKey", crypto.randomUUID());
				f.set("1_expectedRevision", "1");
				f.set("1_personId", personId);
				f.set("1_file", new File([new Uint8Array(size)], "big.jpg", { type: "image/jpeg" }));
				f.set("0", '["$K1"]');
				const r = await fetch(location.href, {
					method: "POST",
					headers: { "Next-Action": action, Accept: "text/x-component" },
					body: f,
				});
				return { status: r.status, body: await r.text() };
			},
			{ action, personId: thirdId, size: 3 * MiB + 1 },
		);
		assert.equal(over.status, 200, over.body.slice(0, 300));
		assert.match(over.body, /"code":"invalid_input"/);
	});
});
