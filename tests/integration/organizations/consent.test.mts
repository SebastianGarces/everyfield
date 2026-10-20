import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as S from "./support.mts";
import * as Q from "../../../packages/contracts/src/organizations/index.ts";
import { readSharingDisclosure, createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
before(S.setup);
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
	await S.call(
		"privacy.setSharing",
		pa,
		S.command({
			plant: p,
			organization: o,
			relationshipId: accepted.relationship.id,
			category: "wiki",
			enabled: false,
			expectedConsentRevision: "1",
		}),
	);
	await S.call(
		"associations.end",
		pa,
		S.command({ relationshipId: accepted.relationship.id, pair, confirmed: true, reason: null }, "2"),
	);
	const retained = await S.tx((c) => readSharingDisclosure(c, pa.session, p, pair));
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
	if (v.view !== "plant_administration") throw Error();
	assert.equal(v.choices.wiki, false);
	assert.equal(v.choices.people, true);
	assert.equal(v.consentRevision, "2");
});
test("AC:WP007-MUL-016 AC:ADR1-016 AC:WP007-API-MUL-016 pipeline consent defaults off and requires two distinct currently eligible churches", async () => {
	const n = await S.tenant("sending_network"),
		na = await S.identity(n),
		churches = [await S.tenant("sending_church"), await S.tenant("sending_church")],
		actors = await Promise.all(churches.map((c) => S.identity(c))),
		ids = [];
	for (const c of churches) ids.push(await S.affiliation(c, n, false));
	const initial = Q.pipelineConsentResult.parse(
		await S.call("pipelineSharing.readConsent", actors[0], { relationshipId: ids[0] }),
	);
	assert.equal(initial.status, "available");
	if (initial.status === "available") assert.equal(initial.sharePipelineTotals, false);
	const check = () => S.call("pipelineSharing.checkAggregateAccess", na, { network: n });
	assert.deepEqual(await check(), { allowed: false, minimumContributors: 2 });
	await S.call(
		"pipelineSharing.setConsent",
		actors[0],
		S.command({ relationshipId: ids[0], sharePipelineTotals: true }),
	);
	assert.deepEqual(await check(), { allowed: false, minimumContributors: 2 });
	await S.call(
		"pipelineSharing.setConsent",
		actors[1],
		S.command({ relationshipId: ids[1], sharePipelineTotals: true }),
	);
	assert.deepEqual(await check(), { allowed: true, minimumContributors: 2 });
	const other = await S.tenant("sending_network"),
		otherLink = await S.affiliation(churches[0], other, false);
	await S.call(
		"pipelineSharing.setConsent",
		actors[0],
		S.command({ relationshipId: otherLink, sharePipelineTotals: true }),
	);
	await S.call(
		"pipelineSharing.setConsent",
		actors[0],
		S.command({ relationshipId: ids[0], sharePipelineTotals: false }, "2"),
	);
	assert.deepEqual(await check(), { allowed: false, minimumContributors: 2 });
	const retained = Q.pipelineConsentResult.parse(
		await S.call("pipelineSharing.readConsent", actors[0], { relationshipId: otherLink }),
	);
	if (retained.status !== "available") throw Error();
	assert.equal(retained.sharePipelineTotals, true);
	await assert.rejects(
		S.call("pipelineSharing.setConsent", na, S.command({ relationshipId: ids[0], sharePipelineTotals: true }, "3")),
		/unavailable/,
	);
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
test("AC:WP007-MUL-003 AC:ADR1-003 AC:WP007-API-MUL-003 resident category withdrawal and leave preserve the current saved choices", async () => {
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
	assert.equal(saved.status, "committed");
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
	assert.equal(left.status, "committed");
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
test("INV-atomicity: required outbox failure rolls back sharing, revision, audit, receipt and invalidation", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p),
		o = await S.tenant("sending_church"),
		id = await S.affiliation(p, o, true),
		key = randomUUID();
	const bad = createOrganizationAdapter(
		{
			...S.effects,
			notice: async () => {
				throw Error("synthetic_outbox_failure");
			},
		},
		{ candidates: async () => [] },
	);
	await assert.rejects(
		S.tx((c) =>
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
	if (v.view !== "plant_administration") throw Error();
	assert.equal(v.choices.people, true);
	assert.equal(v.consentRevision, "1");
	assert.equal(
		(await S.db.execute(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${sql.param(key)}`)).rows[0].n,
		0,
	);
	assert.equal(
		(await S.db.execute(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${sql.param(id)}`)).rows[0].n,
		0,
	);
	assert.equal(
		(await S.db.execute(sql`SELECT material_revision FROM organization WHERE id=${sql.param(o.id)}`)).rows[0]
			.material_revision,
		"1",
	);
});
