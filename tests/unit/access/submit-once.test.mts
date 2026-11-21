import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccessFormStore } from "../../../apps/web/src/access/AccessForm.store.ts";

test("INV-one-submit: three submits fired in one task send one request, and the next submit after it settles sends again", async () => {
	const store = createAccessFormStore();
	const { send } = store.getState().actions;
	let sent = 0;
	let answer = () => {};
	const request = () => {
		sent += 1;
		return new Promise<void>((resolve) => {
			answer = resolve;
		});
	};

	const submits = [send(request), send(request), send(request)];
	assert.equal(sent, 1);
	assert.equal(store.getState().sending, true);

	answer();
	await Promise.all(submits);
	assert.equal(store.getState().sending, false);

	const again = send(request);
	assert.equal(sent, 2);
	answer();
	await again;
});

test("INV-one-submit: a request that fails frees the form for the next submit", async () => {
	const store = createAccessFormStore();
	const { send } = store.getState().actions;
	await assert.rejects(send(() => Promise.reject(new Error("offline"))));
	assert.equal(store.getState().sending, false);
	let sent = 0;
	await send(async () => {
		sent += 1;
	});
	assert.equal(sent, 1);
});
