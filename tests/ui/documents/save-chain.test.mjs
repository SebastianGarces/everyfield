// T-120, kept by T-237 and moved out of the browser suite by T-259: "Save and leave" picked while a save is in flight
// in the written-document editor (NativeEditor) and the Church Document editor (ChurchEditor). Both editors save through
// SaveChain and their leave dialog (LeaveDialog) through saveAndLeave. A silent break would leave the page with the text
// typed after the first save started unsaved, or leave before that text is stored. These tests drive the real module
// in node; each save's send is held until the test releases it with the server's answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SaveChain, saveAndLeave } from "../../../apps/web/src/features/documents/save-chain.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * An editor as both editors wire the chain: `page` is what is on screen, `stored` the last saved copy. A save sends a
 * copy of the page as it is when the save starts. The written document also counts its title as unsaved; the Church
 * Document has no title field. `answer(i, ok)` releases the i-th save with the server's answer.
 */
function editor({ withTitle }) {
	const chain = new SaveChain();
	const page = { body: "Opening line.", title: "Plan" };
	const state = { stored: { ...page } };
	const sent = [];
	const held = [];
	const now = () =>
		chain.start(async () => {
			const copy = { ...page };
			sent.push(copy);
			const ok = await new Promise((resolve) => held.push(resolve));
			if (ok) state.stored = copy;
			return ok;
		});
	const onScreenSaved = () =>
		page.body === state.stored.body && (!withTitle || page.title.trim() === state.stored.title);
	const save = () => chain.save(onScreenSaved, now);
	const left = [];
	const leave = () => saveAndLeave(save, (go) => left.push(go));
	return { chain, page, state, sent, save, leave, left, answer: (i, ok) => held[i](ok) };
}

for (const [name, withTitle] of [
	["written document", true],
	["Church Document", false],
]) {
	test(`${name}: Save and leave during a save in flight waits for it, saves the later text, then leaves`, async () => {
		const ed = editor({ withTitle });
		ed.page.body += " First edit.";
		const first = ed.save();
		assert.equal(ed.chain.busy, true, "the page counts as unsaved while the save is in flight");
		// Typed while the first save runs: that save carries "First edit." only.
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
		assert.equal(ed.chain.busy, false);
	});

	test(`${name}: when the second save fails, the page stays`, async () => {
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

	test(`${name}: when the save in flight fails, the page stays and nothing else is sent`, async () => {
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

test("with nothing typed after the save in flight, Save and leave leaves once it answers and sends nothing more", async () => {
	const ed = editor({ withTitle: true });
	ed.page.body += " First edit.";
	void ed.save();
	const leaving = ed.leave();
	ed.answer(0, true);
	await leaving;
	assert.deepEqual(ed.left, [true]);
	assert.equal(ed.sent.length, 1);
});

test("a save and Save and leave both waiting on one save in flight send one more save between them, not two", async () => {
	const ed = editor({ withTitle: false });
	ed.page.body += " First edit.";
	void ed.save();
	ed.page.body += " Typed later.";
	// Cmd+S and then Save and leave, both while the first save runs.
	const again = ed.save();
	const leaving = ed.leave();
	ed.answer(0, true);
	await tick();
	assert.equal(ed.sent.length, 2, "only one of the two waiting saves sends the later text");
	ed.answer(1, true);
	assert.equal(await again, true);
	await leaving;
	assert.deepEqual(ed.left, [true]);
	assert.equal(ed.sent.length, 2);
});

test("a save that throws keeps the page instead of locking the dialog", async () => {
	const left = [];
	await saveAndLeave(
		() => Promise.reject(new Error("network")),
		(go) => left.push(go),
	);
	assert.deepEqual(left, [false]);
});
