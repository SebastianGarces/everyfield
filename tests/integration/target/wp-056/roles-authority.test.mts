import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Q from "../../../../packages/contracts/src/organizations/index.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/index.ts";
import { authorizeTriage } from "../../../../packages/domain/src/feedback/index.ts";
import { createWikiProducer } from "../../../../packages/domain/src/wiki/index.ts";
import * as S from "../../organizations/support.mts";

after(S.teardown);
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const rows = async (q: SQL) => (await S.db.execute(q as never)).rows;
type Who = Awaited<ReturnType<typeof S.identity>>;
const actorOf = async (who: Who) => {
	const found = await RequestActor.resolve(S.runtime, who.session);
	assert.ok(found instanceof RequestActor);
	return found;
};

test("AC:ROLE43-016 an organization's own Admin approves its relationship while a plant Admin or lead holds no organization, library-wide or platform authority", async () => {
	const plant = await S.tenant("plant"),
		org = await S.tenant("sending_church"),
		other = await S.tenant("sending_network");
	const owner = await S.identity(plant),
		admin = await S.identity(plant, "admin"),
		lead = await S.identity(plant, "member"),
		orgAdmin = await S.identity(org, "admin"),
		orgMember = await S.identity(org, "member"),
		otherAdmin = await S.identity(other, "admin");
	for (const [who, name] of [
		[admin, "Adam Admin"],
		[lead, "Lena Lead"],
	] as const) {
		const [person, team] = [randomUUID(), randomUUID()];
		await S.db.execute(
			sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${person},${plant.id},${plant.id},${name},'other',
			'leader','adult','unknown',1,'live',clock_timestamp(),${who.account})` as never,
		);
		await S.db.execute(
			sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
			VALUES(${team},${plant.id},${name + " team"},'active',1,${person},'explicit')` as never,
		);
	}
	const invitation = Q.invitationResult.parse(
		await S.call(
			"associations.invite",
			owner,
			S.command({ pair: { kind: "plant", subject: plant, organization: org }, recipientEmail: orgAdmin.email }),
		),
	);
	const accept = S.command({
		invitationId: invitation.invitationId,
		proof: S.proofs.get(invitation.invitationId),
		decision: "accept",
	});
	const state = async () => ({
		affiliations: await rows(sql`SELECT to_jsonb(a) AS row FROM affiliation a ORDER BY id`),
		invitations: await rows(sql`SELECT to_jsonb(i) AS row FROM invitation i ORDER BY id`),
		organizations: await rows(sql`SELECT to_jsonb(o) AS row FROM organization o ORDER BY id`),
		articles: await rows(sql`SELECT id FROM article_revision ORDER BY id`),
		grants: await rows(sql`SELECT * FROM platform_grant`),
		seats: await rows(sql`SELECT account_id,role,plant_id,organization_id FROM seat ORDER BY id`),
		audits: await rows(sql`SELECT count(*)::int AS n FROM audit_event`),
	});
	const start = await state();
	const wiki = createWikiProducer();
	for (const who of [admin, lead]) {
		await assert.rejects(S.call("associations.acceptInvitation", who, accept), /unavailable/);
		for (const claimed of [org, other]) {
			await assert.rejects(
				S.call("associations.acceptInvitation", { ...who, selected: claimed }, accept),
				/unavailable/,
			);
			await assert.rejects(
				S.call(
					"organizations.updateProfile",
					{ ...who, selected: claimed },
					S.command({ organization: claimed, patch: { name: "Mine" } }),
				),
				/unavailable/,
			);
			await assert.rejects(
				S.call("organizations.updateProfile", who, S.command({ organization: claimed, patch: { name: "Mine" } })),
				/unavailable/,
			);
		}
		assert.deepEqual(await S.call("organizations.getProfile", who, { organization: org }), { status: "unavailable" });
		const actor = await actorOf(who);
		for (const organizationId of [org.id, GLOBAL])
			for (const write of [
				wiki.addOrganizationArticle,
				wiki.editOrganizationArticle,
				wiki.publishOrganizationArticle,
			]) {
				const reply = await write(S.runtime, actor, {
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: { articleId: randomUUID(), organizationId, body: "Mine" },
				});
				assert.match(JSON.stringify(reply), /editorial_access_denied/);
			}
		assert.equal(await authorizeTriage(S.runtime, actor), false);
	}
	for (const who of [orgMember, otherAdmin])
		await assert.rejects(S.call("associations.acceptInvitation", who, accept), /unavailable/);
	assert.deepEqual(await state(), start, "no refused attempt leaves a trace");

	const approved = Q.acceptedInvitationResult.parse(await S.call("associations.acceptInvitation", orgAdmin, accept));
	assert.ok(approved.status === "accepted");
	assert.deepEqual(
		Q.acceptedInvitationResult.parse(await S.call("associations.acceptInvitation", orgAdmin, accept)),
		approved,
	);
	const links = await rows(sql`SELECT plant_id,organization_id,ended_at FROM affiliation WHERE plant_id=${plant.id}`);
	assert.deepEqual(links, [{ plant_id: plant.id, organization_id: org.id, ended_at: null }]);
	const [link] = await rows(
		sql`SELECT id,revision::text AS r,consent_revision::text AS c,share_people FROM affiliation WHERE plant_id=${plant.id}`,
	);
	const sharing = () =>
		S.command(
			{
				plant,
				organization: org,
				relationshipId: link!.id,
				expectedConsentRevision: link!.c,
				category: "people",
				enabled: !link!.share_people,
			},
			String(link!.r),
		);
	for (const who of [orgAdmin, lead, otherAdmin])
		await assert.rejects(S.call("privacy.setSharing", who, sharing()), /unavailable/);
	await S.call("privacy.setSharing", admin, sharing());
	const [granted] = await rows(sql`SELECT share_people,share_meetings FROM affiliation WHERE plant_id=${plant.id}`);
	assert.equal(granted!.share_people, !link!.share_people, "the plant's Admin grants its own category");
	await assert.rejects(
		S.call("organizations.updateProfile", admin, S.command({ organization: org, patch: { name: "Mine" } })),
		/unavailable/,
	);
	assert.deepEqual((await state()).seats, start.seats, "an approval adds no seat on either side");
	assert.deepEqual((await state()).grants, []);
});
