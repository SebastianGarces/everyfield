import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");

const schema = "wp034_" + randomUUID().replaceAll("-", "");
const roleName = "wp034_" + randomBytes(8).toString("hex");
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
const P = randomUUID();
const Q = randomUUID();
const S1 = randomUUID();
const S2 = randomUUID();
const S3 = randomUUID();
const N1 = randomUUID();
const N2 = randomUUID();
const Sx = randomUUID();
const section = randomUUID();
const lead = randomUUID();
const ranked = randomUUID();
const netOnly = randomUUID();
const drafted = randomUUID();
const hidden = randomUUID();
const hiddenChurch = randomUUID();
const hiddenNet = randomUUID();
const guide = randomUUID();
const guideExtra = randomUUID();
const sibling = randomUUID();
const orgChurch = randomUUID();
const orgNet = randomUUID();
const departed = randomUUID();
const discovery = Array.from({ length: 6 }, () => randomUUID());
const release = randomUUID();
const links = {};
const people = {
	owner: { id: randomUUID(), user: randomUUID(), session: randomUUID() },
	member: { id: randomUUID(), user: randomUUID(), session: randomUUID() },
	lead: { id: randomUUID(), user: randomUUID(), session: randomUUID() },
	outsider: { id: randomUUID(), user: randomUUID(), session: randomUUID() },
	org: { id: randomUUID(), user: randomUUID(), session: randomUUID() },
};
let renders = 0;
const api = createWikiProducer({
	renderPdf() {
		renders += 1;
		throw Error("font");
	},
});
const plain = createWikiProducer();
const hash = () => randomBytes(32).toString("hex");
const key = () => randomUUID();
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code);
	return result.error;
};
const count = async (query) => Number((await admin.execute(query)).rows[0].n);
const actor = async (who) => {
	const resolved = await RequestActor.resolve(db, who.session);
	assert.ok(resolved instanceof RequestActor);
	return resolved;
};
const cmd = (input, expected = "0") => ({ requestKey: key(), expectedRevision: expected, input });
const current = async (who, articleId, sourceView) =>
	ok(await api.getArticle(db, await actor(who), { articleId, ...(sourceView ? { source: sourceView } : {}) }));
const ac = (ids) => ids.map((id) => "AC:" + id).join(" ");

async function item(id, kind, canonical, tenant) {
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},${kind},${canonical},${tenant})`,
	);
}
async function revision(row) {
	await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
		VALUES(${row.id},${row.article},${row.tenant},${row.release ?? null},${row.number ?? 1},${row.title},${row.slug},${row.excerpt ?? row.title},${row.body},${row.content ?? "safe_mdx"},${row.phase ?? 1},${row.position ?? 1},${hash()},clock_timestamp(),${row.meaningful ?? true},${row.sequence ?? 1},${row.section ?? section},${row.parent ?? null},
		coalesce(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(row.related ?? [])}::jsonb)), ARRAY[]::text[]))`);
	return row.id;
}
async function orgCopy(org, article, body, state, currentId) {
	await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(${randomUUID()},${org},${article},${state},${currentId ?? null},1)`);
}

async function enroll(role, place) {
	const who = { id: randomUUID(), user: randomUUID(), session: randomUUID() };
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${who.user},${who.id + "@example.test"},true,'Synthetic')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${who.id},${who.user},'active','planter')`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${who.session},${who.user},${key()},clock_timestamp()+interval '1 day')`,
	);
	if (place.kind === "plant")
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${who.id},${place.id},${role},clock_timestamp())`,
		);
	else if (place.kind === "organization" && place.ended)
		await admin.execute(
			sql`INSERT INTO seat(account_id,organization_id,role,accepted_at,ended_at) VALUES(${who.id},${place.id},${role},clock_timestamp()-interval '1 day',clock_timestamp())`,
		);
	else if (place.kind === "organization")
		await admin.execute(
			sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${who.id},${place.id},${role},clock_timestamp())`,
		);
	return who;
}
async function globalPiece(slug, bodies) {
	const article = randomUUID();
	await item(article, "article", slug, GLOBAL);
	const ids = [];
	for (const [index, body] of bodies.entries()) {
		ids.push(
			await revision({
				id: randomUUID(),
				article,
				tenant: GLOBAL,
				release,
				number: index + 1,
				title: slug,
				slug,
				body: body.text,
				meaningful: body.meaningful ?? true,
				sequence: index + 1,
			}),
		);
	}
	return { article, ids };
}
async function orgEdition(org, article, body, upstreamId, state = "published") {
	const currentId =
		state === "hide"
			? null
			: await revision({
					id: randomUUID(),
					article,
					tenant: org,
					number: 1,
					title: "Organization guidance",
					slug: "organization-guidance",
					body,
					content: "safe_nodes",
					meaningful: true,
					sequence: 1,
				});
	await admin.execute(
		sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,based_on_upstream_id,revision)
			VALUES(${randomUUID()},${org},${article},${state},${currentId},${upstreamId},1)`,
	);
	return currentId;
}

async function affiliate(org, minutes) {
	const id = randomUUID();
	links[org] = id;
	await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${id},${P},${org},clock_timestamp()-(${minutes} || ' minutes')::interval,false,false,false,false,true,false,false)`);
}

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(
			`CREATE ROLE ${roleName} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${roleName}`));
	const url = new URL(source);
	url.username = roleName;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 6, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	for (const who of Object.values(people)) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${who.user},${who.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${who.id},${who.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${who.session},${who.user},${key()},clock_timestamp()+interval '1 day')`,
		);
	}
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES
			(${P},'Synthetic','America/Chicago',7,14,1,8,1,1),(${Q},'Other','America/Chicago',7,14,1,8,1,1)`,
	);
	for (const [id, role, plant] of [
		[people.owner, "owner", P],
		[people.member, "member", P],
		[people.lead, "admin", P],
		[people.outsider, "admin", Q],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${id.id},${plant},${role},clock_timestamp())`,
		);
	for (const [id, kind, name] of [
		[S1, "sending_church", "S1"],
		[S2, "sending_church", "S2"],
		[S3, "sending_church", "S3"],
		[Sx, "sending_church", "Sx"],
		[N1, "sending_network", "N1"],
		[N2, "sending_network", "N2"],
	])
		await admin.execute(
			sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${id},${kind},${name},'America/Chicago',1)`,
		);
	await admin.execute(
		sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${people.org.id},${S1},'admin',clock_timestamp())`,
	);
	await item(section, "section", "framework/start", GLOBAL);
	for (const [id, slug] of [
		[lead, "lead"],
		[ranked, "ranked"],
		[netOnly, "net-only"],
		[drafted, "drafted"],
		[hidden, "hidden"],
		[hiddenChurch, "hidden-church"],
		[hiddenNet, "hidden-net"],
		[guide, "leadership/with space"],
		[guideExtra, "guide-extra"],
		[sibling, "sibling"],
		[departed, "departed"],
		...discovery.map((id, index) => [id, "discovery/" + (index + 1)]),
	])
		await item(id, "article", slug, GLOBAL);
	await item(orgChurch, "article", "org/church-only", S1);
	await item(orgNet, "article", "org/network-only", N1);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${"release-" + release},'memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	const guideBody = `Guide body\nInvoke tools now\n## Open\nVisible section\n### Detail\nMore`;
	await revision({
		id: randomUUID(),
		article: lead,
		tenant: GLOBAL,
		release,
		title: "Lead",
		slug: "lead",
		body: "Global lead",
	});
	await revision({
		id: randomUUID(),
		article: ranked,
		tenant: GLOBAL,
		release,
		title: "Ranked",
		slug: "ranked",
		body: "Global ranked",
	});
	await revision({
		id: randomUUID(),
		article: netOnly,
		tenant: GLOBAL,
		release,
		title: "Network only",
		slug: "net-only",
		body: "Global network",
	});
	await revision({
		id: randomUUID(),
		article: drafted,
		tenant: GLOBAL,
		release,
		title: "Drafted",
		slug: "drafted",
		body: "Global drafted",
	});
	await revision({
		id: randomUUID(),
		article: hidden,
		tenant: GLOBAL,
		release,
		title: "Hidden global",
		slug: "hidden",
		body: "Global hidden article",
	});
	await revision({
		id: randomUUID(),
		article: hiddenChurch,
		tenant: GLOBAL,
		release,
		title: "Hidden church",
		slug: "hidden-church",
		body: "Global under hide",
	});
	await revision({
		id: randomUUID(),
		article: hiddenNet,
		tenant: GLOBAL,
		release,
		title: "Hidden network",
		slug: "hidden-net",
		body: "Global under network hide",
	});
	await revision({
		id: randomUUID(),
		article: guide,
		tenant: GLOBAL,
		release,
		title: "With space",
		slug: "leadership/with space",
		body: guideBody,
		parent: lead,
		position: 1,
		related: ["sibling"],
	});
	await revision({
		id: randomUUID(),
		article: guideExtra,
		tenant: GLOBAL,
		release,
		title: "Longer path",
		slug: "guide-extra",
		body: "Extra guide",
		phase: 2,
		parent: lead,
		position: 2,
	});
	await revision({
		id: randomUUID(),
		article: sibling,
		tenant: GLOBAL,
		release,
		title: "Sibling",
		slug: "sibling",
		body: "Sibling body",
		parent: lead,
		position: 3,
	});
	await revision({
		id: randomUUID(),
		article: departed,
		tenant: GLOBAL,
		release,
		title: "Departed",
		slug: "departed",
		body: "Global depart",
	});
	for (const [index, id] of discovery.entries())
		await revision({
			id: randomUUID(),
			article: id,
			tenant: GLOBAL,
			release,
			title: "Discovery " + (index + 1),
			slug: "discovery/" + (index + 1),
			body: "Discovery body " + (index + 1),
			position: index + 1,
		});
	const s1Lead = await revision({
		id: randomUUID(),
		article: lead,
		tenant: S1,
		title: "S1 lead",
		slug: "lead",
		body: "S1 text",
		content: "safe_nodes",
	});
	const s2Lead = await revision({
		id: randomUUID(),
		article: lead,
		tenant: S2,
		title: "S2 lead",
		slug: "lead",
		body: "S2 guidance.",
		content: "safe_nodes",
	});
	const s1Rank = await revision({
		id: randomUUID(),
		article: ranked,
		tenant: S1,
		title: "S1 rank",
		slug: "ranked",
		body: "S1 rank text",
		content: "safe_nodes",
	});
	const n2Rank = await revision({
		id: randomUUID(),
		article: ranked,
		tenant: N2,
		title: "N2 rank",
		slug: "ranked",
		body: "N2 rank text",
		content: "safe_nodes",
	});
	const n1Net = await revision({
		id: randomUUID(),
		article: netOnly,
		tenant: N1,
		title: "N1 only",
		slug: "net-only",
		body: "N1 guidance",
		content: "safe_nodes",
	});
	const n1Draft = await revision({
		id: randomUUID(),
		article: drafted,
		tenant: N1,
		title: "N1 draft winner",
		slug: "drafted",
		body: "N1 over draft",
		content: "safe_nodes",
	});
	const n1Hidden = await revision({
		id: randomUUID(),
		article: hidden,
		tenant: N1,
		title: "N1 hidden alternate",
		slug: "hidden",
		body: "N1 visible",
		content: "safe_nodes",
	});
	const sxBody = await revision({
		id: randomUUID(),
		article: departed,
		tenant: Sx,
		title: "Sx depart",
		slug: "departed",
		body: "Sx private",
		content: "safe_nodes",
	});
	await revision({
		id: randomUUID(),
		article: orgChurch,
		tenant: S1,
		title: "Church only article",
		slug: "org/church-only",
		body: "Church only body",
		content: "safe_nodes",
	});
	await revision({
		id: randomUUID(),
		article: orgNet,
		tenant: N1,
		title: "Network only article",
		slug: "org/network-only",
		body: "Network only body",
		content: "safe_nodes",
	});
	await orgCopy(S1, lead, "S1 text", "published", s1Lead);
	await orgCopy(S2, lead, "S2 guidance.", "published", s2Lead);
	await orgCopy(S1, ranked, "S1 rank text", "published", s1Rank);
	await orgCopy(N2, ranked, "N2 rank text", "published", n2Rank);
	await orgCopy(N1, netOnly, "N1 guidance", "published", n1Net);
	await orgCopy(S1, drafted, "draft", "draft", null);
	await orgCopy(N1, drafted, "N1 over draft", "published", n1Draft);
	await orgCopy(S1, hidden, "hidden", "hide", null);
	await orgCopy(N1, hidden, "N1 visible", "published", n1Hidden);
	await orgCopy(S1, hiddenChurch, "hidden", "hide", null);
	await orgCopy(N1, hiddenNet, "hidden", "hide", null);
	await orgCopy(Sx, departed, "Sx private", "published", sxBody);
	const churchOnlyRev = (
		await admin.execute(sql`SELECT id FROM article_revision WHERE article_id=${orgChurch} AND tenant_id=${S1}`)
	).rows[0].id;
	const netOnlyRev = (
		await admin.execute(sql`SELECT id FROM article_revision WHERE article_id=${orgNet} AND tenant_id=${N1}`)
	).rows[0].id;
	await orgCopy(S1, orgChurch, "Church only body", "published", churchOnlyRev);
	await orgCopy(N1, orgNet, "Network only body", "published", netOnlyRev);
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);
	await admin.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
		VALUES(${randomUUID()},${lead},${release},1,'wiki/lead',${hash()},'Global credit')`);
	for (const [org, minutes] of [
		[S1, 5],
		[S2, 4],
		[S3, 3],
		[Sx, 2],
		[N1, 2],
		[N2, 1],
	])
		await affiliate(org, minutes);
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${roleName}`));
	} finally {
		await closeDatabase(admin);
	}
});

describe("wiki api", { concurrency: 1 }, () => {
	test(
		ac([
			"CASE-WIKI-001",
			"WR-001",
			"WR-002",
			"WR-003",
			"WR-004",
			"WR-005",
			"WR-006",
			"WR-007",
			"WR-008",
			"WR-009",
			"WR-010",
			"WR-011",
			"WR-012",
			"WR-013",
			"WR-014",
			"WR-015",
			"WR-017",
			"WR-018",
			"WR-046",
			"WR-059",
			"WR-061",
			"WR-067",
			"SEC-04",
		]) + " current corpus resolves church, network, global, hide and org-only articles",
		async () => {
			const listed = ok(await api.listArticles(db, await actor(people.owner), {}));
			assert.equal(listed.orderRevision, "0");
			assert.deepEqual(listed.churches, []);
			const leadView = await current(people.owner, lead);
			assert.equal(leadView.article.body, null);
			assert.equal(leadView.article.state, "source_order_required");
			assert.equal(leadView.article.sourceKind, "global");
			assert.notEqual(leadView.article.sourceId, S1);
			assert.notEqual(leadView.article.sourceId, S2);
			assert.equal(leadView.article.credit, "Global credit");
			assert.ok(leadView.article.alternates.some((item) => item.sourceId === S1));
			assert.ok(leadView.article.alternates.some((item) => item.sourceId === S2));
			assert.equal((await current(people.owner, netOnly)).article.body, "N1 guidance");
			assert.equal((await current(people.owner, guide)).article.sourceKind, "global");
			assert.equal((await current(people.owner, drafted)).article.body, "N1 over draft");
			assert.equal((await current(people.owner, ranked)).article.body, "S1 rank text");
			const concealed = await current(people.owner, hidden);
			assert.equal(concealed.article.body, null);
			assert.equal(concealed.article.state, "hidden");
			assert.equal(concealed.article.hidden, true);
			assert.deepEqual(concealed.article.alternates.map((item) => item.sourceId).sort(), [GLOBAL, N1].sort());
			assert.equal((await current(people.owner, hiddenChurch)).article.body, null);
			assert.deepEqual(
				(await current(people.owner, hiddenChurch)).article.alternates.map((item) => item.sourceId),
				[GLOBAL],
			);
			assert.equal((await current(people.owner, hiddenNet)).article.state, "hidden");
			const networkView = await current(people.owner, hidden, { kind: "organization", organizationId: N1 });
			assert.equal(networkView.article.body, "N1 visible");
			assert.equal(networkView.article.sourceId, N1);
			assert.equal(
				(await current(people.owner, lead, { kind: "organization", organizationId: S1 })).article.body,
				"S1 text",
			);
			assert.equal((await current(people.owner, lead, { kind: "global" })).article.body, "Global lead");
			const churchOnly = await current(people.owner, orgChurch);
			const networkOnly = await current(people.owner, orgNet);
			assert.equal(churchOnly.article.body, "Church only body");
			assert.equal(networkOnly.article.body, "Network only body");
			assert.notEqual(churchOnly.article.articleId, networkOnly.article.articleId);
			const outsider = await current(people.outsider, lead);
			assert.equal(outsider.article.body, "Global lead");
			assert.equal(outsider.article.sourceKind, "global");
			assert.equal(JSON.stringify(listed).includes("@"), false);
			assert.equal(JSON.stringify(leadView).toLowerCase().includes("email"), false);
		},
	);

	test(
		ac(["CASE-WIKI-002", "CASE-WIKI-008", "WR-038", "WR-039", "WR-040", "WR-041", "WR-054", "WR-064"]) +
			" navigation, guide and excerpts keep the global citation and add no reading",
		async () => {
			const before = await count(sql`SELECT count(*)::int AS n FROM reading`);
			const nav = ok(await api.navigation(db, await actor(people.owner), {}));
			const encoded = nav.groups.flatMap((group) => group.articles).find((item) => item.articleId === guide);
			assert.equal(encoded.encodedSlug, "leadership%2Fwith%20space");
			assert.ok(nav.relatedIds.includes(sibling));
			const neighbors = ok(await api.articleNeighbors(db, await actor(people.owner), { articleId: guide }));
			assert.deepEqual(
				neighbors.articles.map((item) => item.articleId),
				[guideExtra, sibling],
			);
			const toc = ok(await api.tableOfContents(db, await actor(people.owner), { articleId: guide }));
			assert.deepEqual(toc.headings, [
				{ level: 2, text: "Open" },
				{ level: 3, text: "Detail" },
			]);
			const found = ok(await api.contextGuide(db, await actor(people.owner), { route: "/people" }));
			assert.equal(found.found, false);
			assert.equal(found.missing, true);
			assert.equal(found.citation, null);
			assert.equal(found.articleId, null);
			assert.equal(found.body, null);
			const missed = ok(await api.contextGuide(db, await actor(people.owner), { route: "/missing" }));
			assert.equal(missed.found, false);
			assert.equal(missed.missing, true);
			assert.equal(missed.body, null);
			const longer = ok(await api.contextGuide(db, await actor(people.owner), { route: "/people/extra" }));
			assert.equal(longer.found, false);
			assert.equal(longer.articleId, null);
			const excerpt = ok(
				await api.referenceExcerpt(db, await actor(people.owner), { articleId: guide, heading: "Open" }),
			);
			assert.equal(excerpt.excerpt.includes("Visible section"), true);
			assert.equal(excerpt.errorCode, null);
			const globalView = await current(people.owner, guide, { kind: "global" });
			assert.equal(globalView.article.sourceKind, "global");
			const churchView = await current(people.owner, lead, { kind: "organization", organizationId: S2 });
			assert.equal(churchView.article.body, "S2 guidance.");
			assert.equal(churchView.article.state, "published");
			assert.equal(await count(sql`SELECT count(*)::int AS n FROM reading`), before);
		},
	);

	test(
		ac(["CASE-WIKI-003"]) + " search ranks title above body and reports a lock timeout",
		{ timeout: 20_000 },
		async () => {
			const titleHit = randomUUID();
			const bodyHit = randomUUID();
			await item(titleHit, "article", "zulu-rank", GLOBAL);
			await item(bodyHit, "article", "alpha-rank", GLOBAL);
			await revision({
				id: randomUUID(),
				article: titleHit,
				tenant: GLOBAL,
				release,
				title: "Zulu quartzmarker",
				slug: "zulu-rank",
				excerpt: "Zulu quartzmarker",
				body: "plain body",
				phase: 6,
			});
			await revision({
				id: randomUUID(),
				article: bodyHit,
				tenant: GLOBAL,
				release,
				title: "Alpha",
				slug: "alpha-rank",
				excerpt: "Alpha",
				body: "quartzmarker mention",
				phase: 6,
			});
			const empty = ok(await api.search(db, await actor(people.owner), { query: "   " }));
			assert.equal(empty.status, "empty");
			assert.deepEqual(empty.results, []);
			const hit = ok(await api.search(db, await actor(people.owner), { query: "Zephyrguide" }));
			assert.equal(hit.status, "empty");
			const found = ok(await api.search(db, await actor(people.owner), { query: "Guide" }));
			assert.equal(found.status, "results");
			assert.equal(
				found.results.some((item) => item.articleId === guide),
				true,
			);
			const ranked = ok(await api.search(db, await actor(people.owner), { query: "quartzmarker" }));
			assert.equal(ranked.results[0].articleId, titleHit);
			assert.equal(ranked.results[1].articleId, bodyHit);
			await admin.transaction(async (tx) => {
				await tx.execute(sql`LOCK TABLE article_revision IN ACCESS EXCLUSIVE MODE`);
				const blocked = ok(await api.search(db, await actor(people.owner), { query: "Guide" }));
				assert.equal(blocked.status, "unavailable");
				assert.equal(blocked.results, null);
			});
		},
	);

	test(
		ac(["CASE-WIKI-004", "DISC-READER-003", "WIKI49-001", "WIKI49-002", "WIKI49-003", "WR-023", "WR-025"]) +
			" progress completes above 0.80, keeps credit, and labels a later meaningful revision",
		async () => {
			const phaseBefore = await count(sql`SELECT phase AS n FROM plant WHERE id=${P}`);
			const held = ok(
				await api.updateProgress(
					db,
					await actor(people.owner),
					cmd({ articleId: departed, fraction: "0.80", plantId: P }),
				),
			);
			assert.equal(held.completed, false);
			assert.equal(held.written, true);
			const done = ok(
				await api.updateProgress(
					db,
					await actor(people.owner),
					cmd({ articleId: departed, fraction: "0.800100", plantId: P }, held.revision),
				),
			);
			assert.equal(done.completed, true);
			assert.equal(done.earnedCreditRetained, true);
			assert.equal(done.meaningfulUpdateLabel, false);
			const completions = await count(
				sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${people.owner.id} AND completed_at IS NOT NULL`,
			);
			const viewed = ok(
				await api.recordView(db, await actor(people.owner), cmd({ articleId: departed, plantId: P }, done.revision)),
			);
			assert.equal(viewed.completed, true);
			assert.equal(
				await count(
					sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${people.owner.id} AND completed_at IS NOT NULL`,
				),
				completions,
			);
			const typo = randomUUID();
			await revision({
				id: typo,
				article: departed,
				tenant: GLOBAL,
				release,
				number: 2,
				title: "Departed typo",
				slug: "departed",
				body: "Global depart typo",
				meaningful: false,
				sequence: 1,
			});
			const quiet = await current(people.owner, departed);
			assert.equal(quiet.article.completed, true);
			assert.equal(quiet.article.updatedLabel, false);
			const meaningful = randomUUID();
			await revision({
				id: meaningful,
				article: guide,
				tenant: GLOBAL,
				release,
				number: 2,
				title: "Guide revised",
				slug: "leadership/with space",
				body: "Revised guide",
				meaningful: true,
				sequence: 2,
				parent: lead,
			});
			const opened = ok(
				await api.updateProgress(db, await actor(people.owner), cmd({ articleId: guide, fraction: "0.91" })),
			);
			assert.equal(opened.completed, true);
			assert.equal(opened.meaningfulUpdateLabel, false);
			const later = randomUUID();
			await revision({
				id: later,
				article: guide,
				tenant: GLOBAL,
				release,
				number: 3,
				title: "Guide again",
				slug: "leadership/with space",
				body: "Newer guide",
				meaningful: true,
				sequence: 3,
				parent: lead,
			});
			const labeled = await current(people.owner, guide);
			assert.equal(labeled.article.completed, true);
			assert.equal(labeled.article.updatedLabel, true);
			await admin.execute(sql`UPDATE affiliation SET share_wiki=false WHERE id=${links[Sx]}`);
			const after = await current(people.owner, departed);
			assert.equal(after.article.body, "Global depart typo");
			assert.notEqual(after.article.sourceId, Sx);
			const denied = await current(people.owner, departed, { kind: "organization", organizationId: Sx });
			assert.equal(denied.article, null);
			assert.equal(denied.errorCode, "content_access_denied");
			assert.equal(
				await count(
					sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${people.owner.id} AND article_id=${departed} AND completed_at IS NOT NULL`,
				),
				1,
			);
			assert.equal(await count(sql`SELECT phase AS n FROM plant WHERE id=${P}`), phaseBefore);
			assert.equal(await count(sql`SELECT count(*)::int AS n FROM mail`), 0);
			const recent = ok(await api.readingRecent(db, await actor(people.owner), {}));
			assert.equal(
				recent.articles.some((item) => item.articleId === guide),
				true,
			);
			const resume = ok(await api.readingResume(db, await actor(people.owner), {}));
			assert.equal(resume.article.articleId, guide);
		},
	);

	test(
		ac(["CASE-WIKI-005"]) + " bookmark replay and a false write stay one row and hide a departed source",
		async () => {
			const firstKey = key();
			const falseKey = key();
			const marked = async () =>
				count(
					sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${people.owner.id} AND article_id=${sibling} AND bookmarked`,
				);
			const first = ok(
				await api.setBookmark(db, await actor(people.owner), {
					requestKey: firstKey,
					expectedRevision: "0",
					input: { articleId: sibling, desired: true },
				}),
			);
			assert.equal(await marked(), 1);
			const replay = ok(
				await api.setBookmark(db, await actor(people.owner), {
					requestKey: firstKey,
					expectedRevision: "0",
					input: { articleId: sibling, desired: true },
				}),
			);
			assert.equal(replay.revision, first.revision);
			assert.equal(replay.bookmarked, true);
			assert.equal(await marked(), 1);
			const audits = await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE action='wiki.bookmark_changed'`);
			const again = ok(
				await api.setBookmark(db, await actor(people.owner), {
					requestKey: key(),
					expectedRevision: "0",
					input: { articleId: sibling, desired: true },
				}),
			);
			assert.equal(again.bookmarked, true);
			assert.equal(again.written, false);
			assert.equal(again.revision, first.revision);
			assert.equal(await marked(), 1);
			assert.equal(
				await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE action='wiki.bookmark_changed'`),
				audits,
			);
			const off = ok(
				await api.setBookmark(db, await actor(people.owner), {
					requestKey: falseKey,
					expectedRevision: first.revision,
					input: { articleId: sibling, desired: false },
				}),
			);
			assert.equal(off.bookmarked, false);
			assert.equal(await marked(), 0);
			const offAgain = ok(
				await api.setBookmark(db, await actor(people.owner), {
					requestKey: falseKey,
					expectedRevision: first.revision,
					input: { articleId: sibling, desired: false },
				}),
			);
			assert.equal(offAgain.bookmarked, false);
			assert.equal(await marked(), 0);
			assert.equal(
				await count(
					sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${people.owner.id} AND article_id=${sibling}`,
				),
				1,
			);
			const [left, right] = await Promise.all([
				api.setBookmark(db, await actor(people.member), cmd({ articleId: orgChurch, desired: true })),
				api.setBookmark(db, await actor(people.member), cmd({ articleId: orgChurch, desired: true })),
			]);
			assert.equal(
				[left, right].filter((result) => result.status === "ok" && result.value.bookmarked).length >= 1,
				true,
			);
			assert.equal(
				await count(
					sql`SELECT count(*)::int AS n FROM reading WHERE account_id=${people.member.id} AND article_id=${orgChurch}`,
				),
				1,
			);
			await admin.execute(sql`UPDATE affiliation SET share_wiki=false WHERE id=${links[S3]}`);
			const visible = ok(await api.bookmarksList(db, await actor(people.member), {}));
			assert.equal(
				visible.articles.some((item) => item.body === "Sx private"),
				false,
			);
		},
	);

	test(
		ac([
			"WIKI-ORDER-001",
			"WR-043",
			"WR-047",
			"WR-048",
			"WR-055",
			"WR-063",
			"WR-065",
			"WR-066",
			"WR-068",
			"WR-069",
			"WR-070",
			"WR-071",
			"WR-072",
			"WR-073",
			"WR-074",
		]) + " plant admins store source order and a rejoin does not reclaim rank",
		async () => {
			const history = async () =>
				count(
					sql`SELECT count(*)::int AS n FROM audit_event WHERE action='wiki.source_order_changed' AND tenant_id=${P}`,
				);
			assert.equal(await history(), 0);
			const member = ok(
				await api.setSourceOrder(db, await actor(people.member), cmd({ churches: [S1, S2], networks: [N1, N2] })),
			);
			assert.equal(member.errorCode, "access_denied");
			assert.equal(member.historyAdded, 0);
			const orgAdmin = ok(
				await api.setSourceOrder(db, await actor(people.org), cmd({ churches: [S1, S2], networks: [N1, N2] })),
			);
			assert.equal(orgAdmin.errorCode, "access_denied");
			assert.equal(orgAdmin.orderUnchanged, true);
			const empty = ok(
				await api.setSourceOrder(db, await actor(people.owner), cmd({ churches: [], networks: [N1, N2] })),
			);
			assert.equal(empty.errorCode, "source_order_required");
			const duplicate = ok(
				await api.setSourceOrder(db, await actor(people.owner), cmd({ churches: [S1, S1], networks: [N1, N2] })),
			);
			assert.equal(duplicate.errorCode, "invalid_source_order");
			const foreign = ok(
				await api.setSourceOrder(
					db,
					await actor(people.owner),
					cmd({ churches: [S1, S2, randomUUID()], networks: [N1, N2] }),
				),
			);
			assert.equal(foreign.errorCode, "access_denied");
			assert.equal(await history(), 0);
			const saved = ok(
				await api.setSourceOrder(db, await actor(people.owner), cmd({ churches: [S2, S1], networks: [N2, N1] })),
			);
			assert.equal(saved.errorCode, null);
			assert.equal(saved.historyAdded, 1);
			assert.equal(saved.revision, "1");
			assert.equal(saved.orderUnchanged, false);
			assert.deepEqual(saved.churches, [S2, S1]);
			assert.equal((await current(people.owner, lead)).article.body, "S2 guidance.");
			assert.equal((await current(people.owner, lead)).article.sourceId, S2);
			const stale = ok(
				await api.setSourceOrder(db, await actor(people.owner), cmd({ churches: [S1, S2], networks: [N1, N2] }, "0")),
			);
			assert.equal(stale.errorCode, "revision_conflict");
			assert.equal(stale.historyAdded, 0);
			assert.equal(await history(), 1);
			const listed = ok(await api.listArticles(db, await actor(people.owner), {}));
			assert.deepEqual(listed.churches, [S2, S1]);
			assert.deepEqual(listed.networks, [N2, N1]);
			assert.equal(listed.orderRevision, "1");
			assert.equal(await history(), 1);
			const networkOnly = randomUUID();
			await admin.execute(
				sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${networkOnly},'sending_network','N3','America/Chicago',1)`,
			);
			await admin.execute(
				sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
					VALUES(${randomUUID()},${Q},${networkOnly},clock_timestamp(),false,false,false,false,true,false,false)`,
			);
			const networks = ok(
				await api.setSourceOrder(db, await actor(people.outsider), cmd({ churches: [], networks: [networkOnly] })),
			);
			assert.equal(networks.errorCode, null);
			assert.equal(networks.historyAdded, 1);
			assert.deepEqual(networks.churches, []);
			assert.deepEqual(networks.networks, [networkOnly]);
			await admin.execute(
				sql`UPDATE affiliation SET accepted_at=clock_timestamp()+interval '1 second' WHERE id=${links[S2]}`,
			);
			const rejoined = await current(people.owner, lead);
			assert.equal(rejoined.article.body, "S1 text");
			assert.equal(rejoined.article.sourceId, S1);
			assert.equal(await history(), 1);
			assert.equal(
				(await admin.execute(sql`SELECT body FROM article_revision WHERE article_id=${lead} AND tenant_id=${S2}`))
					.rows[0].body,
				"S2 guidance.",
			);
		},
	);

	test(
		ac(["CASE-WIKI-007", "WR-024", "WR-026", "WR-027", "WR-058", "WR-060"]) +
			" export checks access before the PDF renderer",
		async () => {
			renders = 0;
			const denied = ok(await api.exportPdf(db, await actor(people.owner), { articleId: hidden }));
			assert.equal(denied.bytes, null);
			assert.equal(denied.html, null);
			assert.equal(denied.errorCode, "content_access_denied");
			assert.equal(denied.fontFailureOffersPrintFallback, false);
			assert.equal(renders, 0);
			const missing = ok(
				await api.exportPdf(db, await actor(people.owner), {
					articleId: lead,
					source: { kind: "organization", organizationId: Sx },
				}),
			);
			assert.equal(missing.errorCode, "content_access_denied");
			assert.equal(renders, 0);
			const failed = ok(await api.exportPdf(db, await actor(people.owner), { articleId: lead }));
			assert.equal(renders, 1);
			assert.equal(failed.bytes, null);
			assert.equal(failed.fontFailureOffersPrintFallback, true);
			assert.equal(failed.html.includes("<link"), false);
			assert.equal(failed.html.includes("@import"), false);
			assert.equal(failed.html.includes("<pre>"), false);
			const printed = ok(await api.printArticle(db, await actor(people.owner), { articleId: lead }));
			assert.equal(renders, 1);
			assert.equal(printed.bytes, null);
			assert.equal(printed.html.includes("S1 text"), true);
			assert.equal(printed.html.includes("<pre>"), false);
			assert.equal(printed.html.includes("<footer>"), true);
			const bytes = ok(await plain.exportPdf(db, await actor(people.owner), { articleId: sibling }));
			assert.equal(Buffer.from(bytes.bytes, "base64").subarray(0, 8).toString(), "%PDF-1.4");
			const longId = randomUUID();
			const lines = Array.from({ length: 200 }, (_, index) => `Line ${String(index).padStart(3, "0")}`);
			await item(longId, "article", "long-lines", GLOBAL);
			await revision({
				id: randomUUID(),
				article: longId,
				tenant: GLOBAL,
				release,
				title: "Long lines",
				slug: "long-lines",
				body: [
					"## Kept",
					...lines,
					"- item one",
					"| A | B |",
					"| 1 | 2 |",
					'<Callout type="important">',
					"Callout text",
					"</Callout>",
				].join("\n"),
				phase: 6,
			});
			const view = await current(people.owner, longId);
			const exported = ok(await plain.exportPdf(db, await actor(people.owner), { articleId: longId }));
			const pdf = Buffer.from(exported.bytes, "base64").toString("latin1");
			assert.ok(pdf.split("/Type /Page /Parent").length > 2);
			assert.equal(pdf.includes("long-lines.pdf"), true);
			assert.equal(pdf.includes(view.article.credit), true);
			for (const line of lines) assert.equal(pdf.includes(line), true, line);
			const html = ok(await plain.printArticle(db, await actor(people.owner), { articleId: longId })).html;
			assert.equal(html.includes("<pre>"), false);
			assert.equal(html.includes("<h2>Kept</h2>"), true);
			assert.equal(html.includes("<li>item one</li>"), true);
			assert.equal(html.includes("<table>"), true);
			assert.equal(html.includes("Callout text"), true);
			assert.equal(html.includes("long-lines.pdf"), true);
			assert.equal(html.includes(view.article.credit), true);
			for (const line of lines) assert.equal(html.includes(line), true, line);
		},
	);

	test(
		ac(["CASE-WIKI-011", "SEC-05"]) + " public wiki paths stay sessionless and private reads are not cached",
		async () => {
			const sessions = await count(sql`SELECT count(*)::int AS n FROM auth_session`);
			const index = ok(await api.publicPreviewMetadata(db, { path: "/wiki", userAgent: "facebookexternalhit" }));
			const dashboard = ok(await api.publicPreviewMetadata(db, { path: "/dashboard", userAgent: "crawler" }));
			const leak = ok(await api.publicPreviewMetadata(db, { path: "/wikileaks", userAgent: "Twitterbot" }));
			assert.deepEqual(
				[index.publicPreviewAllowed, dashboard.publicPreviewAllowed, leak.publicPreviewAllowed],
				[true, false, false],
			);
			assert.equal("privateBody" in index, false);
			assert.equal("orgPreviewAllowed" in index, false);
			assert.equal(index.crawler, true);
			assert.equal(index.title, "Wiki");
			assert.equal(dashboard.crawler, true);
			const human = ok(
				await api.renderGlobalPreview(db, {
					path: "/wiki/leadership%2Fwith%20space",
					userAgent: "Mozilla/5.0 (iPhone) AppleWebKit Mobile/15E148 WhatsApp",
				}),
			);
			assert.equal(human.crawler, false);
			assert.equal(human.title, "Guide again");
			const bad = ok(await api.renderGlobalPreview(db, { path: "/wiki/%E0%A4%A", userAgent: "Googlebot" }));
			assert.equal(bad.publicPreviewAllowed, false);
			assert.equal(bad.title, null);
			assert.equal(await count(sql`SELECT count(*)::int AS n FROM auth_session`), sessions);
			const fresh = randomUUID();
			await revision({
				id: fresh,
				article: sibling,
				tenant: GLOBAL,
				release,
				number: 2,
				title: "Sibling revised",
				slug: "sibling",
				body: "Sibling revised body",
				parent: lead,
				position: 3,
			});
			assert.equal((await current(people.owner, sibling)).article.title, "Sibling revised");
		},
	);

	test(
		ac(["DISC-READER-001", "DISC-READER-002", "WR-062"]) +
			" a plant admin who finished discovery qualifies and the phase stays",
		async () => {
			const phaseBefore = await count(sql`SELECT phase AS n FROM plant WHERE id=${P}`);
			for (const articleId of discovery) {
				const row = ok(
					await api.updateProgress(db, await actor(people.lead), cmd({ articleId, fraction: "0.91", plantId: P })),
				);
				assert.equal(row.completed, true);
			}
			const leadStats = ok(await api.readingStats(db, await actor(people.lead), {}));
			assert.equal(leadStats.discoveryComplete, true);
			assert.equal(leadStats.qualifyingReader, true);
			assert.equal(leadStats.ownerRereadRequired, false);
			assert.deepEqual(leadStats.completionAtRatio, { owner: false, caller: true });
			assert.equal(leadStats.phase, 1);
			assert.equal(leadStats.articles.length, 6);
			const owner = ok(await api.readingStats(db, await actor(people.owner), {}));
			assert.equal(owner.discoveryComplete, false);
			assert.equal(owner.qualifyingReader, false);
			const member = ok(await api.readingStats(db, await actor(people.member), {}));
			assert.equal(member.qualifyingReader, false);
			const recommended = ok(await api.recommendForPhase(db, await actor(people.owner), {}));
			assert.equal(recommended.phase, 1);
			assert.equal(
				recommended.articles.some((item) => item.articleId === guideExtra),
				false,
			);
			assert.equal(await count(sql`SELECT phase AS n FROM plant WHERE id=${P}`), phaseBefore);
			assert.equal(await count(sql`SELECT count(*)::int AS n FROM mail`), 0);
			assert.equal(
				(await admin.execute(sql`SELECT body FROM article_revision WHERE article_id=${lead} AND tenant_id=${S1}`))
					.rows[0].body,
				"S1 text",
			);
		},
	);

	test(ac(["CASE-WIKI-006"]) + " own plant feedback keeps history and hides it from other plants", async () => {
		const plants = await count(sql`SELECT count(*)::int AS n FROM plant`);
		const reader = await actor(people.lead);
		ok(await api.setMine(db, reader, cmd({ articleId: guide, vote: "helpful" })));
		ok(await api.setMine(db, reader, cmd({ articleId: guide, vote: "unhelpful" })));
		const view = ok(await api.getMine(db, reader, { articleId: guide }));
		assert.equal(view.currentVote, "unhelpful");
		assert.deepEqual(view.ownHistoryVotes, ["helpful", "unhelpful"]);
		assert.equal(view.phantomPlants, 0);
		assert.equal(view.foreignVoteBody, null);
		assert.equal(await count(sql`SELECT count(*)::int AS n FROM plant`), plants);
		const foreign = ok(await api.getMine(db, await actor(people.outsider), { articleId: guide }));
		assert.equal(foreign.currentVote, null);
		assert.deepEqual(foreign.ownHistoryVotes, []);
		assert.equal(foreign.foreignVoteBody, null);
		const churchless = await enroll("member", { kind: "account" });
		const empty = ok(await api.getMine(db, await actor(churchless), { articleId: guide }));
		assert.equal(empty.currentVote, null);
		assert.deepEqual(empty.ownHistoryVotes, []);
		assert.equal(empty.foreignVoteBody, null);
		refused(
			await api.setMine(db, await actor(churchless), cmd({ articleId: guide, vote: "helpful" })),
			"access_denied",
		);
		const table = await admin.execute(sql`SELECT to_regclass('wiki_article_feedback') AS name`);
		assert.equal(table.rows[0].name, null);
	});

	test(
		ac(["CASE-WIKI-009", "WR-032", "WR-033", "WR-034", "WR-035", "WR-036", "WR-037"]) +
			" plant, member, foreign, global, ended and Evry callers publish nothing",
		async () => {
			const piece = await globalPiece("wp035/deny/" + randomUUID(), [{ text: "Global guidance." }]);
			await orgEdition(S1, piece.article, "S1 guidance.", piece.ids[0]);
			const before = await count(
				sql`SELECT count(*)::int AS n FROM article_revision WHERE article_id=${piece.article} AND tenant_id=${S1}`,
			);
			const input = {
				articleId: piece.article,
				body: "Edited organization guidance.",
				cachePath: "wiki/缓存/路径",
			};
			const plantAdmin = ok(
				await api.publishOrganizationArticle(db, await actor(people.lead), cmd({ ...input, organizationId: S1 }, "1")),
			);
			assert.equal(plantAdmin.errorCode, "editorial_access_denied");
			assert.equal(plantAdmin.publicationsAdded, 0);
			assert.equal(plantAdmin.invalidationCalls, 0);
			assert.equal(plantAdmin.additionalHistoryEntries, 0);
			const member = await enroll("member", { kind: "organization", id: S1 });
			const memberDeny = ok(
				await api.publishOrganizationArticle(db, await actor(member), cmd({ ...input, organizationId: S1 }, "1")),
			);
			assert.equal(memberDeny.errorCode, "editorial_access_denied");
			assert.equal(memberDeny.additionalHistoryEntries, 0);
			const owner = await enroll("owner", { kind: "organization", id: S1 });
			const foreign = ok(
				await api.publishOrganizationArticle(db, await actor(owner), cmd({ ...input, organizationId: S2 }, "1")),
			);
			assert.equal(foreign.errorCode, "editorial_access_denied");
			assert.equal(foreign.additionalHistoryEntries, 0);
			const globalDeny = ok(
				await api.publishOrganizationArticle(
					db,
					await actor(people.org),
					cmd({ ...input, organizationId: "global" }, "1"),
				),
			);
			assert.equal(globalDeny.errorCode, "editorial_access_denied");
			assert.equal(globalDeny.additionalHistoryEntries, 0);
			const plantOwner = ok(
				await api.publishOrganizationArticle(db, await actor(people.owner), cmd({ ...input, organizationId: S1 }, "1")),
			);
			assert.equal(plantOwner.errorCode, "editorial_access_denied");
			assert.equal(plantOwner.additionalHistoryEntries, 0);
			const ended = await enroll("admin", { kind: "organization", id: S1, ended: true });
			const endedDeny = ok(
				await api.publishOrganizationArticle(db, await actor(ended), cmd({ ...input, organizationId: S1 }, "1")),
			);
			assert.equal(endedDeny.errorCode, "editorial_access_denied");
			assert.equal(endedDeny.additionalHistoryEntries, 0);
			const evry = ok(
				await api.publishOrganizationArticle(
					db,
					await actor(people.org),
					cmd({ ...input, organizationId: S1, adapter: "Evry" }, "1"),
				),
			);
			assert.equal(evry.errorCode, "review_required");
			assert.equal(evry.additionalHistoryEntries, 0);
			assert.equal(evry.publicationsAdded, 0);
			assert.equal(evry.invalidationCalls, 0);
			assert.equal(
				await count(
					sql`SELECT count(*)::int AS n FROM article_revision WHERE article_id=${piece.article} AND tenant_id=${S1}`,
				),
				before,
			);
		},
	);

	test(
		ac(["WR-028", "WR-029", "WR-030", "WR-031"]) + " church and network owners and admins publish the next revision",
		async () => {
			const cases = [
				["owner", S1],
				["admin", S1],
				["owner", N1],
				["admin", N1],
			];
			for (const [role, org] of cases) {
				if (role === "owner")
					await admin.execute(
						sql`UPDATE seat SET ended_at=clock_timestamp() WHERE organization_id=${org} AND role='owner' AND ended_at IS NULL`,
					);
				const who = role === "admin" && org === S1 ? people.org : await enroll(role, { kind: "organization", id: org });
				const piece = await globalPiece("wp035/publish/" + org + "/" + randomUUID(), [{ text: "Global guidance." }]);
				await orgEdition(org, piece.article, "S1 guidance.", piece.ids[0]);
				const value = ok(
					await api.publishOrganizationArticle(
						db,
						await actor(who),
						cmd(
							{
								articleId: piece.article,
								organizationId: org,
								body: "Edited organization guidance.",
								cachePath: "wiki/缓存/路径",
							},
							"1",
						),
					),
				);
				assert.equal(value.errorCode, null);
				assert.equal(value.publishedRevision, 2);
				assert.equal(value.organizationId, org);
				assert.equal(value.additionalHistoryEntries, 1);
				assert.equal(value.publicationsAdded, 0);
				assert.equal(value.invalidationCalls, 0);
				const rows = (
					await admin.execute(
						sql`SELECT revision_number, body, content_type, release_id IS NULL AS no_release
							FROM article_revision WHERE article_id=${piece.article} AND tenant_id=${org} ORDER BY revision_number`,
					)
				).rows;
				assert.equal(rows.length, 2);
				assert.equal(rows[0].body, "S1 guidance.");
				assert.equal(rows[1].body, "Edited organization guidance.");
				assert.equal(rows[1].content_type, "safe_nodes");
				assert.equal(rows[1].no_release, true);
			}
		},
	);

	test(
		ac(["WR-019", "WR-020", "WR-021", "WR-022"]) +
			" source selection keeps organization text and sends an in-app upstream notice",
		async () => {
			const inherited = await globalPiece("wp035/select/inherited/" + randomUUID(), [
				{ text: "Global guidance." },
				{ text: "Updated global guidance.", meaningful: false },
			]);
			const inheritedView = await current(people.owner, inherited.article);
			assert.equal(inheritedView.article.revisionNumber, 2);
			assert.equal(inheritedView.article.body, "Updated global guidance.");
			assert.equal(inheritedView.article.sourceKind, "global");
			const inheritedNote = ok(
				await api.emitUpstreamReview(db, await actor(people.owner), cmd({ articleId: inherited.article })),
			);
			assert.equal(inheritedNote.emailIntents, 0);
			assert.equal(inheritedNote.autoAdoptions, 0);
			assert.ok(inheritedNote.inAppCues >= 1);
			assert.equal(
				await count(
					sql`SELECT count(*)::int AS n FROM article_revision WHERE article_id=${inherited.article} AND tenant_id<>${GLOBAL}`,
				),
				0,
			);

			const network = await globalPiece("wp035/select/network/" + randomUUID(), [
				{ text: "Global guidance." },
				{ text: "Updated global guidance.", meaningful: false },
			]);
			await orgEdition(N1, network.article, "N1 guidance.", network.ids[0]);
			const networkView = await current(people.owner, network.article);
			assert.equal(networkView.article.sourceId, N1);
			assert.equal(networkView.article.body, "N1 guidance.");
			const networkNote = ok(
				await api.emitUpstreamReview(db, await actor(people.owner), cmd({ articleId: network.article })),
			);
			assert.equal(networkNote.emailIntents, 0);
			assert.equal(networkNote.autoAdoptions, 0);
			assert.ok(networkNote.inAppCues >= 1);
			assert.equal(
				(
					await admin.execute(
						sql`SELECT body FROM article_revision WHERE article_id=${network.article} AND tenant_id=${N1}`,
					)
				).rows[0].body,
				"N1 guidance.",
			);

			const church = await globalPiece("wp035/select/church/" + randomUUID(), [
				{ text: "Global guidance." },
				{ text: "Updated global guidance.", meaningful: false },
			]);
			await orgEdition(S1, church.article, "S1 guidance.", church.ids[0]);
			await orgEdition(N1, church.article, "N1 guidance.", church.ids[0]);
			const churchView = await current(people.owner, church.article);
			assert.equal(churchView.article.sourceId, S1);
			assert.equal(churchView.article.body, "S1 guidance.");
			const churchNote = ok(
				await api.emitUpstreamReview(db, await actor(people.owner), cmd({ articleId: church.article })),
			);
			assert.equal(churchNote.emailIntents, 0);
			assert.equal(churchNote.autoAdoptions, 0);
			assert.ok(churchNote.inAppCues >= 1);

			const hidden = await globalPiece("wp035/select/hidden/" + randomUUID(), [
				{ text: "Global guidance." },
				{ text: "Updated global guidance.", meaningful: false },
			]);
			await orgEdition(S1, hidden.article, "S1 guidance.", hidden.ids[0], "hide");
			await orgEdition(N1, hidden.article, "N1 guidance.", hidden.ids[0]);
			const hiddenView = await current(people.owner, hidden.article);
			assert.equal(hiddenView.article.body, null);
			assert.equal(hiddenView.article.state, "hidden");
			assert.deepEqual(hiddenView.article.alternates.map((item) => item.sourceId).sort(), [GLOBAL, N1].sort());
			const hiddenNote = ok(
				await api.emitUpstreamReview(db, await actor(people.owner), cmd({ articleId: hidden.article })),
			);
			assert.equal(hiddenNote.emailIntents, 0);
			assert.equal(hiddenNote.autoAdoptions, 0);
			assert.ok(hiddenNote.inAppCues >= 1);
			assert.equal(
				(
					await admin.execute(
						sql`SELECT body FROM article_revision WHERE article_id=${hidden.article} AND tenant_id=${N1}`,
					)
				).rows[0].body,
				"N1 guidance.",
			);
		},
	);

	test(
		ac(["CASE-NTF-014", "WIKI52-001", "WIKI52-002"]) +
			" customized organization text stays put while inherited readers move and editors get in-app notices",
		async () => {
			const article = await globalPiece("wp035/upstream/" + randomUUID(), [{ text: "Global guidance." }]);
			await orgEdition(S2, article.article, "S1 guidance.", article.ids[0]);
			await revision({
				id: randomUUID(),
				article: article.article,
				tenant: GLOBAL,
				release,
				number: 2,
				title: "wp035/upstream",
				slug: "wp035/upstream/" + article.article,
				body: "Typo fix.",
				meaningful: false,
				sequence: 2,
			});
			await revision({
				id: randomUUID(),
				article: article.article,
				tenant: GLOBAL,
				release,
				number: 3,
				title: "wp035/upstream",
				slug: "wp035/upstream/" + article.article,
				body: "Meaningful update.",
				meaningful: true,
				sequence: 3,
			});
			const editor = await enroll("admin", { kind: "organization", id: S2 });
			const revoked = await enroll("admin", { kind: "organization", id: S2, ended: true });
			const note = ok(await api.emitUpstreamReview(db, await actor(editor), cmd({ articleId: article.article })));
			assert.equal(note.inAppCues, 2);
			assert.equal(note.emailIntents, 0);
			assert.equal(note.autoAdoptions, 0);
			assert.deepEqual(note.recipientIds, [editor.id]);
			const kept = await current(people.owner, article.article);
			assert.equal(kept.article.body, "S1 guidance.");
			assert.equal(kept.article.sourceId, S2);
			const moved = await current(people.outsider, article.article);
			assert.equal(moved.article.revisionNumber, 3);
			assert.equal(moved.article.body, "Meaningful update.");
			const blocked = await current(revoked, article.article, { kind: "organization", organizationId: S2 });
			assert.equal(blocked.article, null);
			assert.equal(blocked.errorCode, "content_access_denied");
			assert.equal(
				(
					await admin.execute(
						sql`SELECT body FROM article_revision WHERE article_id=${article.article} AND tenant_id=${S2}`,
					)
				).rows[0].body,
				"S1 guidance.",
			);
		},
	);

	test("organization draft edit and hide keep every prior revision", async () => {
		const piece = await globalPiece("wp035/draft/" + randomUUID(), [{ text: "Global guidance." }]);
		const editor = await enroll("admin", { kind: "organization", id: S3 });
		const added = ok(
			await api.addOrganizationArticle(
				db,
				await actor(editor),
				cmd({ articleId: piece.article, organizationId: S3, body: "草案 指引", cachePath: "wiki/缓存/路径" }),
			),
		);
		assert.equal(added.errorCode, null);
		assert.equal(added.state, "draft");
		assert.equal(added.additionalHistoryEntries, 1);
		assert.equal(added.invalidationCalls, 0);
		assert.equal(added.publicationsAdded, 0);
		const draft = ok(
			await api.getOrganizationDraft(db, await actor(editor), { articleId: piece.article, organizationId: S3 }),
		);
		assert.equal(draft.errorCode, null);
		assert.equal(draft.body, "草案 指引");
		assert.equal(draft.revisionNumber, 1);
		assert.equal(draft.state, "draft");
		const edited = ok(
			await api.editOrganizationArticle(
				db,
				await actor(editor),
				cmd({ articleId: piece.article, organizationId: S3, body: "草案 修订" }, "1"),
			),
		);
		assert.equal(edited.additionalHistoryEntries, 1);
		assert.equal(edited.state, "draft");
		const again = ok(
			await api.getOrganizationDraft(db, await actor(editor), { articleId: piece.article, organizationId: S3 }),
		);
		assert.equal(again.body, "草案 修订");
		assert.equal(again.revisionNumber, 2);
		const hidden = ok(
			await api.hideOrganizationArticle(
				db,
				await actor(editor),
				cmd({ articleId: piece.article, organizationId: S3 }, "2"),
			),
		);
		assert.equal(hidden.state, "hide");
		assert.equal(hidden.additionalHistoryEntries, 0);
		assert.equal(
			await count(
				sql`SELECT count(*)::int AS n FROM article_revision WHERE article_id=${piece.article} AND tenant_id=${S3}`,
			),
			2,
		);
		const member = await enroll("member", { kind: "organization", id: S3 });
		const no = ok(
			await api.getOrganizationDraft(db, await actor(member), { articleId: piece.article, organizationId: S3 }),
		);
		assert.equal(no.errorCode, "editorial_access_denied");
		assert.equal(no.body, null);
	});

	test(
		ac([
			"WIKI-ENTITLEMENT-001",
			"WR-044",
			"WR-045",
			"WR-049",
			"WR-050",
			"WR-051",
			"WR-052",
			"WR-053",
			"WR-056",
			"WR-057",
		]) + " a departed church loses its body and the next church remains",
		async () => {
			await admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${links[S1]}`);
			const gone = await current(people.owner, lead, { kind: "organization", organizationId: S1 });
			assert.equal(gone.article, null);
			assert.equal(gone.errorCode, "content_access_denied");
			const surviving = await current(people.owner, lead, { kind: "organization", organizationId: S2 });
			assert.equal(surviving.article.body, "S2 guidance.");
			assert.equal(surviving.article.sourceId, S2);
			const next = await current(people.owner, lead);
			assert.notEqual(next.article.body, "S1 text");
			assert.notEqual(next.article.sourceId, S1);
			assert.equal(
				(await admin.execute(sql`SELECT body FROM article_revision WHERE article_id=${lead} AND tenant_id=${S1}`))
					.rows[0].body,
				"S1 text",
			);
			const network = await current(people.owner, netOnly);
			assert.equal(network.article.sourceId, N1);
			const released = await current(people.owner, hiddenChurch);
			assert.equal(released.article.body, "Global under hide");
			assert.equal(released.article.sourceKind, "global");
			assert.notEqual(released.article.state, "hidden");
		},
	);

	test("INV-tenancy: a forged actor with another live session cannot read or write", async () => {
		const real = await actor(people.owner);
		const other = await actor(people.lead);
		const forged = RequestActor.of(real.session, {
			...other.actor,
			context: other.actor.context,
		});
		refused(await api.getArticle(db, forged, { articleId: lead }), "access_denied");
		const audits = await count(sql`SELECT count(*)::int AS n FROM audit_event`);
		const readings = await count(sql`SELECT count(*)::int AS n FROM reading`);
		refused(await api.updateProgress(db, forged, cmd({ articleId: lead, fraction: "0.91" })), "unavailable");
		assert.equal(await count(sql`SELECT count(*)::int AS n FROM audit_event`), audits);
		assert.equal(await count(sql`SELECT count(*)::int AS n FROM reading`), readings);
	});

	test(
		ac([
			"CASE-WIKI-010",
			"GAP-REF-002",
			"REF-CASE-002",
			"REFREL-001",
			"REFREL-002",
			"REFREL-003",
			"REFREL-004",
			"REFREL-005",
			"REFREL-006",
			"REFREL-007",
			"SCHEMA-006",
			"SCHEMA-014",
		]) + " the activated global snapshot is readable and dropped wiki tables stay absent",
		async () => {
			const active = await count(
				sql`SELECT count(*)::int AS n FROM reference_activation a JOIN reference_release r ON r.id=a.release_id WHERE r.id=${release}`,
			);
			assert.equal(active, 1);
			const article = await current(people.owner, guide, { kind: "global" });
			assert.equal(article.article.sourceKind, "global");
			assert.equal(article.article.body == null, false);
			assert.equal(
				await count(
					sql`SELECT count(*)::int AS n FROM article_revision WHERE tenant_id=${GLOBAL} AND body='Organization edition.'`,
				),
				0,
			);
			const absent = await admin.execute(
				sql`SELECT to_regclass('article_link') AS link, to_regclass('wiki_preference') AS pref`,
			);
			assert.equal(absent.rows[0].link, null);
			assert.equal(absent.rows[0].pref, null);
		},
	);
});
