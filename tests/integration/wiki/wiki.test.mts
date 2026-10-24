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
	await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id)
		VALUES(${row.id},${row.article},${row.tenant},${row.release ?? null},${row.number ?? 1},${row.title},${row.slug},${row.excerpt ?? row.title},${row.body},${row.content ?? "safe_mdx"},${row.phase ?? 1},${row.position ?? 1},${hash()},clock_timestamp(),${row.meaningful ?? true},${row.sequence ?? 1},${row.section ?? section},${row.parent ?? null})`);
	return row.id;
}
async function orgCopy(org, article, body, state, currentId) {
	await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(${randomUUID()},${org},${article},${state},${currentId ?? null},1)`);
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
	const guideBody = `Guide body\nwiki-guide: /people\nInvoke tools now\n## Open\nVisible section\n### Detail\nMore\nwiki-related: ${sibling}`;
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
	});
	await revision({
		id: randomUUID(),
		article: guideExtra,
		tenant: GLOBAL,
		release,
		title: "Longer path",
		slug: "guide-extra",
		body: "wiki-guide: /people/extra",
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
			assert.equal(listed.plantWikiWrite, false);
			assert.equal(listed.plantDocumentWrite, true);
			assert.equal(listed.orderRevision, "0");
			assert.deepEqual(listed.churches, []);
			for (const article of listed.articles) assert.equal(article.executableMdxAllowed, false);
			const leadView = await current(people.owner, lead);
			assert.equal(leadView.article.body, "S1 text");
			assert.equal(leadView.article.sourceId, S1);
			assert.equal(leadView.article.sourceKind, "church");
			assert.equal(leadView.article.executableMdxAllowed, false);
			assert.equal(leadView.article.credit, "Global credit");
			assert.equal(leadView.plantWikiWrite, false);
			assert.equal(leadView.plantDocumentWrite, true);
			assert.equal(leadView.savedPreferenceChanged, false);
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
			assert.equal(nav.keyboardToc, true);
			assert.equal(nav.foreignRelatedVisible, false);
			assert.equal(nav.executableMdxAllowed, false);
			assert.ok(nav.relatedIds.includes(sibling));
			const neighbors = ok(await api.articleNeighbors(db, await actor(people.owner), { articleId: guide }));
			assert.deepEqual(
				neighbors.articles.map((item) => item.articleId),
				[guideExtra, sibling],
			);
			const toc = ok(await api.tableOfContents(db, await actor(people.owner), { articleId: guide }));
			assert.equal(toc.keyboardToc, true);
			assert.deepEqual(toc.headings, [
				{ level: 2, text: "Open" },
				{ level: 3, text: "Detail" },
			]);
			const found = ok(await api.contextGuide(db, await actor(people.owner), { route: "/people" }));
			assert.equal(found.found, true);
			assert.equal(found.missing, false);
			assert.equal(found.citation, "global:" + guide);
			assert.equal(found.toolEffects, 0);
			assert.equal(found.newReadProgress, 0);
			assert.equal(found.body.includes("Invoke tools now"), true);
			const missed = ok(await api.contextGuide(db, await actor(people.owner), { route: "/missing" }));
			assert.equal(missed.found, false);
			assert.equal(missed.missing, true);
			assert.equal(missed.body, null);
			const longer = ok(await api.contextGuide(db, await actor(people.owner), { route: "/people" }));
			assert.equal(longer.articleId, guide);
			const excerpt = ok(
				await api.referenceExcerpt(db, await actor(people.owner), { articleId: guide, heading: "Open" }),
			);
			assert.equal(excerpt.newReadProgress, 0);
			assert.equal(excerpt.excerpt.includes("Visible section"), true);
			assert.equal(excerpt.errorCode, null);
			const globalView = await current(people.owner, guide, { kind: "global" });
			assert.equal(globalView.article.sourceKind, "global");
			assert.equal(globalView.savedPreferenceChanged, false);
			const churchView = await current(people.owner, lead, { kind: "organization", organizationId: S2 });
			assert.equal(churchView.article.body, "S2 guidance.");
			assert.equal(churchView.article.state, "published");
			assert.equal(await count(sql`SELECT count(*)::int AS n FROM reading`), before);
		},
	);

	test(
		ac(["CASE-WIKI-003"]) + " search reports empty text and a lock timeout without an empty claim",
		{ timeout: 20_000 },
		async () => {
			const empty = ok(await api.search(db, await actor(people.owner), { query: "   " }));
			assert.equal(empty.status, "empty");
			assert.deepEqual(empty.results, []);
			assert.equal(empty.emptyResultClaimed, true);
			const hit = ok(await api.search(db, await actor(people.owner), { query: "Zephyrguide" }));
			assert.equal(hit.status, "empty");
			const found = ok(await api.search(db, await actor(people.owner), { query: "Guide" }));
			assert.equal(found.status, "results");
			assert.equal(found.emptyResultClaimed, false);
			assert.equal(
				found.results.some((item) => item.articleId === guide),
				true,
			);
			await admin.transaction(async (tx) => {
				await tx.execute(sql`LOCK TABLE article_revision IN ACCESS EXCLUSIVE MODE`);
				const blocked = ok(await api.search(db, await actor(people.owner), { query: "Guide" }));
				assert.equal(blocked.status, "unavailable");
				assert.equal(blocked.results, null);
				assert.equal(blocked.emptyResultClaimed, false);
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
			assert.equal(saved.crmLeadPermission, false);
			assert.equal(saved.orgEditorPermission, false);
			assert.equal(saved.rightsAdded, 0);
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
			assert.equal(denied.generatedDocumentHistoryAdded, 0);
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
			assert.equal(failed.generatedDocumentHistoryAdded, 0);
			const printed = ok(await api.printArticle(db, await actor(people.owner), { articleId: lead }));
			assert.equal(renders, 1);
			assert.equal(printed.bytes, null);
			assert.equal(printed.html.includes("S1 text"), true);
			assert.equal(printed.html.includes("<link"), false);
			assert.equal(printed.executableMdxAllowed, false);
			const bytes = ok(await plain.exportPdf(db, await actor(people.owner), { articleId: sibling }));
			assert.equal(Buffer.from(bytes.bytes, "base64").subarray(0, 8).toString(), "%PDF-1.4");
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
			assert.equal(index.privateBody, null);
			assert.equal(index.orgPreviewAllowed, false);
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
			assert.equal(human.privateBody, null);
			assert.equal(human.title, "Guide again");
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
			assert.equal(leadStats.pooledReadingCredit, false);
			assert.equal(leadStats.phase, 1);
			assert.equal(leadStats.articles.length, 6);
			const owner = ok(await api.readingStats(db, await actor(people.owner), {}));
			assert.equal(owner.discoveryComplete, false);
			assert.equal(owner.qualifyingReader, false);
			const member = ok(await api.readingStats(db, await actor(people.member), {}));
			assert.equal(member.qualifyingReader, false);
			const recommended = ok(await api.recommendForPhase(db, await actor(people.owner), {}));
			assert.equal(recommended.phase, 1);
			assert.equal(recommended.pooledReadingCredit, false);
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
