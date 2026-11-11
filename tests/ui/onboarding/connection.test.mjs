// BUG-T130: an Owner saves a planned launch date as often as they like, and a reply lost to a dropped connection reads
// as "not sure it saved", keeps the request key and leaves the step as it was. These tests drive the real port
// (createPort, runCommand); the design preview's fixture API stands in for the server. No browser needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	editDrafts,
	initialState,
	journeyInput,
	launchInput,
	setView,
	shownLaunch,
} from "../../../apps/web/src/features/onboarding/model.ts";
import { createPort, runCommand } from "../../../apps/web/src/features/onboarding/port.ts";
import { createFixturePort } from "../../../apps/web/src/features/onboarding/preview/fixtures.ts";

const OPS = ["createPlant", "createDiscovery", "convertDiscovery", "declareJourney", "answerLead", "complete"];
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

function cell(state) {
	let current = state;
	return { get: () => current, set: (next) => void (current = next) };
}
let keys = 0;
const newKey = () => `key-${++keys}`;
const signIn = () => assert.fail("no reload here is signed out");

/** A planned date on the launch step, with the phase answer it saves with. */
function planned(c, date) {
	c.set(editDrafts(c.get(), { journey: { answer: "unsure" }, launch: { answer: "planned", date } }));
	c.set(setView(c.get(), "launch"));
	const s = c.get();
	return {
		journey: journeyInput(s.drafts.journey),
		launch: launchInput(s.drafts.launch, s.entry.resume.scheduleRevision),
	};
}

test("BUG-T130: an Owner saves a planned launch date four times in a row and the step shows the latest", async () => {
	const fixture = createFixturePort("created", { delay: 0 });
	const c = cell(initialState(fixture.entry, "journey"));
	for (const date of ["2027-03-07", "2027-04-11", "2027-05-16", "2027-06-20"]) {
		assert.equal(await runCommand(fixture.port, c, "declareJourney", planned(c, date), newKey, signIn), "ok", date);
		const s = c.get();
		assert.equal(s.notice, null);
		assert.equal(s.entry.resume.scheduledLaunchDate, date);
		assert.deepEqual(shownLaunch(setView(s, "launch")), { answer: "planned", date });
	}
	const sent = fixture.controls.calls.map((call) => call.command.input.launch.expectedScheduleRevision);
	assert.deepEqual(sent, ["1", "1", "2", "3"], "each save sends the schedule revision of the reply before it");
	const load = await fixture.port.entry();
	assert.equal(load.entry.resume.scheduledLaunchDate, "2027-06-20");
	assert.equal(load.entry.resume.scheduleRevision, "4");
});

test("BUG-T130: a thrown server action on any onboarding command reads as unknown with retry reconcile", async () => {
	const port = createPort({ entry: offline, command: offline });
	for (const op of OPS) {
		const reply = await port.command(op, { requestKey: "k", expectedRevision: "1", input: {} });
		assert.equal(reply.status, "refused", op);
		assert.equal(reply.error.code, "unknown", op);
		assert.equal(reply.error.retry, "reconcile", op);
		assert.deepEqual(reply.error.details, {});
	}
	assert.deepEqual(await port.entry(), { kind: "offline" });
});

test("BUG-T130: a reply that arrived but is malformed still reads as unavailable", async () => {
	const replies = [
		null,
		"oops",
		{ status: "ok", value: { nope: true } },
		{ status: "refused", error: null },
		{ status: "refused", error: { code: "made_up", details: {}, correlationId: "x", retry: "never" } },
	];
	for (const raw of replies)
		for (const op of OPS) {
			const port = createPort({ entry: async () => raw, command: async () => raw });
			const reply = await port.command(op, { requestKey: "k", expectedRevision: "1", input: {} });
			assert.equal(reply.status, "refused", `${op} ${JSON.stringify(raw)}`);
			assert.equal(reply.error.code, "unavailable");
			assert.equal(reply.error.retry, "never");
		}
	// An entry reply that arrived malformed is still the unavailable entry, not offline.
	const port = createPort({ entry: async () => ({ kind: "nope" }), command: offline });
	assert.deepEqual(await port.entry(), { kind: "entry", entry: { kind: "elsewhere", reason: "unavailable" } });
});

test("BUG-T130: a dropped connection keeps the step, drafts and request key; the retry replays instead of saving twice", async () => {
	// The server saves, then the connection drops before the reply arrives and stays down for the reload.
	const server = createFixturePort("created", { delay: 0 });
	let drop = "command";
	const port = createPort({
		async entry() {
			if (drop === "entry") {
				drop = null;
				return offline();
			}
			return (await server.port.entry()).entry;
		},
		async command(op, cmd) {
			const reply = await server.port.command(op, cmd);
			if (drop !== "command") return reply;
			drop = "entry";
			return offline();
		},
	});
	const c = cell(initialState(server.entry, "journey"));
	const input = planned(c, "2027-03-07");
	const before = c.get();

	assert.equal(await runCommand(port, c, "declareJourney", input, newKey, signIn), "refused");
	const after = c.get();
	assert.deepEqual(after.notice, { op: "declareJourney", code: "unknown", reloaded: false });
	assert.equal(after.view, "launch", "the person stays on their step");
	assert.equal(after.entry, before.entry, "not moved to the unavailable entry");
	assert.deepEqual(after.drafts, before.drafts);
	assert.equal(after.pending, null);
	assert.ok(after.intent, "the intent survives for the retry");

	assert.equal(await runCommand(port, c, "declareJourney", input, newKey, signIn), "ok");
	const [first, retry] = server.controls.calls;
	assert.equal(retry.requestKey, first.requestKey, "the retry sends the same request key");
	assert.equal(server.controls.calls.length, 2);
	assert.equal(c.get().notice, null);
	assert.equal(c.get().entry.resume.scheduledLaunchDate, "2027-03-07");
	assert.equal(c.get().entry.resume.revision, "2", "the plant moved once: the retry replayed the first save");
});

test("BUG-T130: when the reload after a lost reply arrives, the notice says the latest was loaded", async () => {
	const server = createFixturePort("created", { delay: 0 });
	let drop = true;
	const port = createPort({
		entry: async () => (await server.port.entry()).entry,
		command(op, cmd) {
			if (!drop) return server.port.command(op, cmd);
			drop = false;
			return offline();
		},
	});
	const c = cell(initialState(server.entry, "finish"));
	assert.equal(await runCommand(port, c, "complete", {}, newKey, signIn), "refused");
	assert.deepEqual(c.get().notice, { op: "complete", code: "unknown", reloaded: true });
	assert.equal(c.get().entry.kind, "plant");
	assert.equal(c.get().view, "finish");
});
