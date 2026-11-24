import "../../../platform/setup.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { frozenClock, instant } from "../../../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { createPrivateCare } from "../../../../../packages/domain/src/intelligence/index.ts";
import { createLaunchWriter } from "../../../../../packages/domain/src/launch/index.ts";
import { createAttendanceWriter, guestsWriter } from "../../../../../packages/domain/src/meetings/index.ts";
import { queueJobs } from "../../../../../packages/domain/src/jobs/queue.ts";
import { registry } from "../../../../../packages/domain/src/people/person-reference-registry/index.ts";
import { commitments } from "../../../../../packages/domain/src/people/index.ts";
import { deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../../../packages/domain/src/settings/deletion.ts";
import { readViewer } from "../../../../../packages/domain/src/access/session.ts";
import { teamsWriter, trainingReader, trainingWriter } from "../../../../../packages/domain/src/teams/index.ts";
import { accountId } from "../../../../../packages/contracts/src/common/values.ts";
import { sql } from "../../../../../packages/db/src/query.ts";
import { openedDeletion } from "../../../../support/deletion-cookie.mts";
import { ok, refused, waitingOnLock, type Actor } from "../../../../support/fixture.mts";
import { freezeClock } from "../knowledge/support.mts";
import { caseOf, key, world, type Row } from "./support.mts";

const w = await world("wp091gates");
const { write, P, Q, ctx, tx, rows, one, insert, person, personRow, db } = w;
after(() => w.database.close());
await w.admin.execute(sql`INSERT INTO launch(plant_id,status) VALUES(${P},'planning')`);
const attendance = createAttendanceWriter({ reminders: async () => undefined });
const authority = async (actor: Pick<Actor, "session">) => {
	const found = await RequestActor.resolve(db, actor.session);
	assert.ok(found instanceof RequestActor);
	return found;
};
const meeting = (type = "vision_meeting", values: Row = {}) =>
	insert("meeting", {
		type,
		local_date: "2026-10-01",
		local_time: "18:00",
		timezone: "America/Chicago",
		starts_at: "2026-10-01T23:00:00Z",
		resolver_version: "1",
		status: "in_progress",
		attendance_revision: 1,
		...values,
	});
const attendanceRevision = async (meetingId: string) =>
	String((await one(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${meetingId}::uuid`)).r);
const finalizeRequest = async (meetingId: string, attendeeIds: string[]) => ({
	requestKey: key(),
	expectedRevision: await attendanceRevision(meetingId),
	input: { meetingId, attendeeIds },
});
const finalize = (request: Awaited<ReturnType<typeof finalizeRequest>>) =>
	write.meetings(attendance.finalizeAttendance, request);
const attended = async (meetingId: string) =>
	(
		await rows(sql`SELECT person_id FROM participation WHERE meeting_id=${meetingId}::uuid AND presence='attended'
			AND removed_at IS NULL`)
	).map((r) => r.person_id);
const names = async (ids: unknown[], known: Record<string, string>) =>
	ids.map((id) => Object.entries(known).find(([, v]) => v === id)?.[0] ?? id).sort();

test("AC:TARGET-MTG-020 finalize records each attendee once, rolls back on a fault and replaces an attendee without losing contact history", async () => {
	const c = caseOf("meetings-follow-up", "TARGET-MTG-020");
	const [rollback, replaced] = c.subcases!;
	const people = { Alex: await person("Alex"), Casey: await person("Casey", { stage: "leader" }) };
	const m = await meeting();
	const work = async () =>
		one(sql`SELECT (SELECT count(*)::int FROM task t JOIN obligation o ON o.id=t.obligation_id
				WHERE o.meeting_id=${m}::uuid AND o.kind='evaluation') AS evaluation,
			(SELECT count(*)::int FROM obligation WHERE meeting_id=${m}::uuid AND kind='follow_up') AS follow_up,
			(SELECT count(*)::int FROM task t JOIN obligation o ON o.id=t.obligation_id WHERE o.meeting_id=${m}::uuid) AS tasks,
			(SELECT count(*)::int FROM meeting WHERE id=${m}::uuid AND finalized_at IS NOT NULL) AS finalized`);
	const request = await finalizeRequest(m, Object.values(people));

	const before = await w.everything();
	const error_code = await w.commitFault("obligation", () =>
		tx((t) => attendance.finalizeAttendance(t, ctx(), request)),
	);
	assert.deepEqual(await w.changed(before), []);
	const none = await work();
	assert.deepEqual(
		{
			error_code,
			tasks_added: none.tasks,
			obligations_added: none.follow_up,
			completion_markers_added: none.finalized,
		},
		rollback!.expected.result,
	);

	const first = ok(await finalize(request));
	const made = await work();
	ok(await finalize(request));
	const again = await work();
	assert.deepEqual(
		{
			attendee_ids: await names(await attended(m), people),
			evaluation_tasks: made.evaluation,
			contact_obligations: made.follow_up,
			replay_new_tasks: Number(again.tasks) - Number(made.tasks),
			owner_label: first.work.every((x: { needsOwner: boolean }) => x.needsOwner) ? "Needs owner" : "Owned",
		},
		c.expected.result,
	);

	await insert("contact_outcome", {
		person_id: people.Alex,
		outcome: "contacted",
		occurred_at: "2026-10-02T12:00:00Z",
		recorded_at: "2026-10-02T12:00:00Z",
		contact_channel: "phone",
	});
	const contacts = () => rows(sql`SELECT to_jsonb(x) AS row FROM contact_outcome x ORDER BY x.id`);
	const history = await contacts();
	const jamie = await person("Jamie");
	ok(
		await write.meetings(attendance.reconcileAttendance, {
			requestKey: key(),
			expectedRevision: await attendanceRevision(m),
			input: { meetingId: m, attendeeIds: [jamie], reason: "Sign-in sheet" },
		}),
	);
	const kept = await contacts();
	assert.deepEqual(kept, history);
	assert.deepEqual(
		{
			attendee_ids: await names(await attended(m), { Jamie: jamie }),
			performed_contact_history_removed: history.length - kept.length,
		},
		replaced!.expected.result,
	);
});

test("AC:GAP-MTG-011 a walk-in makes one Person and one attendance; another church, and a failed write, make none", async () => {
	const c = caseOf("meetings-follow-up", "GAP-MTG-011");
	const subcase = (name: string) => c.subcases!.find((s) => s.name === name)!;
	const m = await meeting();
	const count = async () =>
		one<{
			people: number;
			links: number;
		}>(sql`SELECT (SELECT count(*)::int FROM person WHERE plant_id=${P}::uuid) AS people,
			(SELECT count(*)::int FROM participation WHERE meeting_id=${m}::uuid) AS links`);
	const request = { requestKey: key(), input: { meetingId: m, displayName: "Jamie" } };
	const walkIn = (who: "admin" | "foreign" = "admin") => write.meetings(guestsWriter.createWalkInContact, request, who);

	const before = await w.everything();
	const reply = await walkIn("foreign");
	const error = refused(reply);
	assert.deepEqual(error.details, {});
	assert.equal(JSON.stringify(reply).includes("Jamie"), false);
	assert.deepEqual(
		{
			error_code: "access_denied",
			forbidden_body: null,
			forbidden_existence: null,
			domain_writes: (await w.changed(before)).length,
			provider_effects: (await w.changed(before)).length,
		},
		subcase("foreign-context-refused").expected.result,
	);
	const error_code = await w.commitFault("participation", () =>
		tx((t) => guestsWriter.createWalkInContact(t, ctx(), request)),
	);
	const touched = await w.changed(before);
	assert.deepEqual(
		{
			error_code,
			new_domain_writes: touched.length,
			new_provider_effects: touched.length,
			prior_committed_outcomes_retained: touched.length === 0,
		},
		subcase("required-boundary-failure").expected.result,
	);

	const start = await count();
	const made = ok(await walkIn());
	const once = await count();
	ok(await walkIn());
	assert.deepEqual(
		{
			people_added: once.people - start.people,
			attendance_links_added: once.links - start.links,
			name: (await personRow(made.guest.person.personId)).display_name,
			replay_new_people: (await count()).people - once.people,
		},
		c.expected.result,
	);
});

test("AC:ORG55-007 only the Owner can delete the workspace, and no transfer is offered", async () => {
	const c = caseOf("identity-access", "ORG55-007");
	const plant = await w.database.plant();
	const owner = await w.database.actor(plant, "owner"),
		admin = await w.database.actor(plant, "admin");
	const deletion = deletionOperations({
		queue: (t, i) =>
			queueJobs(t, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: "purge/" + i.requestId,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
		workspaceNotice: async () => {},
	});
	const ask = async (who: Actor) =>
		tx(async (t) =>
			deletion.requestWorkspaceDeletion(
				t,
				{ session: who.session, selected: plant as never },
				{
					requestKey: key(),
					expectedRevision: await w.revisionOf("plant", plant.id),
					input: { plant, confirmed: true },
				},
			),
		);
	const before = await w.everything();
	refused(await ask(admin));
	assert.deepEqual(await w.changed(before), []);
	assert.equal((c.subcases![0]!.expected as Row).error_code, "access_denied");
	const asked = ok(await ask(owner));
	assert.equal(asked.status, "pending_deletion");
	assert.deepEqual(
		{
			allowed: true,
			self_service_transfer: Object.keys(deletion).some((name) => /transfer|rejoin|replace/i.test(name)),
		},
		c.expected.result,
	);
});

test("AC:TARGET-IDN-031 merging, unmerging and relinking a person never moves a private care note or shows it to another Admin", async () => {
	const c = caseOf("identity-access", "TARGET-IDN-031");
	const now = "2026-10-13T16:00:00.000Z";
	const care = createPrivateCare({ clock: { now: () => instant.parse(now) } });
	const plant = await w.database.plant();
	const a = await w.database.actor(plant, "admin"),
		b = await w.database.actor(plant, "admin");
	for (const who of [a, b])
		await w.admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${who.id}`);
	const answers = { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" };
	const saved = ok(
		await care.save(db, await authority(a), {
			requestKey: key(),
			expectedRevision: "0",
			input: { answers, note: "CARE-CANARY" },
		}),
	);
	const stored = () =>
		rows(sql`SELECT to_jsonb(x) AS week,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.revision) FROM private_week_revision r
			WHERE r.week_id=x.id) AS revisions FROM private_week x WHERE x.plant_id=${plant.id}::uuid`);
	const before = await stored();
	const otherReads = async () => {
		const actor = await authority(b);
		const current = ok(await care.readCurrent(db, actor, {}));
		const all = [current, ok(await care.readHistory(db, actor, { page: 1 })), ok(await care.readTrends(db, actor, {}))];
		const guess = {
			requestKey: key(),
			expectedRevision: "0",
			input: { weekId: saved.week.id, answers, note: "" },
		};
		const guessed = refused(await care.correct(db, actor, guess), "not_found");
		const missing = refused(
			await care.correct(db, actor, {
				...guess,
				requestKey: key(),
				input: { ...guess.input, weekId: key() },
			}),
			"not_found",
		);
		const text = JSON.stringify(all);
		return {
			body: text.includes("CARE-CANARY") ? text : null,
			existence:
				text.includes(saved.week.id!) ||
				guessed.code !== missing.code ||
				JSON.stringify(guessed.details) !== JSON.stringify(missing.details)
					? "known"
					: null,
			calendar: current.week.id,
			support_nudge: text.includes("strained") ? text : null,
			individual_delete_registered: Object.keys(care).some((name) => /delete|remove/i.test(name)),
		};
	};
	const selected = { kind: "plant" as const, id: plant.id };
	const as = (who: Actor) => ({ session: who.session, selected: selected as never });
	const { peopleMerge, peopleUnmerge, peopleWriter, peopleReader } =
		await import("../../../../../packages/domain/src/people/index.ts");
	const make = async (displayName: string) =>
		ok(
			await tx((t) =>
				peopleWriter.createPerson(t, as(b), {
					requestKey: key(),
					input: { displayName, adultClassification: "adult" },
				}),
			),
		).person.id;
	const casey = await make("Casey Rivera"),
		alex = await make("Alex Rivera");
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${casey}::uuid`);
	const { reviewDigest } = ok(
		await tx((t) => peopleMerge.getMergeReview(t, as(b), { sourceId: alex, survivorId: casey })),
	);
	const merged = ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, as(b), {
				requestKey: key(),
				input: { sourceId: alex, survivorId: casey, reviewDigest },
			}),
		),
	);
	assert.deepEqual(await stored(), before);
	assert.deepEqual(await otherReads(), c.expected.result);
	const shared = JSON.stringify([
		await rows(sql`SELECT to_jsonb(e) AS e FROM audit_event e WHERE e.tenant_id=${plant.id}::uuid`),
		ok(await tx((t) => peopleReader.getActivities(t, as(b), { personId: casey, limit: 100, page: 1 }))),
	]);
	assert.ok(!shared.includes("CARE-CANARY") && !shared.includes(saved.week.id!), shared);
	const p = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, as(b), { mergeId: merged.mergeId })));
	ok(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, as(b), {
				requestKey: key(),
				expectedRevision: p.reviewRevision,
				input: { mergeId: merged.mergeId },
			}),
		),
	);
	assert.deepEqual(await stored(), before);
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${b.id} WHERE id=${casey}::uuid`);
	assert.deepEqual(await stored(), before);
	assert.deepEqual(await otherReads(), c.expected.result);
	const own = ok(await care.readCurrent(db, await authority(a), {}));
	assert.deepEqual([own.week.id, own.week.answer?.note], [saved.week.id, "CARE-CANARY"]);
});

test("AC:TARGET-PPL-020 each recorded event advances a stage once and nothing moves it back", async () => {
	const c = caseOf("people", "TARGET-PPL-020");
	const inputs = c.given["case-input"] as { prior_stages: string[]; events: string[] };
	const stage = async (id: string) => String((await one(sql`SELECT stage FROM person WHERE id=${id}::uuid`)).stage);
	const changes = async (id: string) =>
		Number(
			(
				await one(
					sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${id}::uuid AND action='people.stage_changed'`,
				)
			).n,
		);
	const material = async () =>
		BigInt(String((await one(sql`SELECT material_revision::text AS r FROM plant WHERE id=${P}::uuid`)).r));
	const role = async (leadership: boolean) => {
		const team = await insert("team", { name: `Team ${key()}`, state: "active", sort_order: 1 });
		return {
			team,
			id: await insert("team_role", { team_id: team, name: "Role", leadership, sort_order: 1 }),
		};
	};
	const assign = async (r: { team: string; id: string }, personId: string) => ({
		requestKey: key(),
		expectedRevision: await w.revisionOf("team_role", r.id),
		input: { roleId: r.id, teamId: r.team, personId },
	});
	const stages: string[] = [];
	let duplicates = 0,
		atomic = true,
		withdrawal = false,
		removal = false,
		launch = false;
	for (const [n, prior] of inputs.prior_stages.entries()) {
		const id = await person(`Stage ${n}`, { stage: prior });
		const start = await material();
		const event = inputs.events[n];
		let removeFrom: string | null = null;
		const run = async (): Promise<() => Promise<unknown>> => {
			if (event === "vision_attended") {
				const request = await finalizeRequest(await meeting(), [id]);
				return () => finalize(request);
			}
			const r = await role(event === "ministry_leadership");
			removeFrom = r.team;
			const request = await assign(r, id);
			return () => write.teams(teamsWriter.assignRole, request);
		};
		const record = await run();
		ok((await record()) as { status: string });
		const once = await changes(id);
		atomic &&= (await material()) > start;
		ok((await record()) as { status: string });
		duplicates += (await changes(id)) - once;
		const reached = await stage(id);
		stages.push(reached);

		const card = ok(
			await write.people(commitments.createCommitment, {
				requestKey: key(),
				input: { personId: id, kind: "core_group", occurredOn: "2026-10-01" },
			}),
		);
		const committed = await stage(id);
		ok(
			await write.people(commitments.withdrawCommitment, {
				requestKey: key(),
				expectedRevision: card.person.revision,
				input: { personId: id, effectiveOn: "2026-10-02" },
			}),
		);
		withdrawal ||= (await stage(id)) !== committed;
		if (removeFrom) {
			const teamId = removeFrom;
			ok(
				await write.teams(teamsWriter.endMembership, {
					requestKey: key(),
					expectedRevision: await w.revisionOf("team", teamId),
					input: { teamId, personId: id },
				}),
			);
			removal ||= (await stage(id)) !== committed;
		}
		const launches = createLaunchWriter({
			notices: async () => undefined as never,
			clock: frozenClock(instant.parse("2026-10-13T16:00:00.000Z")),
		});
		const planned = await rows<{ revision: string }>(sql`SELECT revision::text FROM launch WHERE plant_id=${P}::uuid`);
		ok(
			await launches.schedule(db, await authority(w.actors.owner), {
				requestKey: key(),
				expectedRevision: planned[0]?.revision ?? "0",
				input: { date: `2027-0${n + 1}-03`, reason: n ? "Room changed" : null },
			}),
		);
		launch ||= (await stage(id)) !== committed;
	}
	assert.deepEqual(
		{
			stages,
			duplicate_events: duplicates,
			withdrawal_demotes: withdrawal,
			role_removal_demotes: removal,
			launch_date_demotes: launch,
			assessment_input_state_atomic: atomic,
		},
		c.expected.result,
	);
	const failed = await person("Stage fault");
	const request = await finalizeRequest(await meeting(), [failed]);
	await w.commitFault("audit_event", () => tx((t) => attendance.finalizeAttendance(t, ctx(), request)));
	assert.deepEqual([await stage(failed), await changes(failed)], ["prospect", 0]);
});

test("AC:TARGET-PPL-024 attendance and training writes that race a merge or a retirement never land on the person who left", async () => {
	const c = caseOf("people", "TARGET-PPL-024");
	const program = await insert("training_program", { name: "Welcome", required: true });
	const racing = {
		attendance: async (personId: string) => {
			const m = await meeting();
			return () =>
				write.meetings(guestsWriter.inviteGuest, {
					requestKey: key(),
					input: { meetingId: m, personId },
				});
		},
		training: async (personId: string) => {
			const seen = ok(
				await trainingReader.readRequiredTrainingPreview(db, await authority(w.actors.admin), {
					programId: program,
					personIds: [personId],
				}),
			);
			return () =>
				write.teams(trainingWriter.setRequiredTrainingParticipants, {
					requestKey: key(),
					expectedRevision: seen.revision,
					input: { programId: program, personIds: [personId], rosterDigest: seen.rosterDigest },
				});
		},
	};
	const { peopleMerge, peopleWriter } = await import("../../../../../packages/domain/src/people/index.ts");
	const left: string[] = [];
	for (const leaving of ["merge", "retire"] as const)
		for (const consumer of ["attendance", "training"] as const) {
			const p1 = await person("Jordan Lee"),
				p2 = await person("Jordan L.");
			left.push(p2);
			const write = await racing[consumer](p2);
			const reviewDigest = leaving === "merge" ? await w.digestOf(p2, p1) : "";
			const retirement = await w.retireRequest(p2);
			const { promise: hold, resolve: release } = Promise.withResolvers<void>();
			const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
			const first = tx(async (t) => {
				ok(
					leaving === "merge"
						? await peopleMerge.mergePeople(t, ctx(), {
								requestKey: key(),
								input: { sourceId: p2, survivorId: p1, reviewDigest },
							})
						: await peopleWriter.retirePerson(t, ctx(), retirement, async () => undefined as never),
				);
				wrote();
				await hold;
			});
			await written;
			const late = write();
			await waitingOnLock(db);
			release();
			await first;
			assert.equal((await late).status, "refused", `${leaving} ${consumer}`);
		}
	const current = async () => {
		let n = 0;
		for (const e of registry) {
			if (e.treatment === "keep") continue;
			n += Number(
				(
					await one(
						sql`SELECT count(*)::int AS n FROM ${sql.identifier(e.table)} WHERE ${sql.identifier(e.column)}=ANY(${sql.param(left)}::uuid[])`,
					)
				).n,
			);
		}
		return n;
	};
	const declared = await rows<{
		t: string;
		col: string;
	}>(sql`SELECT c.conrelid::regclass::text AS t,a.attname AS col
		FROM pg_constraint c JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(n,i) ON k.i=1
		JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n
		WHERE c.contype='f' AND c.confrelid=${w.database.schema + ".person"}::regclass`);
	const registered = new Set(registry.map((e) => `${e.table}.${e.column}`));
	const { readFileSync } = await import("node:fs");
	const policies = JSON.parse(
		readFileSync(new URL("../../../../../docs/architecture/person-references.json", import.meta.url), "utf8"),
	) as { person_references: { table: string; columns: string[]; inverse_policy: string }[] };
	const withInverse = new Set(
		policies.person_references.filter((x) => x.inverse_policy).map((x) => `${x.table}.${x.columns[0]}`),
	);
	const columns = declared.map((d) => `${d.t.replace(w.database.schema + ".", "")}.${d.col}`);
	assert.deepEqual(
		{
			unregistered_references: columns.filter((x) => !registered.has(x)).length,
			references_to_retired_source: await current(),
			foreign_references: Number(
				(
					await one(sql`SELECT count(*)::int AS n FROM participation g JOIN person x ON x.id=g.person_id
					WHERE g.plant_id<>x.tenant_id OR g.plant_id=${Q}::uuid`)
				).n,
			),
			missing_inverse_policies: columns.filter((x) => !withInverse.has(x)),
		},
		c.expected.result,
	);
});

test("AC:TARGET-IDN-032 at the deadline the request cannot be cancelled, access stays closed and church records stay", async () => {
	const c = caseOf("identity-access", "TARGET-IDN-032");
	const inputs = c.given["case-input"] as { requested_at: string; cancel_at: string };
	const deadline = new Date(inputs.cancel_at);
	const deletion = deletionOperations({
		queue: (t, i) =>
			queueJobs(t, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: "purge/" + i.requestId,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
		workspaceNotice: async () => {},
	});
	const a = await w.database.actor(w.database.tenant, "admin");
	const note = await insert("person_note", {
		tenant_id: P,
		person_id: await person("Shared person"),
		author_id: a.id,
		body: "Church record",
		occurred_at: "2026-10-01T12:00:00Z",
		recorded_at: "2026-10-01T12:00:00Z",
	});
	const requestId = key();
	const witness = await insert("lifecycle_witness", {
		plant_id: undefined,
		kind: "account",
		opaque_subject_id: a.id,
		account_id: a.id,
		request_id: requestId,
		requester_id: a.id,
		requester_opaque_id: a.id,
		request_revision: 1,
		state: "pending_deletion",
		requested_at: inputs.requested_at,
		cancel_until: inputs.cancel_at,
		witness_checkpoint: 1,
		cleanup_state: "not_started",
	});
	await w.admin.execute(sql`SELECT settings_suspend_subject(${witness}::uuid,${requestId}::uuid)`);
	await freezeClock(w.admin, w.database.schema, deadline);
	const subject = { kind: "account" as const, id: accountId.parse(a.id) };
	const proof = await openedDeletion(
		tx((t) =>
			issueRestrictedDeletionSession(t, { subject, requestId }, async () => ({
				accountId: a.id,
				provenAt: deadline,
			})),
		),
		{ subject, requestId },
	);
	const state = () =>
		one(sql`SELECT (SELECT to_jsonb(x) FROM lifecycle_witness x WHERE x.id=${witness}::uuid) AS witness,
				(SELECT to_jsonb(n) FROM person_note n WHERE n.id=${note}::uuid) AS note`);
	const before = await state();
	const reply = await tx((t) =>
		deletion.cancelAccountDeletion(t, proof, {
			requestKey: key(),
			expectedRevision: "1",
			input: { subject, requestId },
		}),
	);
	refused(reply, "deadline_passed");
	const now = await state();
	assert.deepEqual(now, before);
	const copyExpiry = (x: Row) => (x.witness as Row).copy_expires_at;
	assert.deepEqual(
		{
			normal_access: (await readViewer(db, a.session)) !== null,
			cancel_allowed: reply.status === "ok",
			shared_facts_preserved: JSON.stringify(now.note) === JSON.stringify(before.note),
			copy_expiry_reset: copyExpiry(now) !== copyExpiry(before),
		},
		c.expected.result,
	);
});
