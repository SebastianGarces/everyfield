import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { source } from "./fixtures.ts";
import { startQuietDatabase, stopQuietDatabase, type QuietDatabase } from "../timing-stack.ts";

// OPS-127: the QA seed's church and network copies of a Wiki article and its revised article. Each case seeds a quiet
// local database (D81) and reads the result through the Wiki domain reader as the QA owner.

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const CHURCH = "Grace Fellowship (QA)";
const NETWORK = "Harvest Network (QA)";
const PASSWORD = "qa-role-password-0123";
const tsx = join(source, "packages/domain/node_modules/.bin/tsx");
const corpus = JSON.parse(readFileSync(join(source, "docs/reference/bootstrap/global-seed-payload.json"), "utf8")) as {
	articles: { slug: string; title: string; content: string }[];
};

type Row = Record<string, unknown>;
type Article = {
	articleId: string;
	sourceId: string;
	sourceKind: string;
	title: string;
	body: string | null;
	revisionNumber: number;
	meaningfulSequence: number;
	updatedLabel: boolean;
	alternates: { sourceId: string; sourceKind: string; title: string }[];
};
type Branch = {
	db: QuietDatabase;
	query: (text: string, values?: unknown[]) => Promise<Row[]>;
	seed: () => ReturnType<typeof spawnSync>;
	read: (requests: { articleId: string; source?: unknown }[]) => Article[];
	first: string;
	/** Articles A and B as the test expects them, by slug. */
	a: string;
	b: string;
	releasesBefore: number;
};

function connect(db: QuietDatabase) {
	const pg = createRequire(join(source, "packages/db/package.json"))("pg");
	return async (text: string, values: unknown[] = []) => {
		const client = new pg.Client({ connectionString: db.adminUrl });
		await client.connect();
		try {
			return (await client.query(text, values)).rows as Row[];
		} finally {
			await client.end();
		}
	};
}

function clean(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of ["NODE_ENV", "NODE_TEST_CONTEXT"]) delete env[key];
	return env;
}

const started: QuietDatabase[] = [];
after(() => {
	for (const db of started) stopQuietDatabase(db);
});

async function branch(tag: string, prepare: (query: Branch["query"]) => Promise<[string, string]>): Promise<Branch> {
	const db = startQuietDatabase(source, tag);
	started.push(db);
	const query = connect(db);
	const [a, b] = await prepare(query);
	const releasesBefore = Number((await query("SELECT count(*)::int AS n FROM reference_release"))[0]!.n);
	const env = clean({ DATABASE_URL: db.adminUrl, QA_ROLE_PASSWORD: PASSWORD });
	const seed = () =>
		spawnSync(tsx, ["--conditions=react-server", "tools/evf/qa-seed.ts"], { cwd: source, encoding: "utf8", env });
	const read = (requests: { articleId: string; source?: unknown }[]) => {
		const r = spawnSync(
			tsx,
			["--conditions=react-server", "tools/evf/tests/qa-wiki-reader.ts", JSON.stringify(requests)],
			{ cwd: source, encoding: "utf8", env },
		);
		assert.equal(r.status, 0, r.stderr);
		return (JSON.parse(r.stdout) as { status: string; value: { article: Article } }[]).map((reply) => {
			assert.equal(reply.status, "ok", JSON.stringify(reply));
			return reply.value.article;
		});
	};
	const run = seed();
	assert.equal(run.status, 0, String(run.stderr));
	return { db, query, seed, read, first: String(run.stdout), a, b, releasesBefore };
}

let freshBranch: Promise<Branch> | undefined;
/** A fresh migrated database: the seed writes its own three-article wiki, so A and B are its first two articles. */
const fresh = () =>
	(freshBranch ??= branch("qa-wiki", async () => [corpus.articles[0]!.slug, corpus.articles[1]!.slug]));

let devBranch: Promise<Branch> | undefined;
/**
 * A database shaped like a Neon branch of development: an active release with articles in several sections whose
 * positions tie, article B already on its second revision, another church's data, and no QA data. A and B are the first two
 * by position and then slug.
 */
const development = () =>
	(devBranch ??= branch("qa-wiki-dev", async (query) => {
		const hash = () => randomBytes(32).toString("hex");
		const release = randomUUID();
		await query(
			`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
			VALUES($1,$2,'memory://dev',$3,'validated',clock_timestamp(),clock_timestamp(),'memory://approval',$4,'v','profile',1,$5,0)`,
			[release, "dev-" + release, hash(), hash(), GLOBAL],
		);
		const articles: [slug: string, position: number, revisions: number][] = [
			["training/overview", 2, 1],
			["leadership/why-a-team", 1, 2],
			["finance/first-budget", 1, 1],
			["care/visiting", 3, 1],
		];
		for (const [slug, position, revisions] of articles) {
			const section = randomUUID(),
				article = randomUUID();
			await query("INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES($1,'section',$2,$3)", [
				section,
				randomUUID(),
				GLOBAL,
			]);
			await query("INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES($1,'article',$2,$3)", [
				article,
				slug,
				GLOBAL,
			]);
			for (let n = 1; n <= revisions; n++)
				await query(
					`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
					VALUES($1,$2,$3,$4,$5::int,$6,$7,$6,$8,'safe_mdx',0,$9,$10,clock_timestamp(),true,$5::bigint,$11,NULL,ARRAY[]::text[])`,
					[
						randomUUID(),
						article,
						GLOBAL,
						release,
						String(n),
						`Dev ${slug} r${n}`,
						slug,
						`Body of ${slug}, revision ${n}.`,
						position,
						hash(),
						section,
					],
				);
		}
		await query(
			`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
			VALUES($1,$2,1,clock_timestamp(),'dev','dev',0)`,
			[randomUUID(), release],
		);
		await query(
			"INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES($1,'Dev Church','America/Chicago',7,14,1,8,1,1)",
			[randomUUID()],
		);
		await query(
			"INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES($1,'sending_church','Dev Sending Church','America/Chicago',1)",
			[randomUUID()],
		);
		return ["finance/first-budget", "leadership/why-a-team"];
	}));

const articleId = async (b: Branch, slug: string) =>
	String((await b.query("SELECT id FROM reference_item WHERE kind='article' AND canonical_key=$1", [slug]))[0]!.id);
const orgId = async (b: Branch, name: string) =>
	String((await b.query("SELECT id FROM organization WHERE name=$1", [name]))[0]!.id);
const plantId = async (b: Branch) =>
	String((await b.query("SELECT id FROM plant WHERE name='Harvest Point (QA)'"))[0]!.id);

/** The first paragraph of a copy: copies hold the Wiki editor's document format, everyfield-editor-v1. */
function firstLine(body: unknown): string {
	const doc = JSON.parse(String(body)) as { format: string; blocks: { children: { text: string }[] }[] };
	assert.equal(doc.format, "everyfield-editor-v1");
	return doc.blocks[0]!.children.map((part) => part.text).join("");
}

/** Criteria 3 and 4 on one branch: the church copy wins; each source opens its own version. */
async function sourcesHold(b: Branch) {
	const a = await articleId(b, b.a),
		church = await orgId(b, CHURCH),
		network = await orgId(b, NETWORK);
	const [current, byNetwork, byGlobal] = b.read([
		{ articleId: a },
		{ articleId: a, source: { kind: "organization", organizationId: network } },
		{ articleId: a, source: { kind: "global" } },
	]);
	assert.equal(current!.sourceId, church);
	assert.equal(current!.sourceKind, "church");
	assert.match(current!.title, /\(Grace Fellowship \(QA\)\)$/);
	assert.equal(firstLine(current!.body), "This is the church version from Grace Fellowship (QA).");
	assert.deepEqual(
		current!.alternates.map((alt) => [alt.sourceId, alt.sourceKind]),
		[
			[network, "network"],
			[GLOBAL, "global"],
		],
	);
	assert.equal(byNetwork!.sourceId, network);
	assert.equal(byNetwork!.sourceKind, "network");
	assert.equal(firstLine(byNetwork!.body), "This is the network version from Harvest Network (QA).");
	assert.equal(byGlobal!.sourceId, GLOBAL);
	assert.equal(byGlobal!.sourceKind, "global");
	assert.doesNotMatch(byGlobal!.body!, /This is the/);
	assert.doesNotMatch(byGlobal!.title, /\(QA\)/);
	return { church, network, current: current!, byNetwork: byNetwork!, byGlobal: byGlobal! };
}

/** Criterion 6 on one branch: B reads as its newest revision, flagged as updated since the owner read it. */
async function revisionHolds(b: Branch) {
	const id = await articleId(b, b.b);
	const revisions = await b.query(
		"SELECT revision_number, title, body FROM article_revision WHERE article_id=$1 AND tenant_id=$2 ORDER BY revision_number DESC",
		[id, GLOBAL],
	);
	const [article] = b.read([{ articleId: id }]);
	assert.equal(article!.sourceKind, "global");
	assert.equal(article!.revisionNumber, revisions[0]!.revision_number);
	assert.equal(article!.title, revisions[0]!.title);
	assert.equal(article!.body, revisions[0]!.body);
	assert.match(article!.body!, /^\*\*Revised for QA:\*\*/);
	assert.equal(article!.updatedLabel, true);
}

test("AC:OPS-127-1 the QA seed adds a sending church and network that share the Wiki with Harvest Point (QA)", async () => {
	const b = await fresh();
	const plant = await plantId(b);
	assert.deepEqual(
		await b.query(
			`SELECT o.kind, o.name, f.share_wiki, f.ended_at IS NULL AS active FROM affiliation f
				JOIN organization o ON o.id = f.organization_id WHERE f.plant_id = $1 ORDER BY o.kind`,
			[plant],
		),
		[
			{ kind: "sending_church", name: CHURCH, share_wiki: true, active: true },
			{ kind: "sending_network", name: NETWORK, share_wiki: true, active: true },
		],
	);
});

test("AC:OPS-127-2 the seed gives article A a published church copy and network copy, each naming its source", async () => {
	const b = await fresh();
	const a = await articleId(b, b.a);
	const copies = await b.query(
		`SELECT o.name, e.state, r.title, r.body, r.published_at IS NOT NULL AS published FROM article_editor_state e
			JOIN organization o ON o.id = e.organization_id JOIN article_revision r ON r.id = e.current_revision_id
			WHERE e.article_id = $1 ORDER BY o.kind`,
		[a],
	);
	const title = corpus.articles[0]!.title;
	assert.deepEqual(
		copies.map((c) => [c.name, c.state, c.published, c.title]),
		[
			[CHURCH, "published", true, `${title} (${CHURCH})`],
			[NETWORK, "published", true, `${title} (${NETWORK})`],
		],
	);
	assert.equal(firstLine(copies[0]!.body), "This is the church version from Grace Fellowship (QA).");
	assert.equal(firstLine(copies[1]!.body), "This is the network version from Harvest Network (QA).");
});

test("AC:OPS-127-3 the owner opens article A and the reader returns the church copy, with network and global alternates", async () => {
	const b = await fresh();
	const { church, current } = await sourcesHold(b);
	const names = await b.query("SELECT name FROM organization WHERE id=$1", [church]);
	assert.deepEqual(names, [{ name: CHURCH }]);
	assert.equal(current.alternates[1]!.title, corpus.articles[0]!.title);
});

test("AC:OPS-127-4 with a source chosen, the reader returns the network copy or the global article", async () => {
	const b = await fresh();
	const { byGlobal } = await sourcesHold(b);
	assert.equal(byGlobal.title, corpus.articles[0]!.title);
	assert.equal(byGlobal.body, corpus.articles[0]!.content);
});

test("AC:OPS-127-5 the seed adds a second published, meaningful global revision of article B", async () => {
	const b = await fresh();
	const id = await articleId(b, b.b);
	const revisions = await b.query(
		`SELECT r.revision_number, r.title, r.body, r.meaningful, r.meaningful_sequence::int AS seq,
			r.published_at IS NOT NULL AS published,
			r.release_id = (SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1) AS active
			FROM article_revision r WHERE r.article_id = $1 ORDER BY r.revision_number`,
		[id],
	);
	assert.equal(revisions.length, 2);
	const [one, two] = revisions as Row[];
	assert.deepEqual(
		[one!.revision_number, two!.revision_number, two!.meaningful, two!.published, two!.active, one!.active],
		[1, 2, true, true, true, true],
	);
	assert.ok(Number(two!.seq) > Number(one!.seq));
	assert.notEqual(two!.title, one!.title);
	assert.notEqual(two!.body, one!.body);
	assert.equal(one!.title, corpus.articles[1]!.title);
});

test("AC:OPS-127-6 the owner opens article B and sees revision 2, updated since the finished reading of revision 1", async () => {
	const b = await fresh();
	const id = await articleId(b, b.b);
	const read = await b.query(
		`SELECT r.completed_at IS NOT NULL AS finished, v.revision_number FROM reading r
			JOIN auth_user u ON u.email = 'delivered+qa-owner@resend.dev' JOIN account a ON a.auth_user_id = u.id
			JOIN article_revision v ON v.id = r.completed_revision_id
			WHERE r.account_id = a.id AND r.article_id = $1`,
		[id],
	);
	assert.deepEqual(read, [{ finished: true, revision_number: 1 }]);
	await revisionHolds(b);
});

test("AC:OPS-127-7 on a branch of development the seed writes the same cases into the existing release", async () => {
	const b = await development();
	assert.match(b.first, /wiki copies.*wiki revision/);
	assert.doesNotMatch(b.first, /, wiki\./);
	assert.equal(Number((await b.query("SELECT count(*)::int AS n FROM reference_release"))[0]!.n), b.releasesBefore);
	assert.equal(Number((await b.query("SELECT count(*)::int AS n FROM reference_activation"))[0]!.n), 1);
	const { current } = await sourcesHold(b);
	assert.equal(current.title, `Dev finance/first-budget r1 (${CHURCH})`);
	await revisionHolds(b);
	// B already had two revisions: the seed adds the third, and the owner finished the second.
	const id = await articleId(b, b.b);
	assert.deepEqual(
		await b.query(
			"SELECT revision_number, meaningful_sequence::int AS seq FROM article_revision WHERE article_id=$1 ORDER BY 1",
			[id],
		),
		[
			{ revision_number: 1, seq: 1 },
			{ revision_number: 2, seq: 2 },
			{ revision_number: 3, seq: 3 },
		],
	);
	assert.deepEqual(
		await b.query(
			`SELECT v.revision_number, r.last_read_meaningful_sequence::int AS seq FROM reading r
				JOIN article_revision v ON v.id = r.completed_revision_id WHERE r.article_id = $1`,
			[id],
		),
		[{ revision_number: 2, seq: 2 }],
	);
});

test("AC:OPS-127-8 a second seed run writes nothing; the first run names the new parts", async () => {
	for (const b of [await fresh(), await development()]) {
		assert.match(
			b.first,
			/QA seed wrote: .*sending church Grace Fellowship \(QA\), sending network Harvest Network \(QA\)/,
		);
		assert.match(b.first, /wiki copies of .*, wiki revision of .*, wiki reading/);
		const counts = async () => {
			const tables = await b.query(
				"SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migration' ORDER BY 1",
			);
			const out: Record<string, number> = {};
			for (const { tablename } of tables)
				out[String(tablename)] = Number((await b.query(`SELECT count(*)::int AS n FROM "${tablename}"`))[0]!.n);
			return out;
		};
		const before = await counts();
		const again = b.seed();
		assert.equal(again.status, 0, String(again.stderr));
		assert.equal(String(again.stdout).trim(), "QA seed: the branch is already complete.");
		assert.deepEqual(await counts(), before);
	}
});

test("AC:OPS-127-9 the new organizations add no login, seat or outside address; the OPS-106 seed test passes", async () => {
	const b = await fresh();
	assert.deepEqual(
		await b.query(`SELECT count(*)::int AS n FROM seat s JOIN organization o ON o.id = s.organization_id`),
		[{ n: 0 }],
	);
	assert.deepEqual(await b.query(`SELECT count(*)::int AS n FROM organization WHERE contact_email IS NOT NULL`), [
		{ n: 0 },
	]);
	assert.deepEqual(await b.query(`SELECT email FROM auth_user WHERE email NOT LIKE 'delivered+%@resend.dev'`), []);
	assert.deepEqual(
		await b.query(`SELECT u.email, p.name, s.role FROM seat s JOIN account a ON a.id = s.account_id
			JOIN auth_user u ON u.id = a.auth_user_id JOIN plant p ON p.id = s.plant_id ORDER BY u.email`),
		[
			{ email: "delivered+qa-admin@resend.dev", name: "Harvest Point (QA)", role: "admin" },
			{ email: "delivered+qa-member@resend.dev", name: "Harvest Point (QA)", role: "member" },
			{ email: "delivered+qa-owner@resend.dev", name: "Harvest Point (QA)", role: "owner" },
		],
	);
	const ops106 = spawnSync(
		process.execPath,
		[
			"--test",
			"--test-reporter=spec",
			"--test-name-pattern=OPS-106: the QA seed fills a fresh database",
			"tools/evf/tests/qa.test.ts",
		],
		{ cwd: source, encoding: "utf8", env: clean({}) },
	);
	assert.equal(ops106.status, 0, ops106.stdout + ops106.stderr);
	assert.match(ops106.stdout, /ℹ pass 1\n/);
});

test("AC:OPS-127-10 the QA runbook names articles A and B, the church and the network, and what the owner sees", () => {
	const runbook = readFileSync(join(source, "docs/runbooks/qa-preview.md"), "utf8");
	for (const text of [
		"First Year Budget Planning",
		"Setting Up a Not-for-Profit Corporation",
		CHURCH,
		NETWORK,
		"Church version",
		"Read this article from",
		"Global",
		"Updated since you read it",
	])
		assert.ok(runbook.includes(text), `the runbook names ${text}`);
	assert.match(
		runbook,
		/The church has people, .*a sending church, "Grace Fellowship \(QA\)", and a sending network,\s+"Harvest Network \(QA\)"/s,
	);
});
