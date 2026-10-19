// INV-onboarding-model: the onboarding rules (apps/web/src/features/onboarding/model.ts) over random interleavings of
// edits, Continue (also twice), Back, step jumps, a second person's change and server replies that accept, refuse
// for a stale revision, fail for a moment or arrive after the person moved on. A small server below keeps the WP-009
// API rules the screens depend on. After every step:
//   1. at most one request is on the wire, so a second Continue never sends a second request;
//   2. a retry of the same payload after a temporary failure reuses its request key; any other payload gets a new one;
//   3. the facts the screen shows equal the server's facts after every reply (they come only from replies);
//   4. a journey request carries a phase only for an explicit existing-phase choice: not sure, discerning and skip
//      never become Phase 0, and the actual phase stays where creation put it;
//   5. nothing is sent once a phase is declared (journey) or a lead role assigned (lead), and finish stamps once;
//   6. after creation, Your church never offers the basics form again, and a second creation is never sent.
// No browser needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	begin,
	editDrafts,
	initialState,
	journeyInput,
	launchInput,
	leadInput,
	basicsInput,
	needsReload,
	reload,
	setView,
	settle,
	stable,
} from "../../../apps/web/src/features/onboarding/model.ts";

const PLANT = "11111111-1111-4111-8111-111111111111";
const ERR = (code, retry) => ({ code, details: {}, correlationId: "22222222-2222-4222-8222-222222222222", retry });

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** The server: replay by request key, revision checks, once-only declaration and completion. */
function server() {
	const s = {
		created: false,
		accountRevision: "1",
		resume: null,
		declared: false,
		completed: false,
		replays: new Map(),
		creations: 0,
		declarations: 0,
		leadYes: 0,
		completions: 0,
	};
	const fresh = () => ({
		status: "available",
		basics: "created",
		plant: { kind: "plant", id: PLANT },
		revision: "1",
		materialRevision: "1",
		currentPhase: 1,
		lead: { answer: "pending" },
		journey: { status: "pending" },
		launch: { status: "pending" },
		scheduledLaunchDate: null,
		peopleStep: "pending",
		completion: { status: "unfinished" },
		reading: { status: "incomplete" },
		values: "missing",
	});
	const bump = () => (s.resume.revision = String(Number(s.resume.revision) + 1));
	function act(op, cmd) {
		if (op === "createPlant") {
			if (s.created) return { refused: "active_seat_conflict" };
			if (cmd.expectedRevision !== s.accountRevision) return { refused: "conflict" };
			s.created = true;
			s.creations++;
			s.resume = fresh();
			return { value: { status: "created" } };
		}
		if (cmd.expectedRevision !== s.resume.revision) return { refused: "conflict" };
		if (op === "declareJourney") {
			const { journey, launch } = cmd.input;
			if (journey.answer === "existing") {
				if (s.declared) return { refused: "already_declared" };
				s.declared = true;
				s.declarations++;
				s.resume.currentPhase = journey.phase;
			}
			if (launch.answer === "planned") s.resume.scheduledLaunchDate = launch.date;
			s.resume.journey = { status: "saved", value: journey, savedAt: "2026-10-18T00:00:00.000Z" };
			s.resume.launch = { status: "saved", value: launch, savedAt: "2026-10-18T00:00:00.000Z" };
			bump();
			const r = s.resume;
			return {
				value: {
					plant: r.plant,
					revision: r.revision,
					currentPhase: r.currentPhase,
					journey: r.journey,
					launch: r.launch,
					scheduledLaunchDate: r.scheduledLaunchDate,
				},
			};
		}
		if (op === "answerLead") {
			if (cmd.input.answer === "yes") s.leadYes++;
			s.resume.lead =
				cmd.input.answer === "yes"
					? { answer: "yes", assignment: { teamId: PLANT, roleId: PLANT, personId: PLANT }, savedAt: "x" }
					: { answer: cmd.input.answer, savedAt: "x" };
			bump();
			return { value: { plant: s.resume.plant, revision: s.resume.revision, lead: s.resume.lead } };
		}
		if (!s.completed) {
			s.completed = true;
			s.completions++;
			bump();
			s.resume.completion = { status: "completed", completedAt: "x", materialRevision: s.resume.revision };
		}
		return { value: { plant: s.resume.plant, revision: s.resume.revision, completion: s.resume.completion } };
	}
	s.call = (op, cmd, fault) => {
		if (fault) return { status: "refused", error: ERR(fault, fault === "temporary" ? "same_request" : "refresh") };
		const digest = stable({ op, cmd });
		const old = s.replays.get(cmd.requestKey);
		if (old)
			return old.digest === digest ? old.reply : { status: "refused", error: ERR("idempotency_conflict", "never") };
		const out = act(op, cmd);
		const reply = out.refused
			? { status: "refused", error: ERR(out.refused, out.refused === "active_seat_conflict" ? "refresh" : "refresh") }
			: { status: "ok", value: out.value };
		if (!out.refused) s.replays.set(cmd.requestKey, { digest, reply });
		return reply;
	};
	s.entry = () =>
		s.created
			? { kind: "plant", plantName: "Harvest Point", resume: structuredClone(s.resume) }
			: { kind: "start", offer: "planter", accountRevision: s.accountRevision };
	return s;
}

const JOURNEYS = [
	{ answer: "existing", phase: 0 },
	{ answer: "existing", phase: 3 },
	{ answer: "existing", phase: 6 },
	{ answer: "unsure" },
	{ answer: "discerning" },
	{ answer: "skip" },
];
const LAUNCHES = [{ answer: "planned", date: "2027-09-12" }, { answer: "no_date" }, { answer: "skip" }];
const LEADS = [
	{ answer: "yes", roleName: "Lead pastor", teamName: "Leadership" },
	{ answer: "no" },
	{ answer: "skip" },
];
const VIEWS = ["church", "journey", "launch", "team", "finish"];

function run(seed) {
	const random = rng(seed);
	const pick = (list) => list[Math.floor(random() * list.length)];
	const srv = server();
	let state = initialState(srv.entry(), null);
	let keys = 0;
	let wire = null; // { op, cmd, fault }
	let lastTemporary = null; // { op, digest, requestKey } of a payload that failed for a moment
	const sentJourneys = [];
	const facts = () => (state.entry.kind === "plant" ? state.entry.resume : null);

	function send(op, input) {
		const before = state;
		const out = begin(state, op, input, () => `key-${++keys}`);
		state = out.state;
		if (!("send" in out)) return out.hold;
		assert.equal(wire, null, "invariant 1: a second command was sent while one is on the wire");
		assert.equal(before.pending, null);
		const digest = stable({ op, input, revision: out.send.expectedRevision });
		if (lastTemporary && lastTemporary.op === op && lastTemporary.digest === digest)
			assert.equal(out.send.requestKey, lastTemporary.requestKey, "invariant 2: a retry must reuse its request key");
		else if (lastTemporary)
			assert.notEqual(out.send.requestKey, lastTemporary.requestKey, "invariant 2: new payload, new key");
		if (op === "declareJourney") sentJourneys.push(out.send.input.journey);
		if (op === "createPlant") assert.equal(srv.created, false, "invariant 6: a second creation was sent");
		wire = { op, cmd: out.send, digest, fault: random() < 0.15 ? pick(["temporary", "conflict"]) : null };
		return "sent";
	}
	function deliver() {
		const { op, cmd, digest, fault } = wire;
		wire = null;
		const reply = srv.call(op, cmd, fault);
		const settled = { op, reply };
		const fresh = needsReload(settled) ? srv.entry() : null;
		state = settle(state, settled, fresh);
		lastTemporary =
			reply.status === "refused" && reply.error.retry === "same_request"
				? { op, digest, requestKey: cmd.requestKey }
				: null;
		// After an accepted reply or a reload the screen holds exactly the server facts.
		if ((reply.status === "ok" || fresh) && state.entry.kind === "plant" && srv.resume) {
			const shown = facts();
			for (const key of ["revision", "currentPhase", "journey", "launch", "lead", "completion", "scheduledLaunchDate"])
				assert.deepEqual(shown[key], srv.resume[key], `invariant 3: ${key} differs from the server after ${op}`);
		}
	}

	for (let step = 0; step < 60; step++) {
		const roll = random();
		if (wire && roll < 0.35) deliver();
		else if (roll < 0.45) state = setView(state, pick(VIEWS));
		else if (roll < 0.5 && srv.resume) {
			srv.resume.revision = String(Number(srv.resume.revision) + 1); // another tab saved something
		} else if (roll < 0.55) state = reload(state, srv.entry());
		else if (state.entry.kind === "start") {
			state = editDrafts(state, {
				basics: { name: " Harvest Point ", city: "Boston", stateProvince: "", country: "", confirmed: true },
			});
			send("createPlant", basicsInput(state.drafts.basics));
		} else if (state.entry.kind === "plant") {
			const r = state.entry.resume;
			const which = pick(["journey", "lead", "complete", "double"]);
			if (which === "journey" || which === "double") {
				const j = pick(JOURNEYS);
				const l = pick(LAUNCHES);
				state = editDrafts(state, { journey: j, launch: l });
				const held = send("declareJourney", { journey: journeyInput(j), launch: launchInput(l) });
				if (which === "double") send("declareJourney", { journey: journeyInput(j), launch: launchInput(l) });
				if (r.journey.status === "saved" && r.journey.value.answer === "existing")
					assert.notEqual(held, "sent", "invariant 5: a declared journey was sent again");
			} else if (which === "lead") {
				const held = send("answerLead", leadInput(pick(LEADS)));
				if (r.lead.answer === "yes") assert.notEqual(held, "sent", "invariant 5: a second lead yes was sent");
			} else {
				const held = send("complete", {});
				if (r.completion.status === "completed") assert.notEqual(held, "sent", "invariant 5: finish sent twice");
			}
			assert.notEqual(state.entry.kind, "start", "invariant 6: basics form after creation");
		}
	}
	if (wire) deliver();

	for (const j of sentJourneys) {
		if (j.answer !== "existing") assert.equal("phase" in j, false, "invariant 4: a non-attestation carried a phase");
	}
	if (srv.resume && srv.declarations === 0)
		assert.equal(srv.resume.currentPhase, 1, "invariant 4: phase moved without a declaration");
	assert.ok(
		srv.creations <= 1 && srv.declarations <= 1 && srv.leadYes <= 1 && srv.completions <= 1,
		"invariant 5/6: once-only effect repeated",
	);
	return { requests: keys, created: srv.created };
}

test("INV-onboarding-model: rules hold over 3000 random interleavings", () => {
	let created = 0;
	for (let seed = 1; seed <= 3000; seed++) if (run(seed).created) created++;
	assert.ok(created > 2500, `most runs create a church (${created})`);
});

test("INV-onboarding-model: not sure, discerning and skip carry no phase", () => {
	assert.deepEqual(journeyInput({ answer: "unsure" }), { answer: "unsure" });
	assert.deepEqual(journeyInput({ answer: "discerning" }), { answer: "discerning" });
	assert.deepEqual(journeyInput({ answer: "skip" }), { answer: "skip" });
	assert.deepEqual(journeyInput({ answer: "existing", phase: 0 }), { answer: "existing", phase: 0 });
});
