import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { sql } from "../../../packages/db/src/query.ts";
import { accountId } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	createOrganizationAdapter,
	pipelineDataWriter,
	programWriter,
	readMyResidency,
	readPipelineExport,
	readResidentReading,
	readVersionReview,
	residentWriter,
} from "../../../packages/domain/src/organizations/index.ts";
import { raced, type Actor } from "../../support/fixture.mts";
import { ok, refusedWith, sendingWorld, type Scene } from "./sending-world.mts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";
let w: Awaited<ReturnType<typeof sendingWorld>>;
const release = randomUUID(),
	section = randomUUID();
before(async () => {
	w = await sendingWorld("programcases");
	await w.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','framework/start',${GLOBAL})`,
	);
	await w.admin
		.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,
		validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,
		expected_passages) VALUES(${release},${"release-" + release},'memory://synthetic',${randomBytes(32).toString("hex")},
		'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${randomBytes(32).toString("hex")},'v','profile',1,
		${GLOBAL},0)`);
});
after(() => w?.close());

const LEAD = "Lead a small group";
const PRESENT = "Present the vision to sending leadership";
const people = () => w.count(sql`SELECT count(*)::int AS n FROM seat`);
const milestoneOf = <T extends { title: string }>(list: T[], title: string) => {
	const found = list.find((m) => m.title === title);
	assert.ok(found, title);
	return found;
};
const published = async (a: Actor, programId: string) => (await w.program(a, programId)).published!;
const mine = async (a: Actor) => ok(await readMyResidency(w.db, await w.authority(a)));
const linked = async (a: Actor) => {
	const view = await mine(a);
	assert.ok(view.status === "linked", view.status);
	return view;
};
type Plan = { label: string; minMonths: number; maxMonths: number }[];
async function publishNext(
	a: Actor,
	programId: string,
	plan: { stages?: Plan; milestones: { lineage: string; title: string }[]; expectedMonths?: number },
) {
	const p = await w.program(a, programId);
	const saved = ok(
		await programWriter.savePlan(w.db, await w.authority(a), {
			programId,
			expectedRevision: p.revision,
			plan: {
				rhythm: "monthly",
				expectedMonths: plan.expectedMonths ?? 15,
				stages: plan.stages ?? [{ label: "Assimilating", minMonths: 2, maxMonths: 3 }],
				milestones: plan.milestones.map((m) => ({ ...m, description: null, handsOn: false })),
				readings: [],
			},
		}),
	);
	ok(await programWriter.publishVersion(w.db, await w.authority(a), { programId, expectedRevision: saved.revision }));
	return published(a, programId);
}
async function residency(role: "owner" | "admin" | "member" = "admin", shares = {}) {
	const s = await w.scene(role);
	const P = await w.place(s.lead, "Casey Lee", { responsible: s.seats.A });
	const L = await w.link(s.O, P, s.R, shares);
	const director = role === "member" ? s.D : s.A;
	const Program = await w.residency(s.lead, role === "member" ? s.seats.D : s.seats.A, director, [LEAD, PRESENT]);
	const E = await w.enroll(s.lead, Program, P);
	const V1 = await published(s.lead, Program);
	const M = milestoneOf(V1.milestones, LEAD).id;
	return { ...s, P, L, Program, E, V1, M, director };
}
type Residency = Awaited<ReturnType<typeof residency>>;
const mark = async (s: Pick<Residency, "E" | "M">, a: Actor, milestoneId: string = s.M) =>
	residentWriter.markMilestone(w.db, await w.authority(a), { enrollmentId: s.E, milestoneId });
const marked = async (s: Residency, title = LEAD, instant = "2026-10-16T18:00:00Z") => {
	const milestoneId = milestoneOf(s.V1.milestones, title).id;
	ok(await w.at(instant, () => mark(s, s.R, milestoneId)));
};
const completionRow = (s: { E: string; M: string }) =>
	w.rows(sql`SELECT completed_on::text AS completed_on,recorder_id,confirmer_id,
		to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS confirmed_at,source
		FROM enrollment_milestone WHERE enrollment_id=${s.E} AND milestone_id=${s.M}`);
const eventAt = (action: string, subject: string) =>
	w.rows(sql`SELECT actor_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
		FROM audit_event WHERE action=${action} AND subject_id=${subject} ORDER BY occurred_at`);
const stageOf = async (s: Scene & { P: string }) => ok(await w.record(s.lead, s.P)).stage.label;

const adapter = createOrganizationAdapter(
	{
		invitation: async () => {
			throw Error("no relationship invitation here");
		},
		invalidate: (_tx, v) =>
			sql`UPDATE job SET state='superseded' WHERE subject_record_id=${sql.param(v.sourceId)} AND kind='digest' AND false`,
	},
	{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
);
const linkCommand = (
	s: Residency,
	{ consent = "2", revision = consent, choices }: { consent?: string; revision?: string; choices?: object },
) => ({
	requestKey: randomUUID(),
	expectedRevision: revision,
	input: { linkId: s.L, expectedConsentRevision: consent, ...(choices ? { choices } : {}) },
});
const asResident = (a: Actor, name: "residency.setSharing" | "residency.leave", input: unknown) => {
	const owner = { kind: "account" as const, id: accountId.parse(a.id) };
	return gatedTransaction(w.db, async (tx) => {
		if (!(await RequestActor.claimWrite(tx, a.session, owner))) throw Error("unavailable");
		return adapter[name](tx, a.session, owner, input);
	});
};
const readSharing = (a: Actor, linkId: string) =>
	w.tx((tx) =>
		adapter["residency.readSharing"](tx, a.session, { kind: "account", id: accountId.parse(a.id) }, { linkId }),
	);

test("AC:ADR1-003 a resident sees and changes their exact sharing choices, an old approval restores nothing, and leaving ends saved and queued progress", async (t) => {
	const off = { shareFoundations: false, shareMilestones: false };
	const on = { shareFoundations: true, shareMilestones: true };
	await t.test(
		"the resident reads the organization, both choices and the consent state, and no document is shared",
		async () => {
			const s = await residency();
			const document = randomUUID();
			await w.admin.execute(
				sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${document},${s.R.id}::uuid,'native','PRIVATE')`,
			);
			const read = (await w.untouched(() => readSharing(s.R, s.L))) as Record<string, unknown>;
			assert.equal(read.status, "active");
			assert.deepEqual(read.choices, on);
			assert.equal(read.consentRevision, "2");
			assert.ok(JSON.stringify(read).includes(s.O.id));
			const shown = JSON.stringify([
				await w.enrollment(s.A, s.E),
				await w.record(s.A, s.P),
				ok(await readPipelineExport(w.db, await w.authority(s.A))).text,
			]);
			for (const hidden of [document, "PRIVATE"]) assert.equal(shown.includes(hidden), false);
		},
	);
	await t.test(
		"turning both off saves once as the next consent state, and the old approval cannot turn them on",
		async () => {
			const s = await residency();
			const command = linkCommand(s, { choices: off });
			assert.deepEqual(await asResident(s.R, "residency.setSharing", command), { status: "committed" });
			const saved = (await readSharing(s.R, s.L)) as Record<string, unknown>;
			assert.deepEqual([saved.choices, saved.consentRevision], [off, "3"]);
			assert.deepEqual(await w.untouched(() => asResident(s.R, "residency.setSharing", command)), {
				status: "committed",
			});
			for (const stale of [
				linkCommand(s, { choices: on }),
				linkCommand(s, { choices: on, consent: "2", revision: "3" }),
				linkCommand(s, { choices: on, consent: "3", revision: "2" }),
			])
				await w.untouched(() => assert.rejects(asResident(s.R, "residency.setSharing", stale), /stale_revision/));
			assert.deepEqual(await readSharing(s.R, s.L), saved);
			assert.deepEqual((await w.enrollment(s.A, s.E)).resident, {
				status: "linked",
				milestones: "not_shared",
				foundations: { status: "not_shared" },
			});
		},
	);
	await t.test(
		"leaving ends the link; saved and queued progress is refused and the resident keeps their documents",
		async () => {
			const s = await residency();
			await marked(s);
			const document = randomUUID();
			await w.admin.execute(
				sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${document},${s.R.id}::uuid,'native','PRIVATE')`,
			);
			const queued = await w.authority(s.A);
			const held = async () => ok(await readPipelineExport(w.db, queued)).text;
			assert.ok((await held()).includes(`milestone_completed,${s.P}`));
			assert.equal(milestoneOf((await w.enrollment(s.A, s.E)).milestones, LEAD).completion?.source, "resident");
			assert.deepEqual(await asResident(s.R, "residency.leave", linkCommand(s, {})), { status: "committed" });
			assert.deepEqual(await readSharing(s.R, s.L), { status: "ended", linkId: s.L });
			const after = await w.enrollment(s.A, s.E);
			assert.deepEqual(after.resident, { status: "not_linked" });
			assert.equal(milestoneOf(after.milestones, LEAD).completion, null);
			assert.equal(
				(await held()).includes("milestone_completed"),
				false,
				"an export started before the leave holds no mark",
			);
			assert.deepEqual(await w.rows(sql`SELECT tenant_id,title FROM document WHERE id=${document}`), [
				{ tenant_id: s.R.id, title: "PRIVATE" },
			]);
			const ended = await w.rows(sql`SELECT to_jsonb(l) AS l FROM residency_link l WHERE id=${s.L}`);
			for (const consent of ["2", "3"])
				await assert.rejects(
					asResident(s.R, "residency.setSharing", linkCommand(s, { consent, choices: on })),
					/unavailable/,
				);
			await asResident(s.R, "residency.leave", linkCommand(s, {}));
			assert.deepEqual(await w.rows(sql`SELECT to_jsonb(l) AS l FROM residency_link l WHERE id=${s.L}`), ended);
			assert.deepEqual(
				await w.rows(sql`SELECT share_foundations,share_milestones FROM residency_link WHERE id=${s.L}`),
				[{ share_foundations: false, share_milestones: false }],
			);
		},
	);
});

test("AC:ADR1-010 a published change makes a new version for new enrollments only; an apprenticeship starts as a draft and a reader sees what is published", async (t) => {
	await t.test("publishing a changed plan leaves the existing enrollment on its version", async () => {
		const s = await residency();
		const stages = [
			{ label: "Assimilating", minMonths: 2, maxMonths: 3 },
			{ label: "Training and planning", minMonths: 6, maxMonths: 9 },
			{ label: "Gathering", minMonths: 2, maxMonths: 3 },
			{ label: "Sending and planting", minMonths: 2, maxMonths: 3 },
		];
		const titles = [
			"Lead a small group and raise a replacement",
			"Present the vision to sending leadership",
			"Write a church planting prospectus",
		];
		const before =
			await w.rows(sql`SELECT to_jsonb(v) AS v,(SELECT jsonb_agg(m ORDER BY m.id) FROM development_milestone m
			WHERE m.version_id=v.id) AS m FROM development_program_version v WHERE v.id=${s.V1.id}`);
		const V2 = await publishNext(s.A, s.Program, {
			stages,
			milestones: titles.map((title) => ({ lineage: randomUUID(), title })),
		});
		assert.equal(V2.number, 2);
		assert.notEqual(V2.id, s.V1.id);
		assert.deepEqual([V2.rhythm, V2.expectedMonths, V2.publishedOn], ["monthly", 15, "2026-10-17"]);
		assert.deepEqual(
			V2.stages.map(({ label, minMonths, maxMonths }) => ({ label, minMonths, maxMonths })),
			stages,
		);
		assert.deepEqual(
			V2.milestones.map((m) => m.title),
			titles,
		);
		const kept = await w.enrollment(s.A, s.E);
		assert.equal(kept.versionNumber, 1);
		assert.deepEqual(
			kept.milestones.map((m) => m.title),
			[LEAD, PRESENT],
		);
		const pinned = (id: string) => w.rows(sql`SELECT version_id FROM development_enrollment WHERE id=${id}`);
		assert.deepEqual(await pinned(s.E), [{ version_id: s.V1.id }]);
		const Q = await w.place(s.A, "Casey L.");
		const fresh = await w.enroll(s.A, s.Program, Q);
		assert.deepEqual(await pinned(fresh), [{ version_id: V2.id }]);
		assert.deepEqual(
			await w.rows(sql`SELECT to_jsonb(v) AS v,(SELECT jsonb_agg(m ORDER BY m.id) FROM development_milestone m
				WHERE m.version_id=v.id) AS m FROM development_program_version v WHERE v.id=${s.V1.id}`),
			before,
			"a published version never changes",
		);
	});
	await t.test("an apprenticeship is created once, with its director and rhythm, unpublished", async () => {
		const s = await w.scene();
		const request = {
			programId: randomUUID(),
			kind: "apprenticeship",
			name: "Apprenticeship",
			directorSeatId: s.seats.A,
			plan: { rhythm: "every_two_weeks", expectedMonths: 12, stages: [], milestones: [], readings: [] },
		};
		const create = async () => programWriter.createProgram(w.db, await w.authority(s.A), request);
		ok(await create());
		ok(await w.untouched(create));
		const read = await w.program(s.A, request.programId);
		assert.deepEqual(
			[read.kind, read.director.seatId, read.published, read.draft?.rhythm, read.draft?.expectedMonths],
			["apprenticeship", s.seats.A, null, "every_two_weeks", 12],
		);
		assert.equal(
			await w.count(sql`SELECT count(*)::int AS n FROM development_program WHERE organization_id=${s.O.id}`),
			1,
		);
	});
	await t.test("a reader sees the published version, its rhythm and its length", async () => {
		const s = await residency();
		await w.admin.execute(
			sql`UPDATE development_program_version SET published_at='2026-10-10T16:00:00Z' WHERE id=${s.V1.id}`,
		);
		const read = await w.untouched(() => w.program(s.A, s.Program));
		assert.deepEqual(
			[read.kind, read.published!.id, read.published!.number, read.published!.rhythm, read.published!.expectedMonths],
			["residency", s.V1.id, 1, "monthly", 15],
		);
		assert.equal(read.published!.publishedOn, "2026-10-10");
		assert.equal(read.draft, null);
	});
});

test("AC:ADR1-011 an enrollment is made once on its published version, refuses a foreign, removed or already enrolled person, and changes plan only on purpose with its history kept", async (t) => {
	const request = (s: Residency, personId: string, enrollmentId = randomUUID()) => ({
		enrollmentId,
		programId: s.Program,
		personId,
		cohort: "Autumn 2026",
		startedOn: "2026-10-17",
		expectedEndOn: "2028-01-17",
		stageId: s.V1.stages[0]!.id,
		nextMeetingAt: null,
	});
	const enroll = async (s: Residency, input: object) => programWriter.enroll(w.db, await w.authority(s.A), input);
	await t.test("a pipeline person is enrolled once on the published version", async () => {
		const s = await residency();
		const Q = await w.place(s.A, "Casey L.", { responsible: s.seats.A });
		const input = request(s, Q);
		const made = await w.recorded(async () => ok(await enroll(s, input)));
		assert.deepEqual(made.value, { enrollmentId: input.enrollmentId, outcome: "changed" });
		assert.deepEqual(made.added, { audits: ["development.enrolled"], jobs: [], notices: 0, mail: 0 });
		assert.equal(ok(await w.untouched(() => enroll(s, input))).outcome, "noop");
		const e = await w.enrollment(s.A, input.enrollmentId);
		assert.deepEqual(
			[e.person, e.versionNumber, e.cohort, e.status, e.startedOn, e.expectedEndOn],
			[{ personId: Q, name: "Casey L." }, 1, "Autumn 2026", "active", "2026-10-17", "2028-01-17"],
		);
		assert.deepEqual(await w.rows(sql`SELECT id,version_id FROM development_enrollment WHERE person_id=${Q}`), [
			{ id: input.enrollmentId, version_id: s.V1.id },
		]);
	});
	await t.test("a person of another organization is refused", async () => {
		const s = await residency();
		const Q = await w.place(s.foreign, "Casey L.");
		refusedWith(await w.untouched(() => enroll(s, request(s, Q))), "invalid_input", "personId");
	});
	await t.test("a person already active in the program is refused", async () => {
		const s = await residency();
		refusedWith(await w.untouched(() => enroll(s, request(s, s.P))), "already_enrolled");
		assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM development_enrollment WHERE person_id=${s.P}`), 1);
	});
	await t.test("a removal that commits first leaves the waiting enrollment refused", async () => {
		const s = await residency();
		const Q = await w.place(s.A, "Casey L.", { responsible: s.seats.A });
		const expectedRevision = ok(await w.record(s.A, Q)).revision;
		const auth = await w.authority(s.A);
		const [removed, refused] = await raced(w.admin, w.db, sql`SELECT 1 FROM person WHERE id=${Q}::uuid FOR UPDATE`, [
			() => pipelineDataWriter.removePerson(w.db, auth, { personId: Q, expectedRevision }),
			() => programWriter.enroll(w.db, auth, request(s, Q)),
		]);
		assert.equal(removed.status, "ok", JSON.stringify(removed));
		refusedWith(refused, "invalid_input", "personId");
		assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM development_enrollment WHERE person_id=${Q}`), 0);
	});
	await t.test(
		"the director applies a reviewed version; finished work keeps who finished and confirmed it",
		async () => {
			const s = await residency();
			await marked(s);
			ok(
				await w.at("2026-10-16T19:00:00Z", async () =>
					programWriter.confirmMilestone(w.db, await w.authority(s.A), { enrollmentId: s.E, milestoneId: s.M }),
				),
			);
			const before = await completionRow(s);
			assert.deepEqual(before, [
				{
					completed_on: "2026-10-16",
					recorder_id: s.R.id,
					confirmer_id: s.A.id,
					confirmed_at: "2026-10-16T19:00:00Z",
					source: "resident",
				},
			]);
			const fresh = "Write a church planting prospectus";
			const V2 = await publishNext(s.A, s.Program, {
				milestones: [
					{ lineage: milestoneOf(s.V1.milestones, LEAD).lineage, title: LEAD },
					{ lineage: randomUUID(), title: fresh },
				],
			});
			const review = ok(await readVersionReview(w.db, await w.authority(s.A), { enrollmentId: s.E }));
			const apply = async (basis: string) =>
				programWriter.applyVersion(w.db, await w.authority(s.A), {
					enrollmentId: s.E,
					versionId: V2.id,
					stageId: review.stageId,
					basis,
				});
			refusedWith(await w.untouched(() => apply("0".repeat(32))), "stale_review");
			ok(await apply(review.basis));
			const e = await w.enrollment(s.A, s.E);
			assert.equal(e.versionNumber, 2);
			assert.deepEqual(milestoneOf(e.milestones, LEAD).completion, {
				completedOn: "2026-10-16",
				confirmedOn: "2026-10-16",
				recorder: "Casey Lee",
				confirmer: "Alex",
				source: "resident",
			});
			assert.equal(milestoneOf(e.milestones, fresh).completion, null);
			assert.deepEqual(await completionRow(s), before);
		},
	);
	await t.test("a new meeting and cohort keep the pinned plan and the pipeline stage", async () => {
		const s = await residency();
		const before = await w.enrollment(s.A, s.E);
		const stage = await stageOf(s);
		const update = async (expectedRevision: string) =>
			programWriter.updateEnrollment(w.db, await w.authority(s.A), {
				enrollmentId: s.E,
				expectedRevision,
				changes: { cohort: "Autumn 2026", nextMeetingAt: "2026-11-02T10:00:00" },
			});
		ok(await update(before.revision));
		const after = await w.enrollment(s.A, s.E);
		assert.deepEqual([after.cohort, after.versionNumber], ["Autumn 2026", 1]);
		assert.deepEqual(after.nextMeeting, { at: "2026-11-02T10:00:00", timezone: "America/Chicago" });
		assert.deepEqual(
			await w.rows(sql`SELECT version_id,to_char(next_meeting_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
				meeting_timezone FROM development_enrollment WHERE id=${s.E}`),
			[{ version_id: s.V1.id, at: "2026-11-02T16:00:00Z", meeting_timezone: "America/Chicago" }],
		);
		assert.equal(await stageOf(s), stage);
		refusedWith(await w.untouched(() => update(before.revision)), "conflict");
	});
});

test("AC:ADR1-012 a resident's own mark and the director's confirmation are separate facts, an unlinked enrollee is recorded by the director, and feedback reaches only its readers", async (t) => {
	const BODY = "Please explain the passage before discussing application";
	const confirm = async (s: Residency, a: Actor) =>
		programWriter.confirmMilestone(w.db, await w.authority(a), { enrollmentId: s.E, milestoneId: s.M });
	const feedback = async (s: Residency, a: Actor, body = BODY, feedbackId = randomUUID()) =>
		programWriter.addFeedback(w.db, await w.authority(a), { feedbackId, enrollmentId: s.E, milestoneId: s.M, body });
	const NOW = "2026-10-17T16:00:00Z";
	const plants = () => w.count(sql`SELECT count(*)::int AS n FROM plant`);

	await t.test(
		"the resident's mark carries who and when and no confirmation, and moves no pipeline stage",
		async () => {
			const s = await residency();
			const before = await plants();
			assert.deepEqual(ok(await w.at(NOW, () => mark(s, s.R))), { outcome: "changed" });
			assert.deepEqual(await completionRow(s), [
				{
					completed_on: "2026-10-17",
					recorder_id: s.R.id,
					confirmer_id: null,
					confirmed_at: null,
					source: "resident",
				},
			]);
			assert.deepEqual(await eventAt("development.milestone_marked", s.E), [{ actor_id: s.R.id, at: NOW }]);
			assert.deepEqual(milestoneOf((await w.enrollment(s.A, s.E)).milestones, LEAD).completion, {
				completedOn: "2026-10-17",
				confirmedOn: null,
				recorder: "Casey Lee",
				confirmer: null,
				source: "resident",
			});
			assert.equal(await stageOf(s), "Potential leader");
			assert.deepEqual(ok(await w.untouched(() => mark(s, s.R))), { outcome: "noop" });
			assert.equal(await plants(), before);
		},
	);
	await t.test("the director confirms as a separate fact at their own instant", async () => {
		const s = await residency();
		await marked(s);
		assert.deepEqual(ok(await w.at(NOW, () => confirm(s, s.A))), { outcome: "changed" });
		assert.deepEqual(await completionRow(s), [
			{
				completed_on: "2026-10-16",
				recorder_id: s.R.id,
				confirmer_id: s.A.id,
				confirmed_at: NOW,
				source: "resident",
			},
		]);
		assert.deepEqual(await eventAt("development.milestone_marked", s.E), [
			{ actor_id: s.R.id, at: "2026-10-16T18:00:00Z" },
		]);
		assert.deepEqual(await eventAt("development.milestone_confirmed", s.E), [{ actor_id: s.A.id, at: NOW }]);
	});
	await t.test("ordinary staff, even responsible for the person, read no feedback", async () => {
		const s = await residency("member");
		await marked(s);
		ok(await feedback(s, s.D));
		const read = await w.untouched(() => w.enrollment(s.A, s.E));
		assert.equal(milestoneOf(read.milestones, LEAD).feedback, null);
		assert.equal(JSON.stringify(read).includes(BODY), false);
		assert.equal(
			(await w.modelContent(s.A, { "development.readProgram": [{ enrollmentId: s.E }] })).includes(BODY),
			false,
		);
	});
	await t.test("the resident reads their own feedback, its author and its day", async () => {
		const s = await residency();
		await marked(s);
		ok(await w.at("2026-10-16T19:00:00Z", () => feedback(s, s.A)));
		const read = milestoneOf((await linked(s.R)).enrollments[0]!.milestones, LEAD).feedback;
		assert.deepEqual(
			read.map(({ body, writer, writtenOn }) => ({ body, writer, writtenOn })),
			[{ body: BODY, writer: "Alex", writtenOn: "2026-10-16" }],
		);
		assert.deepEqual(
			await w.rows(sql`SELECT writer_id,to_char(written_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
				FROM assignment_feedback WHERE enrollment_id=${s.E}`),
			[{ writer_id: s.A.id, at: "2026-10-16T19:00:00Z" }],
		);
	});
	await t.test(
		"the director's feedback is dated, and its readers are the resident, director and administrators",
		async () => {
			const s = await residency("member");
			await marked(s);
			const body = "Explain the passage before discussing application";
			ok(await w.at(NOW, () => feedback(s, s.D, body)));
			assert.deepEqual(
				await w.rows(sql`SELECT writer_id,body,to_char(written_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
				FROM assignment_feedback WHERE enrollment_id=${s.E}`),
				[{ writer_id: s.D.id, body, at: NOW }],
			);
			const admin = await w.actor(s.O, "admin", { user: { name: "Adrian" } });
			for (const reader of [s.D, s.lead, admin])
				assert.deepEqual(
					milestoneOf((await w.enrollment(reader, s.E)).milestones, LEAD).feedback?.map((f) => f.body),
					[body],
				);
			assert.deepEqual(
				milestoneOf((await linked(s.R)).enrollments[0]!.milestones, LEAD).feedback.map((f) => f.body),
				[body],
			);
			for (const reader of [s.D, s.lead, admin])
				assert.equal(
					(await w.modelContent(reader, { "development.readProgram": [{ enrollmentId: s.E }] })).includes(body),
					false,
					"no model reads it",
				);
		},
	);
	await t.test("another resident cannot mark the milestone", async () => {
		const s = await residency();
		const X = await w.actor(null, "owner", { user: { name: "X" } });
		refusedWith(await w.untouched(() => mark(s, X)));
		const other = await residency();
		refusedWith(await w.untouched(() => mark(s, other.R)));
		assert.deepEqual(await completionRow(s), []);
	});
	const recorded = async (s: Residency, enrollmentId: string, a = s.A) =>
		programWriter.recordMilestone(w.db, await w.authority(a), {
			enrollmentId,
			milestoneId: s.M,
			completedOn: "2026-10-16",
		});
	await t.test("the director records and confirms for an unlinked enrollee once, linking nobody", async () => {
		const s = await residency();
		const Q = await w.place(s.A, "Jordan Rivera", { responsible: s.seats.A });
		const unlinked = await w.enroll(s.A, s.Program, Q);
		const before = await people();
		assert.deepEqual(ok(await w.at(NOW, () => recorded(s, unlinked))), { outcome: "changed" });
		assert.deepEqual(await completionRow({ E: unlinked, M: s.M }), [
			{
				completed_on: "2026-10-16",
				recorder_id: s.A.id,
				confirmer_id: s.A.id,
				confirmed_at: NOW,
				source: "program_leader",
			},
		]);
		assert.deepEqual(await eventAt("development.milestone_recorded", unlinked), [{ actor_id: s.A.id, at: NOW }]);
		assert.deepEqual(ok(await w.untouched(() => recorded(s, unlinked))), { outcome: "noop" });
		assert.equal((await w.enrollment(s.A, unlinked)).person.personId, Q);
		assert.deepEqual(await w.rows(sql`SELECT linked_account_id FROM person WHERE id=${Q}`), [
			{ linked_account_id: null },
		]);
		assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM residency_link WHERE person_id=${Q}`), 0);
		assert.equal(await people(), before);
		refusedWith(await w.untouched(() => recorded(s, unlinked, s.D)));
	});
	await t.test("once the resident is linked the director's recording is refused", async () => {
		const s = await residency();
		refusedWith(await w.untouched(() => recorded(s, s.E)), "linked_resident");
		assert.deepEqual(await completionRow(s), []);
	});
});

test("AC:ADR1-013 My residency shows the resident's program, stage, meeting and milestones, no internal field and no seat, and ends with the link", async (t) => {
	const s = await residency();
	ok(
		await programWriter.updateEnrollment(w.db, await w.authority(s.A), {
			enrollmentId: s.E,
			expectedRevision: (await w.enrollment(s.A, s.E)).revision,
			changes: { nextMeetingAt: "2026-11-02T10:00:00" },
		}),
	);
	await marked(s);
	await t.test("the resident's own view", async () => {
		const view = await w.untouched(() => linked(s.R));
		assert.equal(view.organizationName, "Grace Austin");
		assert.equal(view.timezone, "America/Chicago");
		const [e, ...rest] = view.enrollments;
		assert.deepEqual(rest, []);
		assert.deepEqual(
			[e!.program, e!.stage, e!.cohort],
			[{ name: "Residency", kind: "residency", director: "Alex" }, "Assimilating", "Autumn 2026"],
		);
		assert.deepEqual(e!.nextMeeting, {
			at: "2026-11-02T10:00:00",
			churchAt: "2026-11-02T10:00:00",
			churchTimezone: "America/Chicago",
		});
		assert.deepEqual(
			e!.milestones.map((m) => [m.title, m.completion]),
			[
				[LEAD, { completedOn: "2026-10-16", confirmedOn: null, source: "resident" }],
				[PRESENT, null],
			],
		);
		assert.deepEqual(Object.keys(view).sort(), [
			"enrollments",
			"organizationName",
			"sharing",
			"status",
			"timezone",
			"today",
		]);
		assert.deepEqual(Object.keys(e!).sort(), [
			"cohort",
			"expectedEndOn",
			"id",
			"milestones",
			"nextMeeting",
			"program",
			"readings",
			"stage",
			"startedOn",
		]);
		assert.equal(/Potential leader|potential_leader|responsible|seat/i.test(JSON.stringify(view)), false);
		assert.equal((await w.authority(s.R)).actor.context.kind, "account");
		assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${s.R.id}`), 0);
	});
	await t.test("a link that ended removes it at once", async () => {
		await w.admin.execute(sql`UPDATE residency_link SET ended_at='2026-10-17T15:59:59Z',share_foundations=false,
			share_milestones=false WHERE id=${s.L}`);
		assert.deepEqual(await w.untouched(() => mine(s.R)), { status: "ended" });
		refusedWith(await w.untouched(() => mark(s, s.R)));
	});
});

test("AC:ADR1-014 a director sees only the one resident's shared foundations and milestones, and program reading opens only while its source is published", async (t) => {
	const articles = foundations.articles as { id: string; title: string; slug: string }[];
	assert.equal(articles.length, 6);
	const revisions = new Map<string, string>();
	const revision = async (article: string, tenant: string, title: string, slug: string, body: string) => {
		const id = randomUUID();
		await w.admin.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
			VALUES(${article},'article',${"cases/" + slug},${GLOBAL}) ON CONFLICT DO NOTHING`);
		await w.admin
			.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,
			excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			VALUES(${id},${article},${tenant},${tenant === GLOBAL ? release : null},1,${title},${slug},${title},
			${body},${tenant === GLOBAL ? "safe_mdx" : "safe_nodes"},1,1,
			${randomBytes(32).toString("hex")},'2026-01-01T00:00:00Z',true,1,${section})`);
		return id;
	};
	for (const a of articles) revisions.set(a.id, await revision(a.id, GLOBAL, a.title, a.slug, "Body"));
	await w.admin
		.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,
		reason,expected_prior_number) VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);
	const read = async (a: Actor, list: typeof articles) => {
		for (const x of list)
			await w.admin
				.execute(sql`INSERT INTO reading(account_id,article_id,last_revision_id,observed_fraction,completed_at,
				completed_revision_id,completed_fraction,policy_version,last_read_meaningful_sequence,bookmarked)
				VALUES(${a.id},${x.id},${revisions.get(x.id)},0.9,clock_timestamp(),${revisions.get(x.id)},0.9,'v1',1,false)`);
	};
	const progress = async (s: Residency) => {
		const e = await w.untouched(() => w.enrollment(s.A, s.E));
		return {
			resident: e.person.name,
			sharing: e.resident,
			milestones: e.milestones.filter((m) => m.completion).length,
			text: JSON.stringify(e),
		};
	};
	const BODY = '[{"type":"paragraph","text":"VISION-BODY"}]';
	const shared = (completed: number) => ({
		status: "linked",
		milestones: "shared",
		foundations: { status: "shared", completed, total: 6 },
	});
	await t.test("all six foundations and both milestones count, and no private content comes with them", async () => {
		const s = await residency();
		await read(s.R, articles);
		await marked(s);
		await marked(s, PRESENT, "2026-10-15T18:00:00Z");
		await w.admin.execute(
			sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${randomUUID()},${s.R.id}::uuid,'native','PRIVATE')`,
		);
		const { text, ...seen } = await progress(s);
		assert.deepEqual(seen, { resident: "Casey Lee", sharing: shared(6), milestones: 2 });
		for (const hidden of ["PRIVATE", "0.9", ...articles.flatMap((a) => [a.id, a.title])])
			assert.equal(text.includes(hidden), false, hidden);
	});
	await t.test("withdrawn foundations and milestones are refused to the director", async () => {
		const s = await residency("admin", { shareFoundations: false, shareMilestones: false });
		await read(s.R, articles);
		await marked(s);
		const { text: _text, ...seen } = await progress(s);
		assert.deepEqual(seen, {
			resident: "Casey Lee",
			sharing: { status: "linked", milestones: "not_shared", foundations: { status: "not_shared" } },
			milestones: 0,
		});
		refusedWith(
			await w.untouched(async () =>
				programWriter.confirmMilestone(w.db, await w.authority(s.A), { enrollmentId: s.E, milestoneId: s.M }),
			),
		);
	});
	await t.test("two readers' halves are never pooled", async () => {
		const s = await residency();
		const X = await w.actor(null, "owner", { email: `other-reader-${randomUUID()}@example.test` });
		await read(s.R, articles.slice(0, 3));
		await read(X, articles.slice(3));
		assert.deepEqual((await progress(s)).sharing, shared(3));
	});
	for (const isPublished of [true, false])
		await t.test(isPublished ? "a published source opens" : "an unpublished source returns no bytes", async () => {
			const s = await w.scene();
			const P = await w.place(s.A, "Casey Lee", { responsible: s.seats.A });
			await w.link(s.O, P, s.R);
			const article = randomUUID();
			const pinned = await revision(article, s.O.id, "Clarify the vision", `vision-${article}`, BODY);
			await w.admin
				.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,
				revision) VALUES(${randomUUID()},${s.O.id},${article},'published',${pinned},1)`);
			const programId = randomUUID();
			ok(
				await programWriter.createProgram(w.db, await w.authority(s.A), {
					programId,
					kind: "residency",
					name: "Residency",
					directorSeatId: s.seats.A,
					plan: {
						rhythm: "monthly",
						expectedMonths: 15,
						stages: [{ label: "Assimilating", minMonths: 2, maxMonths: 3 }],
						milestones: [],
						readings: [{ revisionId: pinned }],
					},
				}),
			);
			const { revision: draft } = await w.program(s.A, programId);
			ok(await programWriter.publishVersion(w.db, await w.authority(s.A), { programId, expectedRevision: draft }));
			await w.enroll(s.A, programId, P);
			const [reading] = (await linked(s.R)).enrollments[0]!.readings;
			assert.deepEqual(
				[reading!.title, reading!.source, reading!.available],
				["Clarify the vision", "organization", true],
			);
			assert.deepEqual(
				await w.rows(sql`SELECT article_id,revision_id FROM development_reading WHERE id=${reading!.id}`),
				[{ article_id: article, revision_id: pinned }],
			);
			const open = async (a: Actor) =>
				w.untouched(async () => ok(await readResidentReading(w.db, await w.authority(a), { readingId: reading!.id })));
			if (!isPublished)
				await w.admin.execute(sql`UPDATE article_editor_state SET state='hide' WHERE article_id=${article}`);
			const opened = await open(s.R);
			if (isPublished) {
				assert.ok(opened.status === "available");
				assert.deepEqual([opened.title, opened.organizationName], ["Clarify the vision", "Grace Austin"]);
				assert.ok(opened.body.includes("VISION-BODY"));
				const X = await w.actor(null, "owner", { user: { name: "X" } });
				assert.deepEqual(await open(X), { status: "unavailable" });
				await w.admin.execute(sql`UPDATE residency_link SET ended_at=clock_timestamp(),share_foundations=false,
					share_milestones=false WHERE person_id=${P}`);
			}
			assert.deepEqual(await open(s.R), { status: "unavailable" });
			if (!isPublished) assert.equal((await linked(s.R)).enrollments[0]!.readings[0]!.available, false);
		});
});
