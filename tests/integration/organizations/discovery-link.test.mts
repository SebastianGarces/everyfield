import "../platform/setup.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as S from "./support.mts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import {
	namesFor,
	readDiscoverySharing,
	readSharedFoundations,
} from "../../../packages/domain/src/organizations/index.ts";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };

after(S.teardown);
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const articles = foundations.articles;

type Identity = Awaited<ReturnType<typeof S.identity>>;
const authority = async (who: Identity) => {
	const a = await RequestActor.resolve(S.runtime, who.session);
	assert.ok(a instanceof RequestActor, JSON.stringify(a));
	return a;
};
const viewer = (who: Identity) => ({
	accountId: who.account,
	selected: who.selected,
	access: { session: who.session, owner: who.selected },
});

let release: string;
const revisions = new Map<string, string>();
before(async () => {
	release = randomUUID();
	const section = randomUUID();
	await S.db.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','framework/start',${GLOBAL})`,
	);
	await S.db.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,
		validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,
		expected_passages) VALUES(${release},${"release-" + release},'memory://synthetic',${randomBytes(32).toString("hex")},
		'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${randomBytes(32).toString("hex")},'v','profile',1,
		${GLOBAL},0)`);
	for (const a of articles) {
		const id = randomUUID();
		await S.db.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
			VALUES(${a.id},'article',${"cases/" + a.slug},${GLOBAL}) ON CONFLICT DO NOTHING`);
		await S.db.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,
			excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			VALUES(${id},${a.id},${GLOBAL},${release},1,${a.title},${a.slug},${a.title},'Body','safe_mdx',1,1,
			${randomBytes(32).toString("hex")},'2026-01-01T00:00:00Z',true,1,${section})`);
		revisions.set(a.id, id);
	}
});

async function planter(name: string) {
	const p = await S.identity();
	await S.db.execute(
		sql`UPDATE auth_user SET name=${name} WHERE id=(SELECT auth_user_id FROM account WHERE id=${p.account}::uuid)`,
	);
	await S.db.execute(sql`INSERT INTO discovery(account_id) VALUES(${p.account})`);
	for (const a of articles.slice(0, 2))
		await S.db.execute(sql`INSERT INTO reading(account_id,article_id,last_revision_id,observed_fraction,completed_at,
			completed_revision_id,completed_fraction,policy_version,last_read_meaningful_sequence,bookmarked)
			VALUES(${p.account},${a.id},${revisions.get(a.id)},0.9,clock_timestamp(),${revisions.get(a.id)},0.9,'v1',1,false)`);
	return p;
}
const linkOf = async (p: Identity, org: Awaited<ReturnType<typeof S.tenant>>) => S.affiliation(p.selected, org);
const own = async (p: Identity) => readDiscoverySharing(S.runtime, await authority(p));
const shared = async (d: Identity) => readSharedFoundations(S.runtime, await authority(d));
const setSharing = async (
	p: Identity,
	link: string,
	on: boolean,
	over: { revision?: string; consent?: string } = {},
) => {
	const row = (await own(p))[link];
	return S.call(
		"discovery.setSharing",
		p,
		S.command(
			{
				relationshipId: link,
				expectedConsentRevision: over.consent ?? row?.consentRevision ?? "1",
				shareFoundations: on,
			},
			over.revision ?? row?.revision ?? "1",
		),
	);
};

test("AC:TARGET-IDN-020 INV-privacy: an ordinary link shows the planter's name and shares foundations only while the planter turns it on", async () => {
	const church = await S.tenant("sending_church", "Grace Church");
	const network = await S.tenant("sending_network", "Hill Network");
	const director = await S.identity(church, "owner");
	const networkDirector = await S.identity(network, "owner");
	const other = await S.tenant("sending_church", "Other Church");
	const otherDirector = await S.identity(other, "owner");
	const jo = await planter("Jo Planter");
	const link = await linkOf(jo, church);
	const networkLink = await linkOf(jo, network);

	assert.deepEqual(await namesFor(S.runtime, viewer(director), [jo.account, church.id]), {
		[jo.account]: "Jo Planter",
		[church.id]: "Grace Church",
	});
	assert.deepEqual(await namesFor(S.runtime, viewer(networkDirector), [jo.account]), { [jo.account]: "Jo Planter" });
	assert.deepEqual(await namesFor(S.runtime, viewer(otherDirector), [jo.account]), {});
	assert.deepEqual(await namesFor(S.runtime, viewer(jo), [church.id]), { [church.id]: "Grace Church" });

	const before = await own(jo);
	assert.equal(before[link]?.shareFoundations, false);
	assert.equal(before[networkLink]?.shareFoundations, false);
	assert.deepEqual(await shared(director), {});

	assert.deepEqual(await setSharing(jo, link, true), { status: "committed" });
	assert.deepEqual(await shared(director), {
		[link]: {
			completed: articles
				.slice(0, 2)
				.map((a) => a.id)
				.sort(),
			total: 6,
		},
	});
	assert.deepEqual(await shared(networkDirector), {});
	assert.deepEqual(await shared(otherDirector), {});
	assert.equal(JSON.stringify(await own(otherDirector)), "{}");

	await assert.rejects(setSharing(jo, link, false, { consent: "1" }), /stale_revision/);
	await assert.rejects(setSharing(otherDirector, link, true), /unavailable/);
	const stranger = await planter("Sam Stranger");
	await assert.rejects(setSharing(stranger, link, false), /unavailable/);

	assert.deepEqual(await setSharing(jo, link, false), { status: "committed" });
	assert.deepEqual(await shared(director), {});

	assert.deepEqual(await setSharing(jo, link, true), { status: "committed" });
	const row = (await own(jo))[link];
	assert.ok(row);
	const ended = await S.call(
		"associations.end",
		director,
		S.command(
			{
				relationshipId: link,
				pair: { kind: "discovery", accountId: jo.account, organization: church },
				confirmed: true,
				reason: null,
			},
			row.revision,
		),
	);
	assert.deepEqual(ended, { status: "committed" });
	assert.deepEqual(await shared(director), {});
	assert.deepEqual(await namesFor(S.runtime, viewer(director), [jo.account]), { [jo.account]: "Jo Planter" });

	assert.deepEqual(await setSharing(jo, networkLink, true), { status: "committed" });
	assert.equal(Object.keys(await shared(networkDirector)).length, 1);
	const plant = await S.tenant("plant", "New Hope");
	await S.db.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${jo.account},${plant.id},'owner',clock_timestamp())`,
	);
	assert.deepEqual(await shared(networkDirector), {});
	assert.deepEqual(await own(jo), {});
});

test("AC:TARGET-IDN-020 a residency link keeps its own switches and offers no ordinary one", async () => {
	const church = await S.tenant("sending_church", "Residency Church");
	const director = await S.identity(church, "owner");
	const kay = await planter("Kay Resident");
	const link = await linkOf(kay, church);
	await S.db.execute(sql`UPDATE affiliation SET share_foundations=true WHERE id=${link}::uuid`);
	const person = randomUUID(),
		invitation = randomUUID();
	await S.db
		.execute(sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,linked_account_id,created_at,revision)
		VALUES(${person},${church.id},${church.id},'Kay Resident','other','live',${kay.account},clock_timestamp(),1)`);
	await S.db
		.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,accepted_account_id,resident_person_id)
		VALUES(${invitation},${church.id},'residency_link',${kay.email},${randomUUID()},'accepted',clock_timestamp(),${kay.account},${person})`);
	await S.db
		.execute(sql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,
		accepted_at,consent_revision,revision) VALUES(${randomUUID()},${church.id},${person},${kay.account},${link},${invitation},
		clock_timestamp(),1,1)`);
	assert.deepEqual(await own(kay), {});
	assert.deepEqual(await shared(director), {});
	await assert.rejects(setSharing(kay, link, false), /unavailable/);
});
