import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { MAX_DESCRIPTION, normalizeDescription } from "../../../packages/contracts/src/tasks/index.ts";
import {
	CATALOG,
	createTaskWriter,
	createTemplateReader,
	taskReader,
	withTaskWrite,
} from "../../../packages/domain/src/tasks/index.ts";
import { createPhaseWriter } from "../../../packages/domain/src/phases/index.ts";
import { recommendForPhase } from "../../../packages/domain/src/wiki/reads.ts";

// WP-026: phase checklists. Browse, preview and import the fixed catalog (TSK-009), answer a phase move's offer
// (TSK-010, PHASE-006) and keep every description safe Markdown (TSK-016). Each church plant is new, so every count
// below belongs to the test that reads it.

let f, writer, templates, phases, plant, owner, admin, member;
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const refused = (r, code) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
	return r.error;
};
const rows = async (q) => (await f.admin.execute(q)).rows;
const write = (who, op, input, w = writer) => withTaskWrite(f.db, who.actor, (tx, ctx) => w[op](tx, ctx, input));
const read = (who, op, input, r = templates) => f.db.transaction((tx) => r[op](tx, who.actor, input));
const importing = (who, checklistKey, requestKey = randomUUID(), extra = {}) => {
	const checklist = CATALOG.checklists.find((k) => k.key === checklistKey);
	return write(who, "importTemplate", {
		requestKey,
		input: {
			catalogVersion: CATALOG.version,
			checklistKey,
			itemKeys: checklist ? checklist.items.map((i) => i.key) : ["set-date"],
			...extra,
		},
	});
};
const accept = (who, transitionId, checklistKeys, requestKey = randomUUID()) =>
	write(who, "acceptPhaseOffer", {
		requestKey,
		input: { transitionId, catalogVersion: CATALOG.version, checklistKeys },
	});
const decline = (who, transitionId, requestKey = randomUUID()) =>
	write(who, "declinePhaseOffer", { requestKey, input: { transitionId } });
/** Every row an import or an answer could add or change in this plant. */
const footprint = async (w) =>
	(
		await rows(sql`SELECT (SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM task_assignee WHERE plant_id=${w.id}) assignees,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${w.id}) audits,
		(SELECT count(*)::int FROM phase_transition WHERE plant_id=${w.id} AND offer_answer IS NOT NULL) answered`)
	)[0];
// Statements this test's runtime pool sends while `body` runs.
let statements = 0;
async function counted(body) {
	const start = statements;
	await body();
	return statements - start;
}

/** The plant-local date `days` after today in Chicago, worked out apart from the code under test. */
const chicago = (at: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(at);
const plus = (date, days) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};

async function seated(w, role) {
	const a = await f.account();
	const seatId = await f.seat(a, w, role);
	return { ...a, seatId, actor: await f.actor(a.session) };
}
/** A Chicago church plant at Phase 1, with an Owner, an Admin and a Member. */
async function church() {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	return { w, owner: await seated(w, "owner"), admin: await seated(w, "admin"), member: await seated(w, "member") };
}
const revisionOf = async (w) => (await rows(sql`SELECT revision::text r FROM plant WHERE id=${w.id}`))[0].r;
/** An actual phase move by the church's Owner, through the WP-038 writer; returns the transition row. */
async function move(c, toPhase) {
	ok(
		await phases.transition(f.db, c.owner.actor, {
			requestKey: randomUUID(),
			expectedRevision: await revisionOf(c.w),
			input: { toPhase, reason: "The core group is ready for the next phase" },
		}),
	);
	return (
		await rows(sql`SELECT id, kind, to_phase, (occurred_at AT TIME ZONE 'America/Chicago')::date::text AS local_date
		FROM phase_transition WHERE plant_id=${c.w.id}
		ORDER BY occurred_at DESC, id DESC LIMIT 1`)
	)[0];
}
/** The docs/reference catalog as it is written, loaded without its app imports. */
function referenceCatalog() {
	const ts = createRequire(new URL("../../../packages/domain/package.json", import.meta.url))("typescript");
	const source = readFileSync(new URL("../../../docs/reference/task-templates.ts", import.meta.url), "utf8").replace(
		/^import .*$/gm,
		"",
	);
	const js = ts.transpileModule("const PHASES = {0:'',1:'',2:'',3:'',4:'',5:'',6:''};\n" + source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const m = { exports: {} };
	new Function("module", "exports", js)(m, m.exports);
	return m.exports.TASK_TEMPLATES;
}
/** A later catalog: changed wording and offsets for every item, under a raised version. */
const raised = {
	version: CATALOG.version + 1,
	checklists: CATALOG.checklists.map((k) => ({
		...k,
		name: k.name + " (revised)",
		items: k.items.map((i) => ({
			...i,
			title: "Revised: " + i.title,
			description: "New wording",
			offsetDays: i.offsetDays + 30,
		})),
	})),
};

before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			statements++;
			return Reflect.apply(query, this, args);
		};
	});
	writer = createTaskWriter({ reminders: async () => {} });
	templates = createTemplateReader();
	phases = createPhaseWriter({ async notices() {} });
	({ w: plant, owner, admin, member } = await church());
});
after(() => f?.close());

test("AC:TARGET-TSK-009 the catalog keeps the 20 reference checklists item by item under one version", () => {
	const reference = referenceCatalog();
	assert.equal(typeof CATALOG.version, "number");
	assert.deepEqual(
		CATALOG.checklists,
		reference.map((k) => ({
			key: k.key,
			name: k.name,
			description: k.description,
			phase: k.phase,
			category: k.category,
			items: k.items.map((i) => ({
				key: i.key,
				title: i.title,
				description: i.description ?? null,
				priority: i.priority ?? k.defaultPriority,
				offsetDays: i.offsetDays,
			})),
		})),
	);
	assert.equal(CATALOG.checklists.length, 20);
	assert.deepEqual([...new Set(CATALOG.checklists.map((k) => k.phase))], [0, 1, 2, 3, 4, 5, 6]);
});

test("AC:TARGET-TSK-009 an Owner or Admin browses all 20 checklists with the current phase; a Member is refused", async () => {
	for (const who of [owner, admin]) {
		const list = ok(await read(who, "listTemplates", {}));
		assert.equal(list.currentPhase, 1);
		assert.equal(list.catalogVersion, CATALOG.version);
		assert.deepEqual(
			list.checklists.map((k) => [k.key, k.phase, k.category, k.taskCount]),
			CATALOG.checklists.map((k) => [k.key, k.phase, k.category, k.items.length]),
		);
	}
	refused(await read(member, "listTemplates", {}), "unavailable");
	refused(await read(member, "previewTemplate", { checklistKey: "vision-meeting-preparation" }), "unavailable");
	refused(await read(member, "readPhaseOffer", {}), "unavailable");
});

test("AC:TARGET-TSK-009 a preview lists each task due from the plant-local date today and creates nothing", async () => {
	const before = await footprint(plant);
	let preview;
	const sent = await counted(async () => {
		preview = ok(await read(admin, "previewTemplate", { checklistKey: "vision-meeting-preparation" }));
	});
	const today = chicago();
	const reference = CATALOG.checklists.find((k) => k.key === "vision-meeting-preparation");
	assert.equal(preview.anchorDate, today);
	assert.equal(preview.checklist.name, "Vision Meeting Preparation");
	assert.equal(preview.checklist.taskCount, 10);
	assert.deepEqual(
		preview.checklist.tasks.map((t) => [t.key, t.title, t.description, t.priority, t.due]),
		reference.items.map((i) => [i.key, i.title, i.description ?? "", i.priority, plus(today, i.offsetDays)]),
	);
	assert.equal(preview.checklist.tasks[0].due, today);
	assert.equal(preview.checklist.tasks.find((t) => t.key === "confirm-attendance").priority, "high");
	assert.deepEqual(await footprint(plant), before);
	// One statement: the live Owner or Admin check with the plant's zone (BEGIN and COMMIT wrap the test's transaction).
	assert.equal(sent, 3);
	refused(await read(admin, "previewTemplate", { checklistKey: "no-such-checklist" }), "invalid_input");
});

test("AC:TARGET-TSK-009 an import adds exactly the previewed tasks; a retry replays it and a new import adds a second set", async () => {
	const c = await church();
	const preview = ok(await read(c.admin, "previewTemplate", { checklistKey: "vision-meeting-preparation" }));
	const key = randomUUID();
	const first = ok(await importing(c.admin, "vision-meeting-preparation", key));
	assert.deepEqual(
		first.tasks.map((t) => [t.title, t.priority, t.due, t.category, t.parentId, t.status]),
		preview.checklist.tasks.map((t) => [
			t.title,
			t.priority,
			{ kind: "local_date", date: t.due },
			"vision_meeting",
			null,
			"not_started",
		]),
	);
	for (const t of first.tasks)
		assert.deepEqual(
			t.assignees.map((a) => a.accountId),
			[c.admin.id],
		);
	// The list shows exactly that set as top-level tasks.
	const listed = ok(await f.db.transaction((tx) => taskReader.list(tx, c.admin.actor, { limit: 100 })));
	assert.deepEqual(listed.items.map((t) => t.id).sort(), first.tasks.map((t) => t.id).sort());
	const once = await footprint(c.w);
	assert.equal(once.tasks, 10);
	assert.equal(once.assignees, 10);
	// One audit record names the import; each task keeps its own creation entry for its history.
	const imports = await rows(sql`SELECT subject_id, after_value, request_key FROM audit_event
		WHERE tenant_id=${c.w.id} AND subject_type='checklist_import'`);
	assert.equal(imports.length, 1);
	assert.equal(imports[0].request_key, key);
	assert.deepEqual(
		imports[0].after_value.taskIds,
		first.tasks.map((t) => t.id),
	);
	assert.equal(imports[0].after_value.checklistKey, "vision-meeting-preparation");

	// The reply was lost: the same request key returns the same tasks and adds nothing.
	const retry = ok(await importing(c.admin, "vision-meeting-preparation", key));
	assert.deepEqual(
		retry.tasks.map((t) => t.id),
		first.tasks.map((t) => t.id),
	);
	assert.deepEqual(await footprint(c.w), once);
	// A deliberate new import is a new request key: a second, separate set.
	const second = ok(await importing(c.owner, "vision-meeting-preparation"));
	assert.equal(second.tasks.length, 10);
	assert.equal(second.tasks.filter((t) => first.tasks.some((x) => x.id === t.id)).length, 0);
	assert.equal((await footprint(c.w)).tasks, 20);
	for (const t of second.tasks)
		assert.deepEqual(
			t.assignees.map((a) => a.accountId),
			[c.owner.id],
		);
});

test("AC:TARGET-TSK-009 a stale version, an unknown key or an actor without Owner or Admin authority imports nothing", async () => {
	const c = await church();
	const before = await footprint(c.w);
	const later = createTaskWriter({ reminders: async () => {}, catalog: raised });
	const old = { catalogVersion: CATALOG.version, checklistKey: "vision-meeting-preparation", itemKeys: ["set-date"] };
	refused(await write(c.admin, "importTemplate", { requestKey: randomUUID(), input: old }, later), "stale_catalog");
	refused(await importing(c.admin, "no-such-checklist"), "invalid_input");
	refused(
		await importing(c.admin, "vision-meeting-preparation", randomUUID(), { itemKeys: ["set-date", "no-such-item"] }),
		"invalid_input",
	);
	refused(
		await importing(c.admin, "vision-meeting-preparation", randomUUID(), { catalogVersion: CATALOG.version + 1 }),
		"stale_catalog",
	);
	refused(await importing(c.member, "vision-meeting-preparation"), "unavailable");
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${c.admin.seatId}`);
	refused(await importing(c.admin, "vision-meeting-preparation"), "unavailable");
	assert.deepEqual(await footprint(c.w), before);
});

test("AC:PHASE-CASE-006 AC:TARGET-TSK-010 a real move offers the new phase's checklists and reading it creates nothing", async () => {
	const c = await church();
	// A creation-only plant, an initial declaration and a same-phase noop have no offer.
	assert.deepEqual(ok(await read(c.owner, "readPhaseOffer", {})), { status: "none" });
	const declared = await church();
	ok(
		await phases.declare(f.db, declared.owner.actor, {
			requestKey: randomUUID(),
			expectedRevision: await revisionOf(declared.w),
			input: { phase: 2 },
		}),
	);
	assert.deepEqual(ok(await read(declared.owner, "readPhaseOffer", {})), { status: "none" });
	const noop = await move(c, 1);
	assert.equal(noop.kind, "noop");
	assert.deepEqual(ok(await read(c.owner, "readPhaseOffer", {})), { status: "none" });

	const moved = await move(c, 2);
	assert.equal(moved.kind, "movement");
	const before = await footprint(c.w);
	let offer;
	const sent = await counted(async () => {
		offer = ok(await read(c.admin, "readPhaseOffer", {}));
	});
	assert.equal(offer.status, "open");
	assert.equal(offer.transition.id, moved.id);
	assert.equal(offer.transition.toPhase, 2);
	assert.equal(offer.transition.anchorDate, moved.local_date);
	assert.deepEqual(
		offer.checklists.map((k) => k.key),
		["ministry-team-setup", "launch-date-planning", "project-timeline-creation"],
	);
	const wiki = ok(await recommendForPhase(f.db, c.admin.actor, { phase: 2 }));
	assert.deepEqual(
		offer.recommendations.map((a) => a.slug),
		wiki.articles.map((a) => a.slug),
	);
	// Opening, reading and previewing leave the task count unchanged.
	ok(await read(c.owner, "readPhaseOffer", {}));
	ok(await read(c.owner, "previewTemplate", { checklistKey: "launch-date-planning" }));
	assert.deepEqual(await footprint(c.w), before);
	// The facts and the Wiki read, inside BEGIN and COMMIT.
	assert.equal(sent, 4);
});

test("AC:PHASE-CASE-006 AC:TARGET-TSK-010 the Owner accepts a subset dated from the move, and the offer is gone", async () => {
	const c = await church();
	const moved = await move(c, 2);
	const offer = ok(await read(c.owner, "readPhaseOffer", {}));
	const before = await footprint(c.w);
	const answered = ok(await accept(c.owner, moved.id, ["ministry-team-setup", "launch-date-planning"]));
	const anchor = moved.local_date;
	const expected = ["ministry-team-setup", "launch-date-planning"].flatMap((key) =>
		CATALOG.checklists
			.find((k) => k.key === key)
			.items.map((i) => [i.title, { kind: "local_date", date: plus(anchor, i.offsetDays) }]),
	);
	assert.deepEqual(
		answered.created.map((t) => [t.title, t.due]),
		expected,
	);
	assert.deepEqual(answered.answer.accepted, ["ministry-team-setup", "launch-date-planning"]);
	assert.deepEqual(answered.answer.declined, ["project-timeline-creation"]);
	for (const t of answered.created)
		assert.deepEqual(
			t.assignees.map((a) => a.accountId),
			[c.owner.id],
		);
	const after = await footprint(c.w);
	assert.equal(after.tasks - before.tasks, expected.length);
	assert.equal(after.answered, 1);
	const record = await rows(sql`SELECT after_value FROM audit_event WHERE tenant_id=${c.w.id}
		AND subject_type='phase_transition' AND kind='offer_answer'`);
	assert.equal(record.length, 1);
	assert.deepEqual(
		record[0].after_value.taskIds,
		answered.created.map((t) => t.id),
	);
	assert.equal(offer.checklists.length, 3);
	assert.deepEqual(ok(await read(c.owner, "readPhaseOffer", {})), { status: "none" });

	// Declining all creates no task, and its offer is gone too.
	const d = await church();
	const dm = await move(d, 2);
	const dBefore = await footprint(d.w);
	const declined = ok(await decline(d.owner, dm.id));
	assert.equal(declined.answer.answer, "declined");
	assert.deepEqual(declined.created, []);
	assert.deepEqual(declined.answer.declined, [
		"ministry-team-setup",
		"launch-date-planning",
		"project-timeline-creation",
	]);
	const dAfter = await footprint(d.w);
	assert.equal(dAfter.tasks, dBefore.tasks);
	assert.equal(dAfter.answered, 1);
	assert.deepEqual(ok(await read(d.owner, "readPhaseOffer", {})), { status: "none" });
});

test("AC:PHASE-CASE-006 a declined or accepted checklist never comes back in a later offer, but browse still lists it", async () => {
	const c = await church();
	const first = await move(c, 2);
	ok(await accept(c.owner, first.id, ["launch-date-planning"]));
	await move(c, 3);
	const third = ok(await read(c.owner, "readPhaseOffer", {}));
	assert.equal(third.status, "open");
	ok(await decline(c.owner, third.transition.id));
	// Back to Phase 2: every Phase 2 checklist was accepted or declined, so nothing is offered.
	await move(c, 2);
	assert.deepEqual(ok(await read(c.owner, "readPhaseOffer", {})), { status: "none" });
	// Phase 3 again: declined there too.
	await move(c, 3);
	assert.deepEqual(ok(await read(c.owner, "readPhaseOffer", {})), { status: "none" });
	// Phase 4 is new.
	await move(c, 4);
	assert.deepEqual(
		ok(await read(c.owner, "readPhaseOffer", {})).checklists.map((k) => k.key),
		["promotion-campaign", "pre-launch-services", "final-preparation"],
	);
	// Browse lists all 20, and the person may import a declined checklist by choice.
	assert.equal(ok(await read(c.owner, "listTemplates", {})).checklists.length, 20);
	assert.equal(ok(await importing(c.owner, "project-timeline-creation")).tasks.length, 6);
});

test("AC:TARGET-TSK-010 two devices answer at once: one answer commits and the other reads what it decided", async () => {
	const c = await church();
	const moved = await move(c, 2);
	const keys = [randomUUID(), randomUUID()];
	const [a, b] = await Promise.all([
		accept(c.owner, moved.id, ["ministry-team-setup", "launch-date-planning"], keys[0]),
		decline(c.admin, moved.id, keys[1]),
	]);
	const winner = [a, b].find((r) => r.status === "ok");
	const loser = [a, b].find((r) => r.status === "refused");
	assert.ok(winner && loser, JSON.stringify([a, b]));
	refused(loser, "offer_answered");
	assert.equal((await footprint(c.w)).answered, 1);
	assert.equal(
		(await rows(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${c.w.id} AND kind='offer_answer'`))[0].n,
		1,
	);
	// The second device reads the decided answer and the titles of the tasks actually created, from the database.
	const decided = ok(await read(loser === b ? c.admin : c.owner, "readPhaseOffer", { transitionId: moved.id }));
	assert.equal(decided.status, "answered");
	assert.equal(decided.answer.answer, winner.value.answer.answer);
	const created = await rows(sql`SELECT id, title FROM task WHERE plant_id=${c.w.id} ORDER BY created_at, id`);
	assert.deepEqual(decided.answer.tasks.map((t) => t.title).sort(), created.map((t) => t.title).sort());
	// A lost reply retried with its own key returns the stored answer with the inserted task ids.
	const winnerKey = winner === a ? keys[0] : keys[1];
	const again =
		winner === a
			? await accept(c.owner, moved.id, ["ministry-team-setup", "launch-date-planning"], winnerKey)
			: await decline(c.admin, moved.id, winnerKey);
	assert.deepEqual(ok(again), winner.value);
	assert.deepEqual(winner.value.created.map((t) => t.id).sort(), created.map((t) => t.id).sort());
});

test("AC:TARGET-TSK-010 a stale move, a forged key, a lost seat or a failed insert leaves the offer as it was", async () => {
	const c = await church();
	const old = await move(c, 2);
	const latest = await move(c, 3);
	const before = await footprint(c.w);
	// Not the latest unanswered move.
	refused(await accept(c.owner, old.id, ["launch-date-planning"]), "conflict");
	// A key outside this offer, an unknown key, a stale version.
	refused(await accept(c.owner, latest.id, ["launch-date-planning"]), "invalid_input");
	refused(await accept(c.owner, latest.id, ["no-such-checklist"]), "invalid_input");
	refused(
		await write(c.owner, "acceptPhaseOffer", {
			requestKey: randomUUID(),
			input: {
				transitionId: latest.id,
				catalogVersion: CATALOG.version + 1,
				checklistKeys: ["peak-performance-classes"],
			},
		}),
		"stale_catalog",
	);
	// No Owner or Admin authority: a Member, and an Admin whose seat ended.
	refused(await accept(c.member, latest.id, ["peak-performance-classes"]), "unavailable");
	refused(await decline(c.member, latest.id), "unavailable");
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${c.admin.seatId}`);
	refused(await decline(c.admin, latest.id), "unavailable");
	// Another plant's move.
	refused(await decline(owner, latest.id), "unavailable");
	assert.deepEqual(await footprint(c.w), before);

	// A fault during the task insert rolls the whole answer back.
	await f.admin.execute(sql`CREATE OR REPLACE FUNCTION wp026_fail_task() RETURNS trigger LANGUAGE plpgsql AS
		$$BEGIN RAISE EXCEPTION 'injected task insert fault'; END$$`);
	await f.admin.execute(
		sql.raw(`CREATE TRIGGER wp026_fail_task BEFORE INSERT ON task FOR EACH ROW
		WHEN (NEW.plant_id = '${c.w.id}') EXECUTE FUNCTION wp026_fail_task()`),
	);
	try {
		await assert.rejects(accept(c.owner, latest.id, ["peak-performance-classes"]), (e) =>
			/injected task insert fault/.test(String(e.cause?.message ?? e.message)),
		);
	} finally {
		await f.admin.execute(sql`DROP TRIGGER wp026_fail_task ON task`);
	}
	assert.deepEqual(await footprint(c.w), before);
	// The offer stays unanswered and answerable.
	assert.equal(ok(await read(c.owner, "readPhaseOffer", {})).status, "open");
	assert.equal(ok(await accept(c.owner, latest.id, ["peak-performance-classes"])).created.length, 7);
});

test("AC:PHASE-CASE-006 AC:TARGET-TSK-009 a new catalog version never changes edited or deleted imported tasks", async () => {
	const c = await church();
	const moved = await move(c, 2);
	const accepted = ok(await accept(c.owner, moved.id, ["launch-date-planning"])).created;
	const imported = ok(await importing(c.owner, "vision-meeting-preparation")).tasks;
	// The planter edits one task and deletes another.
	const [edited, deleted] = [accepted[0], accepted[1]];
	ok(
		await write(c.owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: edited.revision,
			input: { taskId: edited.id, patch: { title: "Keep my edits", due: { kind: "local_date", date: "2027-01-15" } } },
		}),
	);
	ok(
		await write(c.owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: deleted.revision,
			input: { taskId: deleted.id },
		}),
	);
	const snapshot = () =>
		rows(
			sql`SELECT id, title, description, due_date::text, deleted_at, revision::text FROM task WHERE plant_id=${c.w.id} ORDER BY id`,
		);
	const before = await snapshot();
	// The catalog is raised with new wording and offsets.
	const laterReader = createTemplateReader(raised);
	const laterWriter = createTaskWriter({ reminders: async () => {}, catalog: raised });
	const preview = ok(await read(c.owner, "previewTemplate", { checklistKey: "launch-date-planning" }, laterReader));
	assert.equal(preview.catalogVersion, CATALOG.version + 1);
	assert.match(preview.checklist.tasks[0].title, /^Revised: /);
	refused(
		await write(
			c.owner,
			"importTemplate",
			{
				requestKey: randomUUID(),
				input: { catalogVersion: CATALOG.version, checklistKey: "launch-date-planning", itemKeys: ["pick-a-sunday"] },
			},
			laterWriter,
		),
		"stale_catalog",
	);
	assert.deepEqual(await snapshot(), before);
	const kept = before.find((r) => r.id === edited.id);
	assert.equal(kept.title, "Keep my edits");
	assert.equal(kept.due_date, "2027-01-15");
	assert.notEqual(before.find((r) => r.id === deleted.id).deleted_at, null);
	assert.equal(before.filter((r) => imported.some((t) => t.id === r.id) && /^Revised/.test(r.title)).length, 0);
	// The deleted task stays out of the list.
	const listed = ok(await f.db.transaction((tx) => taskReader.list(tx, c.owner.actor, { limit: 100 })));
	assert.equal(
		listed.items.some((t) => t.id === deleted.id),
		false,
	);
});

test("AC:TARGET-TSK-016 create, edit and import keep bounded safe Markdown and clear an empty description", async () => {
	const fixtureText = "Hello\n<script>alert(1)</script>\n[click](javascript:alert(1))";
	assert.equal(normalizeDescription(fixtureText), "Hello\n\nclick");
	assert.equal(normalizeDescription("   \n\t "), "");
	assert.equal(
		normalizeDescription(
			"First line\nsecond line\r\n\r\n- one\n- **two** and *three*\n\n[site](https://example.org) [mail](mailto:a@b.co)",
		),
		"First line\nsecond line\n\n- one\n- **two** and *three*\n\n[site](https://example.org) [mail](mailto:a@b.co)",
	);
	assert.equal(normalizeDescription('<img src=x onerror="alert(1)">Hi <b onclick="x()">there</b>'), "Hi there");
	assert.equal(
		normalizeDescription("[a](data:text/html;base64,PHNjcmlwdD4=) [b](JaVaScRiPt:alert(1)) [c](/relative)"),
		"a b c",
	);
	assert.equal(normalizeDescription("Keep 3 < 4 and a > b"), "Keep 3 < 4 and a > b");

	const created = ok(
		await write(owner, "create", { requestKey: randomUUID(), input: { title: "Described", description: fixtureText } }),
	).task;
	assert.equal(created.description, "Hello\n\nclick");
	const stored = await rows(sql`SELECT description FROM task WHERE id=${created.id}`);
	assert.equal(stored[0].description, "Hello\n\nclick");
	assert.equal(created.excerpt, "Hello\n\nclick");
	const edited = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: created.revision,
			input: { taskId: created.id, patch: { description: "  \n " } },
		}),
	).task;
	assert.equal(edited.description, "");
	assert.equal(edited.excerpt, "");
	const before = await footprint(plant);
	refused(
		await write(owner, "create", {
			requestKey: randomUUID(),
			input: { title: "Too long", description: "x".repeat(MAX_DESCRIPTION + 1) },
		}),
		"invalid_input",
	);
	assert.deepEqual(await footprint(plant), before);
	assert.equal(
		ok(
			await write(owner, "create", {
				requestKey: randomUUID(),
				input: { title: "At the limit", description: "x".repeat(MAX_DESCRIPTION) },
			}),
		).task.description.length,
		MAX_DESCRIPTION,
	);
	// An imported item's description is the same canonical text.
	const imported = ok(await importing(owner, "vision-meeting-preparation")).tasks;
	const call = imported.find((t) => t.title === "Confirm attendance by phone");
	assert.equal(call.excerpt, "A text is an invitation; a call is a commitment. Ring everyone who said yes.");
});

test("AC:TARGET-TSK-009 AC:TARGET-TSK-010 browse, preview and offer reads send a fixed statement count as tasks grow", async () => {
	const c = await church();
	await move(c, 2);
	const measure = async () => [
		await counted(async () => ok(await read(c.owner, "listTemplates", {}))),
		await counted(async () => ok(await read(c.owner, "previewTemplate", { checklistKey: "final-preparation" }))),
		await counted(async () => ok(await read(c.owner, "readPhaseOffer", {}))),
	];
	const few = await measure();
	for (const key of ["vision-meeting-preparation", "final-preparation", "promotion-campaign"])
		ok(await importing(c.owner, key));
	assert.deepEqual(await measure(), few);
	assert.deepEqual(few, [3, 3, 4]);
});
