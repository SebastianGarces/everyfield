import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as S from "./support.mts";
import * as Q from "../../../packages/contracts/src/organizations/index.ts";
import {
	createOrganizationAdapter,
	pipelineWriter,
	readPipelineBoard,
	readPipelineConsents,
	readSharingDisclosure,
	residencyLinks,
} from "../../../packages/domain/src/organizations/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { ok } from "../../support/fixture.mts";
import { untouched } from "../../support/recorded.mts";
import { authorityOf } from "../people/people-support.mts";
after(S.teardown);
const view = (v: unknown) => Q.sharingResult.parse(v);
test("INV-consent: first approval defaults on while rejoin preserves independent saved choices", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p),
		o = await S.tenant("sending_church"),
		oa = await S.identity(o),
		pair = { kind: "plant", subject: p, organization: o };
	assert.deepEqual(await S.tx((c) => readSharingDisclosure(c, oa.session, o, pair)), { status: "unavailable" });
	const disclosed = await S.tx((c) => readSharingDisclosure(c, pa.session, p, pair));
	assert.ok("kind" in disclosed);
	assert.equal(disclosed.kind, "first_invitation");
	assert.deepEqual(disclosed.choices, {
		people: true,
		meetings: true,
		tasks: true,
		ministry_teams: true,
		wiki: true,
		activity: true,
		shared_findings: true,
	});
	const i = Q.invitationResult.parse(
		await S.call("associations.invite", pa, S.command({ pair, recipientEmail: oa.email })),
	);
	const accepted = Q.acceptedInvitationResult.parse(
		await S.call(
			"associations.acceptInvitation",
			oa,
			S.command({ invitationId: i.invitationId, proof: S.proofs.get(i.invitationId), decision: "accept" }),
		),
	);
	if (accepted.status !== "accepted") throw Error();
	const change = S.command({
		plant: p,
		organization: o,
		relationshipId: accepted.relationship.id,
		category: "wiki",
		enabled: false,
		expectedConsentRevision: "1",
	});
	await S.call("privacy.setSharing", pa, change);
	await S.call("privacy.setSharing", pa, change);
	await assert.rejects(S.call("privacy.setSharing", pa, { ...change, requestKey: randomUUID() }), /stale_revision/);
	await S.call(
		"associations.end",
		pa,
		S.command({ relationshipId: accepted.relationship.id, pair, confirmed: true, reason: null }, "2"),
	);
	const retained = await S.tx((c) => readSharingDisclosure(c, pa.session, p, pair));
	assert.ok("kind" in retained);
	assert.equal(retained.kind, "existing_consent");
	assert.equal(retained.choices.wiki, false);
	const j = Q.invitationResult.parse(
		await S.call("associations.invite", pa, S.command({ pair, recipientEmail: oa.email })),
	);
	await S.call(
		"associations.acceptInvitation",
		oa,
		S.command({ invitationId: j.invitationId, proof: S.proofs.get(j.invitationId), decision: "accept" }),
	);
	const v = view(await S.call("privacy.getSharing", pa, { plant: p, organization: o }));
	if (!("view" in v) || v.view !== "plant_administration") throw Error();
	assert.equal(v.choices.wiki, false);
	assert.equal(v.choices.people, true);
	assert.equal(v.consentRevision, "2");
	const jobs = await S.db.execute(
		sql`SELECT producer_key FROM job WHERE kind='notification' AND tenant_id=${sql.param(p.id)} AND subject_record_id=${sql.param(accepted.relationship.id)} ORDER BY source_revision`,
	);
	assert.deepEqual(
		jobs.rows.map((r) => r.producer_key),
		["affiliation/approved/1", "affiliation/sharing/2", "affiliation/ended/3", "affiliation/approved/4"],
	);
});
test("AC:WP007-API-KNOW-112 turning shared findings off hides the published Launch summary from that organization only", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p),
		member = await S.identity(p, "member"),
		o = await S.tenant("sending_church"),
		oa = await S.identity(o),
		n = await S.tenant("sending_network"),
		na = await S.identity(n),
		rel = await S.affiliation(p, o, true),
		other = await S.affiliation(p, n, true);
	if (p.kind !== "plant") throw Error();
	const reader = createLaunchReader(),
		writer = createLaunchWriter({ notices: async () => undefined }),
		planter = await authorityOf(S.runtime, pa),
		day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
	const save = (input: unknown, expectedRevision = "0") => ({ requestKey: randomUUID(), expectedRevision, input });
	ok(await writer.schedule(S.runtime, planter, save({ date: day(-3), reason: null }, "1")));
	const { plan } = ok(await reader.readPlan(S.runtime, planter));
	ok(
		await writer.recordOutcome(
			S.runtime,
			planter,
			save({ actualDate: day(-2), attendance: 40, decisions: null, note: null }, plan.revision),
		),
	);
	const answers = {
		wentWell: "Private reflection",
		toChange: null,
		operations: null,
		followUpPlan: null,
		supportNeeded: null,
		missingNames: "no",
		missingCount: null,
	};
	ok(await writer.submitDebrief(S.runtime, planter, save({ draftId: null, answers })));
	ok(await writer.publishDebriefSummary(S.runtime, planter, save({ draftId: null, body: "Service held." })));
	const summary = async (who: typeof oa) =>
		(await reader.readPublishedSummary(S.runtime, await authorityOf(S.runtime, who), p.id))?.body ?? "unavailable";
	const sharing = (organization: typeof o) =>
		S.call("privacy.getSharing", pa, { plant: p, organization }).then((read) => {
			const shown = view(read);
			if (!("view" in shown) || shown.view !== "plant_administration") throw Error("not shown");
			return { consentRevision: shown.consentRevision, choices: shown.choices };
		});
	const change = (category: string, enabled: boolean, revision: string) =>
		S.command(
			{ plant: p, organization: o, relationshipId: rel, expectedConsentRevision: revision, category, enabled },
			revision,
		);
	const row = async (id: string) =>
		(await S.db.execute(sql`SELECT to_jsonb(a) AS row FROM affiliation a WHERE id=${sql.param(id)}`)).rows[0];
	const events = async () =>
		(
			await S.db.execute(
				sql`SELECT (SELECT count(*)::int FROM audit_event) AS audits,(SELECT count(*)::int FROM job) AS jobs,(SELECT count(*)::int FROM mail) AS mail`,
			)
		).rows[0];
	await S.call("privacy.setSharing", pa, change("wiki", false, "1"));
	assert.deepEqual([await summary(oa), await summary(na)], ["Service held.", "Service held."]);
	const untouched = await row(other),
		before = await sharing(o),
		saved = await events();
	assert.equal(before.consentRevision, "2");

	const off = change("shared_findings", false, "2");
	await assert.rejects(S.call("privacy.setSharing", pa, { ...off, expectedRevision: "1" }), /stale_revision/);
	await assert.rejects(S.call("privacy.setSharing", pa, change("shared_findings", false, "1")), /stale_revision/);
	for (const who of [member, oa, na])
		await assert.rejects(S.call("privacy.setSharing", who, { ...off, requestKey: randomUUID() }), /unavailable/);
	assert.deepEqual(await sharing(o), before);
	assert.deepEqual(await events(), saved, "a refusal records nothing");
	assert.equal(await summary(oa), "Service held.");

	assert.deepEqual(await S.call("privacy.setSharing", pa, off), { status: "committed" });
	const after = await sharing(o),
		recorded = await events();
	assert.deepEqual(after, { consentRevision: "3", choices: { ...before.choices, shared_findings: false } });
	assert.deepEqual(await S.call("privacy.setSharing", pa, off), { status: "committed" });
	assert.deepEqual([await sharing(o), await events()], [after, recorded], "a retry changes nothing");
	assert.deepEqual([await summary(oa), await summary(na)], ["unavailable", "Service held."]);
	const shown = view(await S.call("privacy.getSharing", oa, { plant: p, organization: o }));
	assert.ok("view" in shown && shown.view === "organization" && shown.availability.shared_findings === false);
	assert.deepEqual(await row(other), untouched);
});
test("AC:ADR1-016 pipeline totals default off, are shared per relationship and need two churches", async (t) => {
	async function scene() {
		const [O, B] = [await S.tenant("sending_church", "Grace Austin"), await S.tenant("sending_church", "Hope Dallas")];
		const [N, other] = [await S.tenant("sending_network"), await S.tenant("sending_network")];
		const A = await S.identity(O, "admin"),
			hope = await S.identity(B, "admin"),
			staff = await S.identity(N, "admin");
		const Rel = await S.affiliation(O, N),
			RelB = await S.affiliation(B, N),
			OtherRel = await S.affiliation(O, other);
		const share = (actor: typeof A, relationshipId: string, sharePipelineTotals: boolean, revision = "1") =>
			S.call("pipelineSharing.setConsent", actor, S.command({ relationshipId, sharePipelineTotals }, revision));
		const consent = async (relationshipId: string) => {
			const read = Q.pipelineConsentResult.parse(await S.call("pipelineSharing.readConsent", A, { relationshipId }));
			assert.ok(read.status === "available");
			return read;
		};
		const check = () => S.call("pipelineSharing.checkAggregateAccess", staff, { network: N });
		return { O, B, N, A, hope, staff, Rel, RelB, OtherRel, share, consent, check };
	}
	const decision = (allowed: boolean) => ({ allowed, minimumContributors: 2 });
	const sharing = ({ relationshipId: _id, revision: _revision, ...shown }: object & Record<string, unknown>) => shown;
	const on = { status: "available", sharePipelineTotals: true, minimumContributors: 2 };
	await t.test(
		"a choice for one network is off until its own church turns it on, whatever another network has",
		async () => {
			const s = await scene();
			await s.share(s.A, s.OtherRel, true);
			assert.deepEqual(sharing(await untouched(S.db, () => s.consent(s.Rel))), { ...on, sharePipelineTotals: false });
			assert.deepEqual(sharing(await s.consent(s.OtherRel)), on);
		},
	);
	await t.test("turning it on saves once for that relationship alone and shares no one person", async () => {
		const s = await scene();
		const command = S.command({ relationshipId: s.Rel, sharePipelineTotals: true });
		const save = () => S.call("pipelineSharing.setConsent", s.A, command);
		const saved = await save();
		assert.deepEqual(await untouched(S.db, save), saved);
		assert.deepEqual(sharing(await s.consent(s.Rel)), on);
		assert.equal((await s.consent(s.OtherRel)).sharePipelineTotals, false);
		await untouched(S.db, () => assert.rejects(s.share(s.A, s.Rel, false), /stale_revision/));
		for (const who of [s.staff, s.hope])
			await untouched(S.db, () => assert.rejects(s.share(who, s.Rel, false, "2"), /unavailable/));
	});
	await t.test(
		"a withdrawal refuses saved and queued totals at once and leaves the other network's choice",
		async () => {
			const s = await scene();
			await s.share(s.A, s.Rel, true);
			await s.share(s.A, s.OtherRel, true);
			await s.share(s.hope, s.RelB, true);
			const savedEligibility = await s.check();
			assert.deepEqual(savedEligibility, decision(true));
			const queued = await S.tx(async (held) => {
				const before = await S.api["pipelineSharing.checkAggregateAccess"](held, s.staff.session, s.N, {
					network: s.N,
				});
				await s.share(s.A, s.Rel, false, "2");
				const after = await S.api["pipelineSharing.checkAggregateAccess"](held, s.staff.session, s.N, { network: s.N });
				return [before, after];
			});
			assert.deepEqual(
				queued,
				[decision(true), decision(false)],
				"a job that checked before the withdrawal is refused",
			);
			assert.deepEqual(await untouched(S.db, s.check), decision(false), "the saved answer is not reused");
			assert.equal((await s.consent(s.Rel)).sharePipelineTotals, false);
			assert.deepEqual(sharing(await s.consent(s.OtherRel)), on);
		},
	);
	await t.test(
		"two churches that share now make totals eligible, with no totals and no people in the answer",
		async () => {
			const s = await scene();
			assert.deepEqual(await untouched(S.db, s.check), decision(false));
			await s.share(s.A, s.Rel, true);
			assert.deepEqual(await untouched(S.db, s.check), decision(false), "one church is not enough");
			await s.share(s.hope, s.RelB, true);
			assert.deepEqual(await untouched(S.db, s.check), decision(true));
			await s.share(s.hope, s.RelB, false, "2");
			assert.deepEqual(await untouched(S.db, s.check), decision(false), "one church withholds");
			await s.share(s.hope, s.RelB, true, "3");
			await S.db.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${sql.param(s.RelB)}`);
			assert.deepEqual(await untouched(S.db, s.check), decision(false), "an ended relationship does not count");
		},
	);
	await t.test("many facts from one church still count as one contributor", async () => {
		const s = await scene();
		const authority = await authorityOf(S.runtime, s.A);
		const board = await readPipelineBoard(S.runtime, authority, {});
		assert.ok(board.status === "ok");
		for (const kind of ["potential_leader", "resident"]) {
			const placed = await pipelineWriter.addPerson(S.runtime, authority, {
				personId: randomUUID(),
				displayName: "Hidden Person",
				email: null,
				responsibleSeatId: null,
				stageId: board.value.stages.find((stage) => stage.kind === kind)!.id,
			});
			assert.equal(placed.status, "ok", JSON.stringify(placed));
		}
		await s.share(s.A, s.Rel, true);
		await s.share(s.A, s.OtherRel, true);
		await s.share(s.hope, s.RelB, true);
		await s.share(s.hope, s.RelB, false, "2");
		assert.deepEqual(await untouched(S.db, s.check), decision(false));
	});
});
test("AC:WP007-API-MUL-016 one contributing church gives its network no totals and no records, whoever asks", async () => {
	const n = await S.tenant("sending_network"),
		owner = await S.identity(n),
		church = await S.tenant("sending_church", "Hidden Church"),
		churchOwner = await S.identity(church),
		link = await S.affiliation(church, n, false),
		stranger = await S.identity(await S.tenant("sending_network"));
	await S.call(
		"pipelineSharing.setConsent",
		churchOwner,
		S.command({ relationshipId: link, sharePipelineTotals: true }),
	);
	const board = async (who: typeof owner) => {
		const read = await readPipelineBoard(S.runtime, await authorityOf(S.runtime, who), {});
		if (read.status !== "ok") throw Error(JSON.stringify(read));
		return read.value;
	};
	const placed = await pipelineWriter.addPerson(S.runtime, await authorityOf(S.runtime, churchOwner), {
		personId: randomUUID(),
		displayName: "Hidden Person",
		email: null,
		responsibleSeatId: null,
		stageId: (await board(churchOwner)).stages[0]!.id,
	});
	assert.equal(placed.status, "ok", JSON.stringify(placed));
	const effects = async () =>
		(
			await S.db.execute(
				sql`SELECT (SELECT count(*)::int FROM audit_event) AS audits,(SELECT count(*)::int FROM job) AS jobs,(SELECT count(*)::int FROM mail) AS mail`,
			)
		).rows[0];
	const before = await effects();
	for (const who of [owner, await S.identity(n, "member"), stranger, churchOwner]) {
		const result = (await S.call("pipelineSharing.checkAggregateAccess", who, { network: n })) as Record<
			string,
			unknown
		>;
		assert.deepEqual(
			{ ...result, totals: result.totals ?? null, individual_records: result.individualRecords ?? null },
			{ allowed: false, minimumContributors: 2, totals: null, individual_records: null },
		);
		assert.deepEqual(Object.keys(result).sort(), ["allowed", "minimumContributors"]);
		assert.equal(/Hidden (Church|Person)/.test(JSON.stringify(result)), false);
	}
	assert.ok(JSON.stringify(await board(churchOwner)).includes("Hidden Person"));
	const networkBoard = await board(owner);
	assert.equal(JSON.stringify(networkBoard).includes("Hidden"), false);
	assert.deepEqual(
		networkBoard.stages.map((stage) => stage.count),
		networkBoard.stages.map(() => 0),
	);
	assert.deepEqual(await effects(), before);
});
async function resident() {
	const o = await S.tenant("sending_church"),
		staff = await S.identity(o),
		r = await S.identity(),
		a = await S.affiliation(r.selected, o, false),
		person = randomUUID(),
		invitation = randomUUID(),
		link = randomUUID();
	await S.db.execute(
		sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,linked_account_id,created_at,revision) VALUES(${sql.param(person)},${sql.param(o.id)},${sql.param(o.id)},'Resident','other','live',${sql.param(r.account)},clock_timestamp(),1)`,
	);
	await S.db.execute(
		sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,accepted_account_id,resident_person_id) VALUES(${sql.param(invitation)},${sql.param(o.id)},'residency_link',${sql.param(r.email)},${sql.param(randomUUID())},'accepted',clock_timestamp(),${sql.param(r.account)},${sql.param(person)})`,
	);
	await S.db.execute(
		sql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,accepted_at,consent_revision,revision,share_foundations,share_milestones) VALUES(${sql.param(link)},${sql.param(o.id)},${sql.param(person)},${sql.param(r.account)},${sql.param(a)},${sql.param(invitation)},clock_timestamp(),1,1,true,true)`,
	);
	return { o, staff, r, link, person };
}
test("AC:ADR1-003 resident category withdrawal and leave preserve the current saved choices", async () => {
	const { r, link } = await resident();
	const read = () => S.call("residency.readSharing", r, { linkId: link });
	const initial = Q.residencySharingResult.parse(await read());
	assert.equal(initial.status, "active");
	const command = S.command({
		linkId: link,
		expectedConsentRevision: "1",
		choices: { shareFoundations: false, shareMilestones: true },
	});
	const saved = await S.call("residency.setSharing", r, command);
	assert.deepEqual(saved, { status: "committed" });
	assert.deepEqual(await S.call("residency.setSharing", r, command), saved);
	const current = Q.residencySharingResult.parse(await read());
	assert.equal(current.status, "active");
	if (current.status !== "active") throw Error("missing_residency");
	assert.deepEqual(current.choices, { shareFoundations: false, shareMilestones: true });
	assert.equal(current.consentRevision, "2");
	await assert.rejects(
		S.call("residency.setSharing", r, S.command({ ...command.input, expectedConsentRevision: "1" }, "2")),
		/stale_revision/,
	);
	const leave = S.command({ linkId: link, expectedConsentRevision: "2" }, "2"),
		left = await S.call("residency.leave", r, leave);
	assert.deepEqual(left, { status: "committed" });
	assert.deepEqual(await S.call("residency.leave", r, leave), left);
	assert.deepEqual(await read(), { status: "ended", linkId: link });
	await assert.rejects(
		S.call(
			"residency.setSharing",
			r,
			S.command(
				{ linkId: link, expectedConsentRevision: "3", choices: { shareFoundations: true, shareMilestones: true } },
				"3",
			),
		),
		/unavailable/,
	);
});
test("INV-residency: a resident cannot change sharing or leave once the residency is no longer live", async () => {
	const { r, link, person } = await resident();
	await S.db.execute(sql`UPDATE person SET state='retired' WHERE id=${sql.param(person)}`);
	await assert.rejects(
		S.call(
			"residency.setSharing",
			r,
			S.command({
				linkId: link,
				expectedConsentRevision: "1",
				choices: { shareFoundations: false, shareMilestones: false },
			}),
		),
		/unavailable/,
	);
	await assert.rejects(
		S.call("residency.leave", r, S.command({ linkId: link, expectedConsentRevision: "1" })),
		/unavailable/,
	);
	const [stored] = (
		await S.db.execute(
			sql`SELECT ended_at IS NULL AS open, revision::text AS revision, share_foundations FROM residency_link WHERE id=${sql.param(link)}`,
		)
	).rows;
	assert.deepEqual(stored, { open: true, revision: "1", share_foundations: true });
});
test("INV-atomicity: required outbox failure rolls back sharing, revision, audit, receipt and invalidation", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p),
		o = await S.tenant("sending_church"),
		id = await S.affiliation(p, o, true),
		key = randomUUID();
	const bad = createOrganizationAdapter(
		{
			...S.effects,
			invalidate: () => {
				throw Error("synthetic_outbox_failure");
			},
		},
		{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
	);
	await assert.rejects(
		S.write(pa, (c) =>
			bad["privacy.setSharing"](
				c,
				pa.session,
				p,
				Q.setSharingRequest.parse(
					S.command(
						{
							plant: p,
							organization: o,
							relationshipId: id,
							expectedConsentRevision: "1",
							category: "people",
							enabled: false,
						},
						"1",
						key,
					),
				),
			),
		),
		/synthetic_outbox_failure/,
	);
	const v = view(await S.call("privacy.getSharing", pa, { plant: p, organization: o }));
	if (!("view" in v) || v.view !== "plant_administration") throw Error();
	assert.equal(v.choices.people, true);
	assert.equal(v.consentRevision, "1");
	assert.equal(
		(await S.db.execute(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${sql.param(key)}`)).rows[0]!
			.n,
		0,
	);
	assert.equal(
		(await S.db.execute(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${sql.param(id)}`)).rows[0]!.n,
		0,
	);
	assert.equal(
		(await S.db.execute(sql`SELECT material_revision FROM organization WHERE id=${sql.param(o.id)}`)).rows[0]!
			.material_revision,
		"1",
	);
	assert.equal(
		(await S.db.execute(sql`SELECT count(*)::int AS n FROM job WHERE subject_record_id=${sql.param(id)}`)).rows[0]!.n,
		0,
		"a rolled-back change queues no milestone job",
	);
});
test("AC:ADR1-016 a sending church's page read gives each live network connection's pipeline choice, as readConsent does", async () => {
	const church = await S.tenant("sending_church"),
		admin = await S.identity(church),
		member = await S.identity(church, "member"),
		beta = await S.tenant("sending_network", "Beta Network"),
		alpha = await S.tenant("sending_network", "Alpha Network"),
		ended = await S.tenant("sending_network", "Ended Network"),
		toBeta = await S.affiliation(church, beta),
		toAlpha = await S.affiliation(church, alpha),
		toEnded = await S.affiliation(church, ended);
	await S.db.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${sql.param(toEnded)}`);
	await S.call("pipelineSharing.setConsent", admin, S.command({ relationshipId: toBeta, sharePipelineTotals: true }));
	const consent = async (relationshipId: string) => S.call("pipelineSharing.readConsent", admin, { relationshipId });
	const authority = await authorityOf(S.runtime, admin);
	assert.deepEqual(await readPipelineConsents(S.runtime, authority), [
		{ networkName: "Alpha Network", consent: await consent(toAlpha) },
		{ networkName: "Beta Network", consent: await consent(toBeta) },
	]);
	const [saved] = await readPipelineConsents(S.runtime, authority, toBeta);
	assert.ok(saved?.consent.status === "available");
	assert.equal(saved.consent.sharePipelineTotals, true);
	assert.equal(saved.consent.revision, "2");
	assert.deepEqual(await readPipelineConsents(S.runtime, authority, toEnded), []);
	assert.deepEqual(await readPipelineConsents(S.runtime, authority, "not-a-uuid"), []);
	assert.deepEqual(await readPipelineConsents(S.runtime, await authorityOf(S.runtime, member)), []);
	await S.db.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(admin.account)}`);
	assert.deepEqual(await readPipelineConsents(S.runtime, authority), []);
});
test("AC:ADR1-003 a resident's page read gives each own residency link's consent and revision, as readSharing does", async () => {
	const { r, link } = await resident(),
		other = await resident();
	const viewer = {
		kind: "account" as const,
		session: r.session,
		accountId: r.account,
		selected: r.selected,
		canManage: false,
		access: { session: r.session, owner: r.selected },
	};
	const read = () => S.call("residency.readSharing", r, { linkId: link });
	const expected = async (linkRevision: string) => [
		{ linkId: link, organizationName: "Synthetic", linkRevision, sharing: await read() },
	];
	assert.equal(Q.residencySharingResult.parse(await read()).status, "active");
	assert.deepEqual(await residencyLinks(S.runtime, viewer), await expected("1"));
	await S.call(
		"residency.setSharing",
		r,
		S.command({
			linkId: link,
			expectedConsentRevision: "1",
			choices: { shareFoundations: false, shareMilestones: true },
		}),
	);
	assert.deepEqual(await residencyLinks(S.runtime, viewer, link), await expected("2"));
	assert.deepEqual(await residencyLinks(S.runtime, viewer, other.link), []);
	assert.deepEqual(await residencyLinks(S.runtime, viewer, "not-a-uuid"), []);
	await S.call("residency.leave", r, S.command({ linkId: link, expectedConsentRevision: "2" }, "2"));
	assert.deepEqual(await residencyLinks(S.runtime, viewer), await expected("3"));
	assert.deepEqual((await residencyLinks(S.runtime, viewer))[0]!.sharing, { status: "ended", linkId: link });
	const { r: removed, link: removedLink, person } = await resident();
	await S.db.execute(sql`UPDATE person SET state='retired' WHERE id=${sql.param(person)}`);
	const removedViewer = {
		...viewer,
		session: removed.session,
		accountId: removed.account,
		selected: removed.selected,
		access: { session: removed.session, owner: removed.selected },
	};
	assert.deepEqual(await S.call("residency.readSharing", removed, { linkId: removedLink }), { status: "unavailable" });
	assert.deepEqual((await residencyLinks(S.runtime, removedViewer))[0]!.sharing, { status: "unavailable" });
});
test("INV-consent: only a plant pair has a disclosure", async () => {
	const church = await S.tenant("sending_church"),
		ca = await S.identity(church),
		network = await S.tenant("sending_network");
	const pair = { kind: "sending_church", subject: church, organization: network };
	assert.deepEqual(await S.tx((c) => readSharingDisclosure(c, ca.session, church, pair)), { status: "unavailable" });
});
