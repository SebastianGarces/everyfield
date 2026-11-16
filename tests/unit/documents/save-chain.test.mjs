import assert from "node:assert/strict";
import { test } from "node:test";
import { SaveChain, saveAndLeave } from "../../../apps/web/src/features/documents/save-chain.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function editor({ withTitle }) {
	const chain = new SaveChain();
	const page = { body: "Opening line.", title: "Plan" };
	const state = { stored: { ...page } };
	const sent = [];
	const held = [];
	const flight = { now: 0, most: 0 };
	const now = () =>
		chain.start(async () => {
			const copy = { ...page };
			sent.push(copy);
			flight.most = Math.max(flight.most, ++flight.now);
			const ok = await new Promise((resolve) => held.push(resolve));
			flight.now--;
			if (ok) state.stored = copy;
			return ok;
		});
	const onScreenSaved = () =>
		page.body === state.stored.body && (!withTitle || page.title.trim() === state.stored.title);
	const save = () => chain.save(onScreenSaved, now);
	const left = [];
	const leave = () => saveAndLeave(save, (go) => left.push(go));
	return { page, state, sent, flight, save, leave, left, answer: (i, ok) => held[i](ok) };
}

for (const [name, withTitle] of [
	["written document", true],
	["Church Document", false],
]) {
	test(`INV-save-order: ${name}: Save and leave during a save in flight waits for it, saves the later text, then leaves`, async () => {
		const ed = editor({ withTitle });
		ed.page.body += " First edit.";
		const first = ed.save();
		ed.page.body += " Typed later.";
		if (withTitle) ed.page.title = "Plan for spring";
		const leaving = ed.leave();
		await tick();
		assert.equal(ed.sent.length, 1, "no second save starts while the first is in flight");
		assert.deepEqual(ed.left, [], "the page does not leave while the first save is in flight");
		ed.answer(0, true);
		assert.equal(await first, true);
		await tick();
		assert.equal(ed.sent.length, 2, "the text typed after the first save started gets a save of its own");
		assert.equal(ed.sent[1].body, "Opening line. First edit. Typed later.");
		if (withTitle) assert.equal(ed.sent[1].title, "Plan for spring");
		assert.deepEqual(ed.left, [], "the page does not leave before the second save answers");
		ed.answer(1, true);
		await leaving;
		assert.deepEqual(ed.left, [true]);
		assert.deepEqual(ed.state.stored, ed.page, "everything on screen is stored when the page leaves");
	});

	test(`INV-save-order: ${name}: when the second save fails, the page stays`, async () => {
		const ed = editor({ withTitle });
		ed.page.body += " First edit.";
		void ed.save();
		ed.page.body += " Typed later.";
		const leaving = ed.leave();
		ed.answer(0, true);
		await tick();
		ed.answer(1, false);
		await leaving;
		assert.deepEqual(ed.left, [false]);
		assert.equal(ed.state.stored.body, "Opening line. First edit.");
	});

	test(`INV-save-order: ${name}: when the save in flight fails, the page stays and nothing else is sent`, async () => {
		const ed = editor({ withTitle });
		ed.page.body += " First edit.";
		void ed.save();
		ed.page.body += " Typed later.";
		const leaving = ed.leave();
		ed.answer(0, false);
		await leaving;
		assert.deepEqual(ed.left, [false]);
		assert.equal(ed.sent.length, 1);
	});
}

test("INV-save-order: a save and Save and leave both waiting on one save in flight send one more save, never two at once", async () => {
	const ed = editor({ withTitle: false });
	ed.page.body += " First edit.";
	void ed.save();
	ed.page.body += " Typed later.";
	const again = ed.save();
	const leaving = ed.leave();
	ed.answer(0, true);
	await tick();
	assert.equal(ed.sent.length, 2, "only one of the two waiting saves sends the later text");
	assert.equal(ed.flight.most, 1, "no two saves are in flight at once");
	ed.answer(1, true);
	assert.equal(await again, true);
	await leaving;
	assert.deepEqual(ed.left, [true]);
});
