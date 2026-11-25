import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "../../../packages/db/src/query.ts";
import { owner as ownerSchema } from "../../../packages/contracts/src/common/index.ts";
import { currentActor, RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	pipelineWriter,
	programWriter,
	readEnrollment,
	readMyResidency,
	pipelineDataWriter,
	readPipelineExport,
	readPipelinePersonRecord,
	readVersionReview,
} from "../../../packages/domain/src/organizations/index.ts";
import { peopleMerge } from "../../../packages/domain/src/people/merge/index.ts";
import { peopleUnmerge } from "../../../packages/domain/src/people/unmerge/index.ts";
import { reads, withStatus } from "../people/people-support.mts";
import type { Actor } from "../../support/fixture.mts";
import { ok, refusedWith, sendingWorld, type Organization } from "./sending-world.mts";

let w: Awaited<ReturnType<typeof sendingWorld>>;
before(async () => {
	w = await sendingWorld("pipelinecases");
});
after(() => w?.close());

const context = (a: Actor, o: Organization) => ({ session: a.session, selected: ownerSchema.parse(o) });
const person = async (a: Actor, o: Organization, personId: string) => {
	const found = withStatus(ok(await w.tx((t) => reads.getPerson(t, context(a, o), { personId }))), "available");
	return found.person;
};
const stored = (personId: string) =>
	w.one(sql`SELECT display_name,email,state,plant_id,organization_id,tenant_id,stage,adult_classification,commitment_state,
		household_id,pipeline_position,linked_account_id FROM person WHERE id=${personId}`);
const seats = () => w.count(sql`SELECT count(*)::int AS n FROM seat`);
const history = (organization: string, subject: string) =>
	w.rows(sql`SELECT actor_id,tenant_id,action,kind,subject_id,after_revision::int AS revision_after,metadata FROM audit_event
		WHERE tenant_id=${organization} AND subject_id=${subject} ORDER BY occurred_at,id`);

test("AC:ADR1-001 AC:WP011-MUL-001 an organization person is created once with no plant field and no seat, and is edited, retired and restored without giving back a seat or sharing", async (t) => {
	const { O, A, D, R, seats: seat } = await w.scene();
	await t.test("a create saves one person and a retry saves none; nothing on it belongs to a plant", async () => {
		for (const { name, email } of [
			{ name: "Jordan Rivera", email: "jordan@example.test" },
			{ name: "Jamie", email: null },
		]) {
			const personId = randomUUID();
			const stage = (await w.board(A)).stages[0]!.id;
			const request = { personId, displayName: name, email, responsibleSeatId: null, stageId: stage };
			const before = await seats();
			const create = async () => ok(await pipelineWriter.addPerson(w.db, await w.authority(A), request));
			const created = await w.recorded(create);
			assert.deepEqual(created.value, { personId, revision: "1", outcome: "changed" });
			assert.deepEqual(created.added, { audits: ["people.created"], jobs: [], notices: 0, mail: 0 });
			assert.deepEqual(await w.untouched(create), { personId, revision: "1", outcome: "noop" });
			assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM person WHERE display_name=${name}`), 1);
			const read = await person(A, O, personId);
			assert.deepEqual(
				[read.displayName, read.email, read.owner, read.lifecycle],
				[name, email, ownerSchema.parse(O), { state: "live" }],
			);
			for (const field of ["stage", "source", "adultClassification", "birthDate", "commitment", "household"])
				assert.equal(field in read, false, field);
			assert.deepEqual(await stored(personId), {
				display_name: name,
				email,
				state: "live",
				plant_id: null,
				organization_id: O.id,
				tenant_id: O.id,
				stage: null,
				adult_classification: null,
				commitment_state: null,
				household_id: null,
				pipeline_position: null,
				linked_account_id: null,
			});
			assert.equal(await seats(), before);
		}
	});

	const P = await w.place(A, "Casey Lee", { responsible: seat.A });
	const Q = await w.place(A, "Casey L.", { responsible: seat.A });
	const L = await w.link(O, P, R);
	const Program = await w.residency(A, seat.A, A);
	const E = await w.enroll(A, Program, P);
	const revision = async (personId = P) => ok(await w.record(A, personId)).revision;
	const linkRow = () =>
		w.one(sql`SELECT account_id,ended_at,share_foundations,share_milestones FROM residency_link WHERE id=${L}`);

	await t.test("an authorized read shows the person, their state and the organization that owns them", async () => {
		const read = await w.untouched(() => person(A, O, P));
		assert.deepEqual(
			[read.displayName, read.lifecycle, read.owner],
			["Casey Lee", { state: "live" }, ownerSchema.parse(O)],
		);
	});
	await t.test("the contact email changes alone; the linked account keeps its own address and its link", async () => {
		const before = { link: await linkRow(), account: await w.one(sql`SELECT email FROM auth_user WHERE id=${R.user}`) };
		ok(
			await pipelineWriter.editPerson(w.db, await w.authority(A), {
				personId: P,
				expectedRevision: await revision(),
				displayName: "Casey Lee",
				email: "casey.new@example.test",
				responsibleSeatId: seat.A,
			}),
		);
		const read = await person(A, O, P);
		assert.deepEqual([read.displayName, read.email], ["Casey Lee", "casey.new@example.test"]);
		assert.equal((await stored(P)).linked_account_id, R.id);
		assert.deepEqual(
			{ link: await linkRow(), account: await w.one(sql`SELECT email FROM auth_user WHERE id=${R.user}`) },
			before,
		);
		assert.equal(ok(await w.record(A, P)).residency.status, "linked");
	});

	const publishAgain = async () => {
		const p = await w.program(A, Program);
		const { rhythm, expectedMonths, stages, milestones } = p.published!;
		const saved = ok(
			await programWriter.savePlan(w.db, await w.authority(A), {
				programId: Program,
				expectedRevision: p.revision,
				plan: {
					rhythm,
					expectedMonths,
					stages: stages.map(({ label, minMonths, maxMonths }) => ({ label, minMonths, maxMonths })),
					milestones: milestones.map(({ lineage, title, description, handsOn }) => ({
						lineage,
						title,
						description,
						handsOn,
					})),
					readings: [],
				},
			}),
		);
		ok(
			await programWriter.publishVersion(w.db, await w.authority(A), {
				programId: Program,
				expectedRevision: saved.revision,
			}),
		);
		return ok(await readVersionReview(w.db, await w.authority(A), { enrollmentId: E }));
	};
	const retire = async () =>
		ok(
			await pipelineWriter.retirePerson(w.db, await w.authority(A), {
				personId: P,
				expectedRevision: await revision(),
			}),
		);
	await t.test("retiring names the active enrollment that needs an owner and refuses every new reference", async () => {
		const pinned = (await w.enrollment(A, E)).milestones[0]!.id;
		const { versionId, stageId, basis } = await publishAgain();
		const retired = (await retire()) as { needsOwner?: string[] };
		assert.deepEqual(retired.needsOwner, [E]);
		const kept = ok(await w.record(A, P));
		assert.equal(kept.retired, true);
		assert.equal(
			(await w.program(A, Program)).people.some((p) => p.personId === P),
			false,
		);
		const apprenticeship = await w.residency(A, seat.A, A);
		const other = (await w.program(A, apprenticeship)).published!;
		const auth = await w.authority(A);
		const attempts: Record<string, () => Promise<Parameters<typeof refusedWith>[0]>> = {
			enroll: () =>
				programWriter.enroll(w.db, auth, {
					enrollmentId: randomUUID(),
					programId: apprenticeship,
					personId: P,
					cohort: "Autumn 2026",
					startedOn: "2026-10-17",
					expectedEndOn: "2028-01-17",
					stageId: other.stages[0]!.id,
					nextMeetingAt: null,
				}),
			note: () => pipelineWriter.addNote(w.db, auth, { personId: P, noteId: randomUUID(), body: "x" }),
			conversation: () =>
				pipelineWriter.logConversation(w.db, auth, {
					conversationId: randomUUID(),
					personId: P,
					occurredOn: "2026-10-16",
					note: null,
				}),
			move: () =>
				pipelineWriter.movePerson(w.db, auth, {
					personId: P,
					expectedRevision: kept.revision,
					stageId: kept.stage.id,
					reason: "x",
				}),
			assessment: () =>
				pipelineWriter.recordAssessment(w.db, auth, {
					personId: P,
					expectedRevision: kept.revision,
					assessedOn: "2026-10-16",
					assessor: "x",
				}),
			edit: () =>
				pipelineWriter.editPerson(w.db, auth, {
					personId: P,
					expectedRevision: kept.revision,
					displayName: "Casey Lee",
					email: null,
					responsibleSeatId: seat.D,
				}),
			milestone: () =>
				programWriter.recordMilestone(w.db, auth, {
					enrollmentId: E,
					milestoneId: pinned,
					completedOn: "2026-10-16",
				}),
			version: () => programWriter.applyVersion(w.db, auth, { enrollmentId: E, versionId, stageId, basis }),
			versions: () =>
				programWriter.applyVersions(w.db, auth, {
					programId: Program,
					versionId,
					enrollments: [{ enrollmentId: E, stageId, basis }],
				}),
			feedback: () =>
				programWriter.addFeedback(w.db, auth, {
					feedbackId: randomUUID(),
					enrollmentId: E,
					milestoneId: pinned,
					body: "x",
				}),
		};
		for (const [name, attempt] of Object.entries(attempts)) {
			const reply = await w.untouched(attempt);
			assert.equal(reply.status, "refused", name);
		}
		assert.deepEqual(await w.rows(sql`SELECT status FROM development_enrollment WHERE id=${E}`), [
			{ status: "active" },
		]);
	});
	await t.test("restoring brings back the person, never a seat or what the resident shared", async () => {
		await w.admin.execute(sql`UPDATE person SET retired_at='2026-10-16T16:00:00Z' WHERE id=${P}`);
		await w.admin.execute(sql`UPDATE residency_link SET share_foundations=true,share_milestones=true WHERE id=${L}`);
		const before = await seats();
		const restored = await w.touched(async () =>
			ok(
				await pipelineWriter.restorePerson(w.db, await w.authority(A), {
					personId: P,
					expectedRevision: await revision(),
				}),
			),
		);
		assert.equal((await person(A, O, P)).lifecycle.state, "live");
		assert.equal(await seats(), before);
		assert.equal(restored.tables.includes("seat"), false);
		const seen = (await w.enrollment(A, E)).resident;
		assert.deepEqual(seen, { status: "linked", milestones: "not_shared", foundations: { status: "not_shared" } });
		assert.deepEqual(await linkRow(), {
			account_id: R.id,
			ended_at: null,
			share_foundations: false,
			share_milestones: false,
		});
		const mine = ok(await readMyResidency(w.db, await w.authority(R)));
		assert.deepEqual(mine.status === "linked" && mine.sharing, { shareMilestones: false, shareFoundations: false });
		refusedWith(await pipelineWriter.restorePerson(w.db, await w.authority(D), { personId: P, expectedRevision: "9" }));
	});
	await t.test("an ordinary restore refuses a merged person; the reviewed undo brings them back", async () => {
		const review = ok(await w.tx((x) => peopleMerge.getMergeReview(x, context(A, O), { sourceId: Q, survivorId: P })));
		const merged = ok(
			await w.tx((x) =>
				peopleMerge.mergePeople(x, context(A, O), {
					requestKey: randomUUID(),
					input: {
						sourceId: Q,
						survivorId: P,
						reviewDigest: review.reviewDigest,
						fieldChoices: Object.fromEntries(review.fields.map((f) => [f.field, "survivor"])),
					},
				}),
			),
		);
		const [{ revision: current }] = (await w.rows<{ revision: string }>(
			sql`SELECT revision::text AS revision FROM pipeline_person WHERE person_id=${Q}`,
		)) as [{ revision: string }];
		refusedWith(
			await w.untouched(async () =>
				pipelineWriter.restorePerson(w.db, await w.authority(A), { personId: Q, expectedRevision: current }),
			),
		);
		assert.equal((await stored(Q)).state, "merged");
		const preview = ok(await w.tx((x) => peopleUnmerge.previewUnmerge(x, context(A, O), { mergeId: merged.mergeId })));
		ok(
			await w.tx((x) =>
				peopleUnmerge.unmergePeople(x, context(A, O), {
					requestKey: randomUUID(),
					expectedRevision: preview.reviewRevision,
					input: { mergeId: merged.mergeId },
				}),
			),
		);
		assert.equal((await stored(Q)).state, "live");
	});
});

test("AC:ADR1-002 each duty reads exactly its own part of a pipeline person, and everyone else is refused alike", async (t) => {
	const NOTE = "Casey requested a private staff follow-up.";
	const FEEDBACK = "Please explain the passage before discussing application";
	const PRIVATE = "Casey's private prospectus";
	const plant = await w.plant({ name: "Harvest Point" });
	type Duties = { responsible: "A" | "D"; director: "A" | "D"; role?: "owner" | "admin" | "member" };
	async function stage({ responsible, director, role = "admin" }: Duties) {
		const s = await w.scene(role);
		const other = director === "A" ? s.A : s.D;
		const P = await w.place(s.lead, "Casey Lee", { email: "casey@example.test", responsible: s.seats[responsible] });
		await w.link(s.O, P, s.R);
		const Program = await w.residency(s.lead, s.seats[director], other);
		const E = await w.enroll(s.lead, Program, P);
		const writer = responsible === "A" ? s.A : role === "member" ? s.lead : s.A;
		const note = randomUUID();
		ok(await pipelineWriter.addNote(w.db, await w.authority(writer), { personId: P, noteId: note, body: NOTE }));
		await w.admin.execute(sql`UPDATE person_note SET occurred_at='2026-10-16T18:00:00Z' WHERE id=${note}`);
		const milestone = (await w.enrollment(s.lead, E)).milestones[0]!.id;
		ok(
			await programWriter.addFeedback(w.db, await w.authority(other), {
				feedbackId: randomUUID(),
				enrollmentId: E,
				milestoneId: milestone,
				body: FEEDBACK,
			}),
		);
		await w.admin.execute(
			sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${randomUUID()},${s.R.id}::uuid,'native',${PRIVATE})`,
		);
		await w.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
			share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${plant.id},${s.O.id},clock_timestamp(),true,true,true,true,true,true,true)`);
		return { ...s, P, E, writer };
	}
	type Set = Awaited<ReturnType<typeof stage>>;
	const refused = { status: "refused", refusal: { code: "unavailable" } };
	async function reading(s: Set, a: Actor) {
		const auth = await w.authority(a);
		const record = await readPipelinePersonRecord(w.db, auth, { personId: s.P });
		const enrollment = await readEnrollment(w.db, auth, { enrollmentId: s.E });
		return { duty: await w.duty(a, s.O, s.P), record, enrollment };
	}
	const summary = ({ duty, record, enrollment }: Awaited<ReturnType<typeof reading>>) => ({
		duties: duty.status === "allowed" ? duty.duties.map((d) => d.kind) : [],
		contact: record.status === "ok" ? record.value.email : null,
		staffNotes:
			record.status === "ok"
				? record.value.notes.map((n) => (n.state === "current" ? [n.body, n.author] : null))
				: null,
		feedback:
			enrollment.status === "ok" ? (enrollment.value.milestones[0]!.feedback?.map((f) => f.body) ?? null) : null,
		progress: enrollment.status === "ok" ? enrollment.value.resident : null,
	});
	const shared = {
		status: "linked",
		milestones: "shared",
		foundations: { status: "shared", completed: 0, total: 6 },
	};
	async function holdsNoPlant(s: Set, a: Actor) {
		const selected = ownerSchema.parse(plant);
		assert.deepEqual(await w.tx((x) => currentActor(x, a.session, selected)), { status: "unavailable" });
		const edits = await w.untouched(() => w.tx((x) => RequestActor.claimWrite(x, a.session, selected)));
		assert.ok(!edits, "no plant write is open to them");
		assert.equal(JSON.stringify(await reading(s, a)).includes(PRIVATE), false);
	}
	async function readsNothing(s: Set, a: Actor) {
		const before = await w.untouched(() => reading(s, a));
		assert.deepEqual(before, { duty: { status: "unavailable" }, record: refused, enrollment: refused });
	}

	await t.test("an Admin reads contact, staff notes, feedback and consented progress", async () => {
		const s = await stage({ responsible: "A", director: "A" });
		const read = await w.untouched(() => reading(s, s.A));
		assert.deepEqual(summary(read), {
			duties: ["organization_administration", "responsible_staff", "program_director"],
			contact: "casey@example.test",
			staffNotes: [[NOTE, "Alex"]],
			feedback: [FEEDBACK],
			progress: shared,
		});
		assert.equal(JSON.stringify(read).includes(PRIVATE), false);
		await holdsNoPlant(s, s.A);
		assert.equal((await w.modelContent(s.A)).includes("follow-up"), false, "no note reaches a model");
	});
	await t.test("an Admin with no other duty reads the same", async (t) => {
		const s = await stage({ responsible: "D", director: "D" });
		const { duties, ...rest } = summary(await reading(s, s.A));
		assert.deepEqual(duties, ["organization_administration"]);
		assert.deepEqual(rest, {
			contact: "casey@example.test",
			staffNotes: [[NOTE, "Alex"]],
			feedback: [FEEDBACK],
			progress: shared,
		});
		await t.test("the resident is refused the internal pipeline", async () => {
			await readsNothing(s, s.R);
			const mine = JSON.stringify(ok(await readMyResidency(w.db, await w.authority(s.R))));
			for (const hidden of [NOTE, "Potential leader", "potential_leader"]) assert.equal(mine.includes(hidden), false);
		});
		await t.test("staff of another organization are refused, whichever organization they name", async () => {
			await readsNothing(s, s.foreign);
			for (const selected of [s.B, s.O])
				assert.deepEqual(await w.duty(selected === s.O ? s.foreign : s.A, selected, s.P), { status: "unavailable" });
			assert.deepEqual(
				await w.tx((x) => currentActor(x, s.A.session, ownerSchema.parse(s.B))),
				{ status: "unavailable" },
				"the Admin's session holds nothing in the other organization",
			);
		});
	});
	await t.test("an Owner reads the note and its author, and no model does", async () => {
		const s = await stage({ responsible: "A", director: "A", role: "owner" });
		const read = await w.untouched(() => reading(s, s.A));
		assert.deepEqual(summary(read).staffNotes, [[NOTE, "Alex"]]);
		assert.equal((await w.modelContent(s.A)).includes("follow-up"), false);
	});
	await t.test("responsible staff read contact and staff notes, never feedback", async () => {
		const s = await stage({ responsible: "A", director: "D", role: "member" });
		const read = await w.untouched(() => reading(s, s.A));
		const { progress, ...rest } = summary(read);
		assert.deepEqual(rest, {
			duties: ["responsible_staff"],
			contact: "casey@example.test",
			staffNotes: [[NOTE, "Alex"]],
			feedback: null,
		});
		assert.deepEqual(progress, shared);
		assert.equal(JSON.stringify(read).includes(FEEDBACK), false);
		await holdsNoPlant(s, s.A);
		assert.equal((await w.modelContent(s.A)).includes("follow-up"), false);
	});
	await t.test("a program director reads feedback and consented progress, never the staff notes", async () => {
		const s = await stage({ responsible: "D", director: "A", role: "member" });
		const read = await w.untouched(() => reading(s, s.A));
		assert.deepEqual(summary(read), {
			duties: ["program_director"],
			contact: null,
			staffNotes: null,
			feedback: [FEEDBACK],
			progress: shared,
		});
		assert.deepEqual(read.duty.status === "allowed" && read.duty.duties, [
			{ kind: "program_director", canReadStaffNotes: false },
		]);
		assert.deepEqual(read.record, refused);
		assert.equal(JSON.stringify(read).includes(NOTE), false);
		await holdsNoPlant(s, s.A);
	});
	await t.test("staff with no duty for this person are refused", async () => {
		const s = await stage({ responsible: "D", director: "D", role: "member" });
		await readsNothing(s, s.A);
	});
	await t.test("a responsible seat that ended grants nothing", async () => {
		const s = await stage({ responsible: "A", director: "D", role: "member" });
		const held = await w.authority(s.A);
		assert.equal((await reading(s, s.A)).record.status, "ok");
		await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${s.seats.A}`);
		await w.untouched(async () => {
			assert.deepEqual(await w.duty(s.A, s.O, s.P), { status: "unavailable" });
			assert.deepEqual(await readPipelinePersonRecord(w.db, held, { personId: s.P }), refused);
			assert.deepEqual(await readEnrollment(w.db, held, { enrollmentId: s.E }), refused);
		});
	});
});

const KINDS = ["potential_leader", "apprentice", "resident", "commissioned", "not_continuing", "other"] as const;
const byKind = (g: Awaited<ReturnType<typeof w.goals>>) =>
	Object.fromEntries(KINDS.map((kind) => [kind, g.kinds.find((k) => k.kind === kind)?.count ?? 0]));

test("AC:ADR1-007 goals keep their targets beside observed counts by stage kind, a network counts only its own people, and a negative target changes nothing", async (t) => {
	const { O, B, A, foreign, seats: seat } = await w.scene();
	const N = await w.organization("sending_network", { name: "Hill Country", timezone: "America/Chicago" });
	const NA = await w.actor(N, "admin", { user: { name: "Nico" } });
	const P = await w.place(A, "Casey Lee", { responsible: seat.A });
	await w.place(A, "Casey L.", { responsible: seat.A });
	const Program = await w.residency(A, seat.A, A);
	await w.enroll(A, Program, P);
	for (const church of [O, B]) {
		const relationship = randomUUID();
		await w.admin.execute(sql`INSERT INTO affiliation(id,sending_church_id,organization_id,accepted_at,share_people,
			share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${relationship},${church.id},${N.id},clock_timestamp(),false,false,false,false,false,false,false)`);
		await w.admin.execute(sql`INSERT INTO pipeline_sharing(id,organization_id,relationship_id,network_id,
			share_pipeline_totals,revision) VALUES(${randomUUID()},${church.id},${relationship},${N.id},true,1)`);
	}
	await w.place(foreign, "Hope Person");
	const goal = (goalId: string, over: object = {}) => ({
		goalId,
		expectedRevision: null,
		leaderTarget: 8,
		plantTarget: 2,
		targetYear: 2028,
		rationale: "Develop the next planting team",
		countingFrom: null,
		counts: [],
		...over,
	});
	const save = async (a: Actor, input: object) => pipelineWriter.saveGoal(w.db, await w.authority(a), input);
	const targets = (g: Awaited<ReturnType<typeof w.goals>>) =>
		g.goals.map((x) => ({ leaders: x.leaderTarget, plants: x.plantTarget, year: x.targetYear }));
	const observed = { potential_leader: 2, apprentice: 0, resident: 0, commissioned: 0, not_continuing: 0, other: 0 };
	const none = { ...observed, potential_leader: 0 };
	const unavailable = { status: "unavailable", reason: "deferred_stage_3" };

	await t.test(
		"an Admin saves a goal; a retry saves no second one; counts are today's facts, never a forecast",
		async () => {
			const id = randomUUID();
			const moved = () => w.rows(sql`SELECT person_id,stage_id,revision FROM pipeline_person ORDER BY person_id`);
			const before = await moved();
			const saved = await w.recorded(async () => ok(await save(A, goal(id))));
			assert.deepEqual(saved.value, { goalId: id, revision: "1", outcome: "changed" });
			assert.deepEqual(saved.added, { audits: ["settings.changed"], jobs: [], notices: 0, mail: 0 });
			assert.equal((ok(await w.untouched(() => save(A, goal(id)))) as { outcome: string }).outcome, "noop");
			const read = await w.untouched(() => w.goals(A));
			assert.deepEqual(targets(read), [{ leaders: 8, plants: 2, year: 2028 }]);
			assert.equal(read.goals[0]!.rationale, "Develop the next planting team");
			assert.equal(read.asOf, "2026-10-17");
			assert.deepEqual(byKind(read), observed);
			assert.equal(read.activeResidents, 1);
			assert.deepEqual(read.plantsSent, unavailable);
			assert.deepEqual(
				Object.keys(read).sort(),
				["activeResidents", "asOf", "canEdit", "conversations", "goals", "kinds", "plantsSent"],
				"no forecast, rate or score",
			);
			assert.deepEqual(await moved(), before, "a goal moves nobody");
		},
	);
	await t.test("a negative target is refused and changes nothing", async () => {
		refusedWith(
			await w.untouched(() => save(A, goal(randomUUID(), { leaderTarget: -1, rationale: "Invalid" }))),
			"invalid_input",
			"leaderTarget",
		);
		assert.deepEqual(targets(await w.goals(A)), [{ leaders: 8, plants: 2, year: 2028 }]);
	});
	await t.test("a network owns its own goals and pools no church's pipeline, even one that shares totals", async () => {
		const id = randomUUID();
		ok(
			await save(
				NA,
				goal(id, { leaderTarget: 5, plantTarget: 1, targetYear: 2029, rationale: "Network apprenticeship" }),
			),
		);
		assert.deepEqual(await w.rows(sql`SELECT organization_id FROM sending_goal WHERE id=${id}`), [
			{ organization_id: N.id },
		]);
		const read = await w.untouched(() => w.goals(NA));
		assert.deepEqual(targets(read), [{ leaders: 5, plants: 1, year: 2029 }]);
		assert.deepEqual(byKind(read), none);
		assert.equal(read.activeResidents, 0);
		assert.deepEqual(read.plantsSent, unavailable);
		assert.deepEqual(targets(await w.goals(A)), [{ leaders: 8, plants: 2, year: 2028 }]);
	});
});

test("AC:ADR1-008 a human moves a person with a reason once, labels stay in history, occupied stages stay, and stillness and assessments carry no verdict", async (t) => {
	async function placed() {
		const s = await w.scene();
		const P = await w.place(s.A, "Casey Lee", { responsible: s.seats.A });
		const stages = Object.fromEntries((await w.board(s.A)).stages.map((x) => [x.kind, x]));
		const read = async () => ok(await w.record(s.A, P));
		const move = async (kind: string, reason: string) => ({
			personId: P,
			expectedRevision: (await read()).revision,
			stageId: stages[kind]!.id,
			reason,
		});
		const send = async (request: object) => pipelineWriter.movePerson(w.db, await w.authority(s.A), request);
		const verdict = async () => {
			const text = JSON.stringify([await read(), await w.board(s.A)]);
			for (const word of ["score", "rating", "calling", "readiness", "outcome", "result"])
				assert.equal(text.toLowerCase().includes(word), false, word);
		};
		return { ...s, P, stages, read, move, send, verdict };
	}
	await t.test("a move lands once with its reason, and a retry adds no history", async () => {
		const s = await placed();
		const request = await s.move("resident", "Casey agreed to join the residency");
		const moved = await w.recorded(async () => ok(await s.send(request)));
		assert.deepEqual(moved.added, { audits: ["people.stage_changed"], jobs: [], notices: 0, mail: 0 });
		const after = await s.read();
		assert.deepEqual(after.stage, { id: s.stages.resident!.id, label: "Resident", kind: "resident" });
		const moves = after.history.filter((h) => h.kind === "moved");
		assert.deepEqual(
			moves.map(({ id: _id, ...m }) => m),
			[
				{
					kind: "moved",
					on: "2026-10-17",
					actor: "Alex",
					from: "Potential leader",
					to: "Resident",
					reason: "Casey agreed to join the residency",
				},
			],
		);
		refusedWith(await w.untouched(() => s.send(request)), "conflict");
		assert.deepEqual((await s.read()).history, after.history);
		refusedWith(await w.untouched(async () => s.send(await s.move("apprentice", "  "))), "invalid_input", "reason");
	});
	const listed = (b: Awaited<ReturnType<typeof w.board>>) =>
		b.stages.map(({ id, label, kind, revision }) => ({ id, label, kind, expectedRevision: revision }));
	await t.test("an occupied stage is not deleted", async () => {
		const s = await placed();
		const stages = listed(await w.board(s.A));
		const gone = s.stages.potential_leader!;
		await pipelineWriter.saveStages(w.db, await w.authority(s.A), {
			stages: [...stages, { id: randomUUID(), label: "Explorer", kind: "potential_leader", expectedRevision: null }],
			removed: [],
		});
		const now = listed(await w.board(s.A));
		const refused = await w.untouched(async () =>
			pipelineWriter.saveStages(w.db, await w.authority(s.A), {
				stages: now.filter((x) => x.id !== gone.id),
				removed: [{ id: gone.id, expectedRevision: now.find((x) => x.id === gone.id)!.expectedRevision }],
			}),
		);
		assert.deepEqual(refused, {
			status: "refused",
			refusal: { code: "stage_occupied", stageId: gone.id, people: 1 },
		});
	});
	await t.test("a rename shows now and keeps the old label in history and the kind", async () => {
		const s = await placed();
		ok(
			await pipelineWriter.saveStages(w.db, await w.authority(s.A), {
				stages: listed(await w.board(s.A)).map((x) =>
					x.kind === "potential_leader" ? { ...x, label: "Exploring leadership" } : x,
				),
				removed: [],
			}),
		);
		const read = await s.read();
		assert.deepEqual([read.stage.label, read.stage.kind], ["Exploring leadership", "potential_leader"]);
		assert.deepEqual(
			read.history.map((h) => h.kind === "placed" && h.to),
			["Potential leader"],
		);
	});
	await t.test("Not continuing is an ordinary move with no score", async () => {
		const s = await placed();
		ok(await s.send(await s.move("not_continuing", "Casey chose a different path")));
		const read = await s.read();
		assert.equal(read.stage.kind, "not_continuing");
		assert.equal(read.history[0]!.kind, "moved");
		await s.verdict();
	});
	await t.test("the six-month query uses the last actual move, to the day in the organization's zone", async () => {
		const s = await placed();
		const at = (instant: string) =>
			w.admin.execute(sql`UPDATE audit_event a SET occurred_at=${instant}::timestamptz FROM pipeline_stage_move m
				JOIN pipeline_person pp ON pp.id=m.pipeline_person_id WHERE a.id=m.id AND pp.person_id=${s.P}`);
		const still = async () => {
			const b = await w.untouched(() => w.board(s.A, { stale: true }));
			assert.equal(b.asOf, "2026-10-17");
			const people = b.stages.flatMap((x) => x.people.map((p) => [p.name, p.lastMovedOn]));
			assert.equal(
				b.stages.reduce((n, x) => n + x.matching, 0),
				people.length,
			);
			return people;
		};
		await at("2026-04-01T18:00:00Z");
		assert.deepEqual(await still(), [["Casey Lee", "2026-04-01"]]);
		await s.verdict();
		await at("2026-04-17T04:59:59Z");
		assert.deepEqual(await still(), [["Casey Lee", "2026-04-16"]]);
		await at("2026-04-17T05:00:00Z");
		assert.deepEqual(await still(), [], "a move on the as-of day six months ago is not stillness");
	});
	await t.test("an outside assessment stores that it occurred, when and by whom, and no outcome", async () => {
		const s = await placed();
		const request = {
			personId: s.P,
			expectedRevision: (await s.read()).revision,
			assessedOn: "2026-10-15",
			assessor: "Outside assessor",
		};
		const record = async (input: object) => pipelineWriter.recordAssessment(w.db, await w.authority(s.A), input);
		for (const field of ["outcome", "result", "recommendation", "score"])
			refusedWith(await w.untouched(() => record({ ...request, [field]: "recommended" })), "invalid_input");
		ok(await record(request));
		const read = await s.read();
		assert.deepEqual(read.assessment, { on: "2026-10-15", by: "Outside assessor" });
		assert.deepEqual(
			await w.rows(sql`SELECT to_jsonb(pp)-'id'-'organization_id'-'person_id'-'stage_id'-'responsible_seat_id'-'revision'
				AS stored FROM pipeline_person pp WHERE person_id=${s.P}`),
			[{ stored: { assessed_on: "2026-10-15", assessor_label: "Outside assessor" } }],
		);
	});
});

test("AC:ADR1-009 a conversation and a note record who and when, count by the organization's calendar, and their words stay with staff who may read them", async (t) => {
	const zone = "America/Chicago";
	const dayOf = (instant: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(instant));
	const NOTE = "Casey will meet the director next week";
	async function pair(role: "admin" | "owner" = "admin") {
		const s = await w.scene(role);
		const P = await w.place(s.A, "Casey Lee", { responsible: s.seats.A });
		const Q = await w.place(s.A, "Casey L.", { responsible: s.seats.A });
		return { ...s, P, Q };
	}
	type Set = Awaited<ReturnType<typeof pair>>;
	const log = async (s: Set, personId: string, instant: string, note: string | null, conversationId = randomUUID()) =>
		pipelineWriter.logConversation(w.db, await w.authority(s.A), {
			conversationId,
			personId,
			occurredOn: dayOf(instant),
			note,
		});
	const noteIn = async (s: Set) => ok(await w.record(s.A, s.P)).notes;
	const hidden = async (s: Set, body: string) => {
		assert.equal((await w.modelContent(s.A)).includes(body), false, "no model reads it");
		assert.equal(JSON.stringify(ok(await readMyResidency(w.db, await w.authority(s.R)))).includes(body), false);
		assert.equal(JSON.stringify(await w.goals(s.A)).includes(body), false);
		assert.equal(
			await w.count(sql`SELECT count(*)::int AS n FROM audit_event a WHERE a.tenant_id=${s.O.id}
				AND strpos(a::text,${body})>0`),
			0,
			"the audit holds no words",
		);
	};
	await t.test("logging writes one exact event and the conversation stands once", async () => {
		const s = await pair();
		await w.link(s.O, s.P, s.R);
		const id = randomUUID();
		const before = (await history(s.O.id, s.P)).length;
		const logged = await w.recorded(async () => ok(await log(s, s.P, "2026-10-16T20:00:00Z", NOTE, id)));
		assert.deepEqual(logged.value, { conversationId: id, revision: "1" });
		assert.deepEqual(logged.added, { audits: ["people.recorded"], jobs: [], notices: 0, mail: 0 });
		assert.deepEqual((await history(s.O.id, s.P)).slice(before), [
			{
				actor_id: s.A.id,
				tenant_id: s.O.id,
				action: "people.recorded",
				kind: "create",
				subject_id: s.P,
				revision_after: 1,
				metadata: { category: "leadership_conversation", conversationId: id },
			},
		]);
		ok(await w.untouched(() => log(s, s.P, "2026-10-16T20:00:00Z", NOTE, id)));
		const read = ok(await w.record(s.A, s.P)).conversations;
		assert.deepEqual(
			read.map((c) => [c.on, c.metBy, c.note]),
			[["2026-10-16", "Alex", NOTE]],
		);
		await hidden(s, NOTE);
		refusedWith(await w.untouched(() => w.record(s.R, s.P)));
		refusedWith(await w.untouched(() => w.record(s.D, s.P)));
		refusedWith(await w.untouched(() => log(s, s.P, "2026-10-18T05:00:00Z", NOTE)), "invalid_input", "occurredOn");
	});
	await t.test("a quarter counts the days of the organization's calendar, with no words", async () => {
		const s = await pair();
		for (const [personId, instant] of [
			[s.P, "2026-10-01T05:00:00Z"],
			[s.Q, "2026-10-16T20:00:00Z"],
			[s.P, "2026-10-01T04:59:59Z"],
		] as const)
			ok(await log(s, personId, instant, NOTE));
		const read = await w.untouched(() => w.goals(s.A));
		const quarter = (year: number, q: number) =>
			read.conversations.quarters.find((x) => x.year === year && x.quarter === q)?.count;
		assert.deepEqual([quarter(2026, 4), quarter(2026, 3)], [2, 1]);
		assert.deepEqual(
			read.conversations.months.filter((m) => m.count).map((m) => [m.month, m.count]),
			[
				["2026-09", 1],
				["2026-10", 2],
			],
		);
		assert.equal(JSON.stringify(read).includes(NOTE), false);
		assert.equal((await w.modelContent(s.A)).includes(NOTE), false);
	});
	const add = async (s: Set, by: Actor, body: string, noteId = randomUUID()) => {
		ok(await pipelineWriter.addNote(w.db, await w.authority(by), { personId: s.P, noteId, body }));
		return noteId;
	};
	await t.test("the author adds a note with one exact event", async () => {
		const s = await pair();
		const body = "Casey asked to meet on Tuesday";
		const before = (await history(s.O.id, s.P)).length;
		const noteId = randomUUID();
		const added = await w.recorded(() => add(s, s.A, body, noteId));
		assert.deepEqual(added.added, { audits: ["people.updated"], jobs: [], notices: 0, mail: 0 });
		assert.deepEqual((await history(s.O.id, s.P)).slice(before), [
			{
				actor_id: s.A.id,
				tenant_id: s.O.id,
				action: "people.updated",
				kind: "create",
				subject_id: s.P,
				revision_after: 1,
				metadata: { category: "note", noteId },
			},
		]);
		assert.deepEqual(
			(await noteIn(s)).map((n) => n.state === "current" && [n.body, n.author, n.mine]),
			[[body, "Alex", true]],
		);
		await hidden(s, body);
	});
	const PRIVATE = "Casey requested a private staff follow-up.";
	await t.test("the author edits the note, then removes its body from everywhere", async () => {
		const s = await pair();
		const noteId = await add(s, s.A, PRIVATE);
		const body = "Casey asked to meet on Wednesday";
		const edit = async (expectedRevision: string) =>
			pipelineWriter.editNote(w.db, await w.authority(s.A), { noteId, expectedRevision, body });
		assert.deepEqual(ok(await edit("1")), { noteId, revision: "2" });
		assert.deepEqual(
			(await noteIn(s)).map((n) => n.state === "current" && [n.body, n.author, n.revision]),
			[[body, "Alex", "2"]],
		);
		refusedWith(await w.untouched(() => edit("1")), "conflict");
		ok(await pipelineWriter.removeNote(w.db, await w.authority(s.A), { noteId, expectedRevision: "2" }));
		assert.deepEqual(await noteIn(s), [
			{ state: "removed", id: noteId, author: "Alex", avatar: null, removedOn: "2026-10-17" },
		]);
		assert.deepEqual(await w.rows(sql`SELECT body FROM person_note WHERE id=${noteId}`), [{ body: "" }]);
		for (const words of [PRIVATE, body]) await hidden(s, words);
	});
	await t.test("an Admin cannot change another author's note", async () => {
		const s = await pair("admin");
		const other = await w.actor(s.O, "admin", { user: { name: "Devon" } });
		const noteId = await add(s, other, PRIVATE);
		refusedWith(
			await w.untouched(async () =>
				pipelineWriter.editNote(w.db, await w.authority(s.A), {
					noteId,
					expectedRevision: "1",
					body: "Changed by a different person",
				}),
			),
		);
		refusedWith(
			await w.untouched(async () =>
				pipelineWriter.removeNote(w.db, await w.authority(s.A), { noteId, expectedRevision: "1" }),
			),
		);
		assert.deepEqual(
			(await noteIn(s)).map((n) => n.state === "current" && n.body),
			[PRIVATE],
		);
	});
	await t.test("the pipeline lists each person with their stage label", async () => {
		const s = await pair();
		const b = await w.untouched(() => w.board(s.A));
		assert.deepEqual(
			b.stages.flatMap((x) => x.people.map((p) => [p.name, x.label])),
			[
				["Casey L.", "Potential leader"],
				["Casey Lee", "Potential leader"],
			],
		);
		assert.equal(
			b.stages.reduce((n, x) => n + x.count, 0),
			2,
		);
	});
});

test("AC:ADR1-005 AC:WP011-MUL-005 the export follows current consent, and removal on request clears the person, ends the link, keeps one count and reaches every later download", async (t) => {
	async function linked(choices = { shareFoundations: true, shareMilestones: true }) {
		const s = await w.scene();
		const P = await w.place(s.A, "Casey Lee", { email: "casey@example.test", responsible: s.seats.A });
		const L = await w.link(s.O, P, s.R, choices);
		const Program = await w.residency(s.A, s.seats.A, s.A);
		const completed = await w.enroll(s.A, Program, P);
		ok(
			await programWriter.endEnrollment(w.db, await w.authority(s.A), {
				enrollmentId: completed,
				expectedRevision: (await w.enrollment(s.A, completed)).revision,
				outcome: "completed",
			}),
		);
		const E = await w.enroll(s.A, Program, P);
		const milestone = (await w.enrollment(s.A, E)).milestones[0]!.id;
		ok(await pipelineWriter.addNote(w.db, await w.authority(s.A), { personId: P, noteId: randomUUID(), body: "NOTE" }));
		ok(
			await programWriter.addFeedback(w.db, await w.authority(s.A), {
				feedbackId: randomUUID(),
				enrollmentId: E,
				milestoneId: milestone,
				body: "FEEDBACK-BODY",
			}),
		);
		await w.admin.execute(
			sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${randomUUID()},${s.R.id}::uuid,'native','PRIVATE-DOCUMENT')`,
		);
		const exported = async () => ok(await readPipelineExport(w.db, await w.authority(s.A))).text;
		return { ...s, P, L, Program, completed, E, exported };
	}
	await t.test(
		"the export names the person, organization and program, and holds no private content or unshared progress",
		async () => {
			const s = await linked({ shareFoundations: false, shareMilestones: true });
			const text = await w.untouched(s.exported);
			const lines = text.split("\r\n");
			assert.ok(lines[0]!.includes("Grace Austin pipeline export"));
			assert.ok(lines.some((l) => l.startsWith(`person,${s.P},Casey Lee,`)));
			assert.equal(
				lines.filter((l) => l.startsWith(`enrollment,${s.P},Casey Lee,`) && l.includes("Residency")).length,
				2,
			);
			for (const absent of ["NOTE", "FEEDBACK-BODY", "PRIVATE-DOCUMENT", "foundation", s.R.email])
				assert.equal(text.replace(lines[3]!, "").includes(absent), false, absent);
		},
	);
	for (const kind of ["sending_church", "sending_network"] as const)
		await t.test(`removal from a ${kind} clears, ends, witnesses and keeps only the named count`, async () => {
			const s = await linked();
			await w.admin.execute(sql`UPDATE organization SET kind=${kind} WHERE id=${s.O.id}`);
			assert.ok((await s.exported()).includes("Casey Lee"));
			const removed = await w.recorded(async () =>
				ok(
					await pipelineDataWriter.removePerson(w.db, await w.authority(s.A), {
						personId: s.P,
						expectedRevision: ok(await w.record(s.A, s.P)).revision,
					}),
				),
			);
			assert.deepEqual(removed.added, { audits: ["people.removed"], jobs: [], notices: 0, mail: 0 });
			const report = removed.value;
			assert.equal(report.removed.residencyLinkEnded, true);
			assert.deepEqual([report.removed.notes, report.removed.feedback], [1, 1]);
			assert.deepEqual(report.kept, [
				{ category: "program_completion_count", count: 1 },
				{ category: "activity_record", count: null },
				{ category: "removal_record", count: null },
			]);
			assert.equal(report.attribution, "Former participant");
			assert.equal(
				/deadline|cancel|until/i.test(JSON.stringify(report)),
				false,
				"no cancellation or retention deadline",
			);
			assert.deepEqual(
				await w.rows(sql`SELECT display_name,first_name,last_name,email,phone,street,city,state_province,postal_code,country,
					notes,linked_account_id,state FROM person WHERE id=${s.P}`),
				[
					{
						display_name: "Former participant",
						first_name: null,
						last_name: null,
						email: null,
						phone: null,
						street: null,
						city: null,
						state_province: null,
						postal_code: null,
						country: null,
						notes: null,
						linked_account_id: null,
						state: "retired",
					},
				],
			);
			assert.deepEqual(
				await w.rows(sql`SELECT (ended_at AT TIME ZONE 'UTC')::date::text AS ended,account_id,share_foundations,
					share_milestones FROM residency_link WHERE id=${s.L}`),
				[{ ended: "2026-10-17", account_id: null, share_foundations: false, share_milestones: false }],
			);
			assert.deepEqual(
				await w.rows(sql`SELECT organization_id,requested_by,witness_checkpoint::int AS checkpoint,
					(removed_at AT TIME ZONE 'UTC')::date::text AS on FROM organization_person_removal
					WHERE person_record_id=${s.P}`),
				[{ organization_id: s.O.id, requested_by: s.A.id, checkpoint: 1, on: "2026-10-17" }],
			);
			assert.deepEqual(
				await w.rows(sql`SELECT id,status FROM development_enrollment WHERE person_id=${s.P}`),
				[{ id: s.completed, status: "completed" }],
				"only the completion stays, for its count",
			);
			for (const q of [
				sql`SELECT count(*)::int AS n FROM person_note WHERE person_id=${s.P}`,
				sql`SELECT count(*)::int AS n FROM assignment_feedback WHERE organization_id=${s.O.id}`,
				sql`SELECT count(*)::int AS n FROM audit_event a WHERE a.tenant_id=${s.O.id} AND strpos(a::text,'Casey')>0`,
			])
				assert.equal(await w.count(q), 0);
			refusedWith(await w.record(s.A, s.P));
			const later = await w.untouched(s.exported);
			for (const gone of [s.P, "Casey Lee", "casey@example.test"]) assert.equal(later.includes(gone), false, gone);
			assert.deepEqual(ok(await readMyResidency(w.db, await w.authority(s.R))), { status: "not_linked" });
			refusedWith(
				await w.untouched(async () =>
					pipelineDataWriter.removePerson(w.db, await w.authority(s.A), { personId: s.P, expectedRevision: "9" }),
				),
			);
		});
});

test("AC:ADR1-017 duplicates are only suggested, a merge keeps both ends and no consent, and a guarded undo restores the exact split or refuses", async (t) => {
	async function pair(q: { email?: string } = {}) {
		const s = await w.scene();
		const P = await w.place(s.A, "Casey Lee", { email: q.email ?? null, responsible: s.seats.A });
		const Q = await w.place(s.A, "Casey L.", { email: q.email ?? null });
		const L = await w.link(s.O, P, s.R);
		const Program = await w.residency(s.A, s.seats.A, s.A);
		const E = await w.enroll(s.A, Program, P);
		const c = context(s.A, s.O);
		const review = (sourceId = Q, survivorId = P) =>
			w.tx((x) => peopleMerge.getMergeReview(x, c, { sourceId, survivorId }));
		const merge = (reviewDigest: string, over: object = {}, requestKey = randomUUID()) =>
			w.tx((x) =>
				peopleMerge.mergePeople(x, c, {
					requestKey,
					input: { sourceId: Q, survivorId: P, reviewDigest, fieldChoices: { displayName: "survivor" }, ...over },
				}),
			);
		const merged = async () => ok(await merge(ok(await review()).reviewDigest));
		const undo = (mergeId: string, expectedRevision: string, requestKey = randomUUID()) =>
			w.tx((x) => peopleUnmerge.unmergePeople(x, c, { requestKey, expectedRevision, input: { mergeId } }));
		const link = () => w.one(sql`SELECT to_jsonb(l) AS l FROM residency_link l WHERE id=${L}`);
		return { ...s, P, Q, L, E, review, merge, merged, undo, link, c };
	}
	const refusedError = (reply: { status: string; error?: { code?: string; details?: unknown } }, code: string) => {
		assert.equal(reply.status, "refused", JSON.stringify(reply));
		assert.equal(reply.error?.code, code);
		return reply.error.details;
	};
	const states = (s: { P: string; Q: string }) =>
		w.rows(sql`SELECT id,display_name,state,merged_into_person_id,linked_account_id FROM person WHERE id IN (${s.P},${s.Q})
			ORDER BY display_name DESC`);

	await t.test(
		"a reviewed merge retires the source, keeps both ends in history and moves no account consent",
		async () => {
			const s = await pair();
			const before = { link: await s.link(), seats: await seats() };
			const review = ok(await s.review());
			assert.deepEqual(review.blockers.causes, []);
			const key = randomUUID();
			const merged = ok(await s.merge(review.reviewDigest, {}, key));
			assert.deepEqual(await states(s), [
				{ id: s.P, display_name: "Casey Lee", state: "live", merged_into_person_id: null, linked_account_id: s.R.id },
				{ id: s.Q, display_name: "Casey L.", state: "merged", merged_into_person_id: s.P, linked_account_id: null },
			]);
			assert.deepEqual(
				await w.rows(sql`SELECT source_id,survivor_id,unmerged_at FROM person_merge WHERE id=${merged.mergeId}`),
				[{ source_id: s.Q, survivor_id: s.P, unmerged_at: null }],
			);
			assert.deepEqual(
				ok(await w.record(s.A, s.P)).history.map((h) => h.kind),
				["placed", "placed"],
				"both people's placements stay in the history",
			);
			assert.deepEqual({ link: await s.link(), seats: await seats() }, before);
			assert.deepEqual(ok(await w.untouched(() => s.merge(review.reviewDigest, {}, key))).mergeId, merged.mergeId);
		},
	);
	await t.test("a merge with a person of another organization changes nothing", async () => {
		const s = await pair();
		const other = await w.place(s.foreign, "Casey L.");
		const digest = ok(await s.review()).reviewDigest;
		refusedError(await w.untouched(() => s.review(s.P, other)), "unavailable");
		refusedError(await w.untouched(() => s.merge(digest, { sourceId: s.P, survivorId: other })), "unavailable");
		refusedError(await w.untouched(() => s.merge(digest, { sourceId: other, survivorId: s.P })), "unavailable");
	});
	await t.test("an undo is refused once feedback reached the merged person, and the merge stands", async () => {
		const s = await pair();
		const merged = await s.merged();
		ok(
			await programWriter.addFeedback(w.db, await w.authority(s.A), {
				feedbackId: randomUUID(),
				enrollmentId: s.E,
				milestoneId: (await w.enrollment(s.A, s.E)).milestones[0]!.id,
				body: "Please explain the passage",
			}),
		);
		const details = refusedError(
			await w.untouched(() => s.undo(merged.mergeId, merged.survivorRevision)),
			"inverse_conflict",
		);
		assert.deepEqual(details, {
			causes: ["references_changed"],
			changed: ["development_enrollment"],
			changedFields: [],
		});
		assert.equal((await states(s))[1]!.state, "merged");
	});
	await t.test("a shared contact email suggests a person and merges nobody", async () => {
		const s = await pair({ email: "shared@example.test" });
		const found = ok(await w.untouched(() => w.tx((x) => peopleMerge.findDuplicates(x, s.c, { personId: s.P }))));
		assert.deepEqual(
			found.items.map((i) => [i.personId, i.displayName, i.signals]),
			[[s.Q, "Casey L.", ["email"]]],
		);
		assert.deepEqual(
			(await states(s)).map((x) => x.state),
			["live", "live"],
		);
	});
	await t.test("a guarded undo restores the exact split once and changes no seat", async () => {
		const s = await pair();
		const before = { people: await states(s), link: await s.link(), seats: await seats() };
		const merged = await s.merged();
		const key = randomUUID();
		const undone = ok(await s.undo(merged.mergeId, merged.survivorRevision, key));
		assert.deepEqual([undone.sourceId, undone.survivorId, undone.outcome], [s.Q, s.P, "changed"]);
		assert.deepEqual({ people: await states(s), link: await s.link(), seats: await seats() }, before);
		assert.deepEqual(ok(await w.untouched(() => s.undo(merged.mergeId, merged.survivorRevision, key))), undone);
		const again = ok(await s.undo(merged.mergeId, undone.survivorRevision));
		assert.equal(again.outcome, "noop");
		assert.deepEqual(await states(s), before.people);
	});
	await t.test("two people with their own accounts are not merged", async () => {
		const s = await pair();
		const X = await w.actor(null, "owner", { user: { name: "X" } });
		await w.admin.execute(sql`UPDATE person SET linked_account_id=${X.id} WHERE id=${s.Q}`);
		const review = ok(await s.review());
		assert.deepEqual(review.blockers.causes, ["linked_account_collision"]);
		refusedError(await w.untouched(() => s.merge(review.reviewDigest)), "merge_blocked");
	});
});
