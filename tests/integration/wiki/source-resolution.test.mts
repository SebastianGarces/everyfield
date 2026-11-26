import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { EvryRefusal, evryActor, invokeRead, READ_DOMAINS } from "../../../packages/evry/src/index.ts";
import type { ReadAdapter } from "../../../packages/evry/src/catalog/types.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { nativeFromText } from "../../../packages/contracts/src/documents/native.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import type { SourceView } from "../../../packages/contracts/src/wiki/index.ts";
import { fixture, ok, type Actor, type Workspace } from "../../support/fixture.mts";
import { NOTHING, recorded, untouched } from "../../support/recorded.mts";

type Json = ReturnType<typeof JSON.parse>;
type Case = {
	id: string;
	given: Json;
	clock: { now: string };
	action: Json;
	expected: Json;
	name?: string;
};
const CASES: (Case & { subcases?: Case[] })[] = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
).cases.filter((c: Case) => /^(WR-\d+|WIKI-ORDER-001)$/.test(c.id));
const caseOf = (id: string) => CASES.find((c) => c.id === id)!;

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const api = createWikiProducer();
let database: Awaited<ReturnType<typeof fixture>>;
before(async () => {
	database = await fixture({ prefix: "wikicase", max: 6, clock: new Date(CASES[0]!.clock.now) });
});
after(() => database?.close());

const cmd = (input: object, expectedRevision = "0") => ({
	requestKey: randomUUID(),
	expectedRevision,
	input,
});
const keyed = (input: object) => ({ requestKey: randomUUID(), input });
const stateNumber = (label: string) => /^fixture-state-(\d+)$/.exec(label)![1]!;
const evry = new Map(
	Object.values(READ_DOMAINS)
		.flat()
		.map((a) => [a.operation as string, a as unknown as ReadAdapter<unknown>]),
);

async function world({ given }: Case) {
	const { admin, pools } = database;
	const db = pools.runtime;
	const run = admin.execute.bind(admin);
	const rows = async (q: ReturnType<typeof sql>) => (await run(q)).rows as Record<string, Json>[];
	const sources = Object.entries(given as Record<string, Json>).filter(
		([, v]) => v.fixture_type === "article_source_fixture",
	);
	const order = given["source-order"] ?? {
		sending: [],
		networks: [],
		observed_state: "fixture-state-0",
	};

	const P = await database.plant({ name: "P", timezone: given.P.timezone });
	const orgs: Record<string, Workspace & { kind: "organization" }> = {};
	const named = new Set<string>([
		...sources.map(([name]) => name),
		...Object.keys(given).filter((k) => given[k].fixture_type === "organization"),
		"foreign-S",
	]);
	for (const name of named)
		orgs[name] = await database.organization(name.startsWith("N") ? "sending_network" : "sending_church", { name });
	const nameOf = new Map(Object.entries(orgs).map(([name, org]) => [org.id, name]));
	nameOf.set(GLOBAL, "global");
	const workspace = (name: string) => (name === "P" ? P : orgs[name]!);

	const seat = given["seat-A"] as { tenant: string; role: string; active: boolean };
	const A = await database.actor(workspace(seat.tenant), seat.role.toLowerCase() as "owner" | "admin" | "member", {
		email: given.A.email.replace("@", `+${randomUUID()}@`),
		account: { registration_state: given.A.registration },
	});
	const planter = seat.tenant === "P" && seat.role === "Owner" ? A : await database.actor(P, "owner");
	await run(sql`UPDATE auth_session SET expires_at=${given["session-A"].expires_at} WHERE id=${A.session}`);
	if (!seat.active) await run(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id}`);

	const section = randomUUID();
	await run(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section',${section},${GLOBAL})`,
	);
	async function activate() {
		const id = randomUUID();
		const hash = () => randomBytes(32).toString("hex");
		await run(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
			VALUES(${id},${id},'memory://case',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
		await run(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
			SELECT ${randomUUID()},${id},coalesce(max(activation_number),0)+1,clock_timestamp(),'synthetic','case',coalesce(max(activation_number),0) FROM reference_activation`);
		return id;
	}
	const versions = new Map<string, string>();
	const articles = new Map<string, string>();
	async function article(name: string, owner: string = GLOBAL) {
		const id = randomUUID();
		await run(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},'article',${`${name}/${id}`},${owner})`,
		);
		articles.set(name, id);
		return id;
	}
	async function revision(
		articleId: string,
		tenant: string,
		label: string,
		body: string,
		at: {
			release?: string;
			number?: number;
			title?: string;
			slug?: string;
			position?: number;
			meaningful?: boolean;
			draft?: boolean;
		} = {},
	) {
		const id = randomUUID();
		versions.set(id, label);
		await run(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,related_slugs)
			VALUES(${id},${articleId},${tenant},${at.release ?? null},${at.number ?? 1},${at.title ?? "Preparing leaders"},${at.slug ?? "preparing-leaders"},${body},${body},
				${tenant === GLOBAL ? "safe_mdx" : "safe_nodes"},1,${at.position ?? 1},${randomBytes(32).toString("hex")},${at.draft ? null : sql`clock_timestamp()`},${at.meaningful ?? true},${at.number ?? 1},${section},ARRAY[]::text[])`);
		return id;
	}
	async function edition(
		org: string,
		articleId: string,
		state: "published" | "hide" | "draft",
		at: {
			label?: string;
			body?: string;
			revision?: string;
			title?: string;
			slug?: string;
			position?: number;
		} = {},
	) {
		const id = at.body
			? await revision(articleId, org, at.label ?? nameOf.get(org)!, at.body, {
					...at,
					draft: state === "draft",
				})
			: null;
		await run(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,draft_revision_id,based_on_upstream_id,revision)
			VALUES(${randomUUID()},${org},${articleId},${state},${state === "draft" ? null : id},${state === "draft" ? id : null},${upstream},${at.revision ?? "1"})`);
	}

	const first = await activate();
	const g1 = await article("g1");
	const upstream = await revision(g1, GLOBAL, "G1", "Global guidance.", { release: first });
	async function globalUpdate() {
		const { body, version, meaningful } = given.G2;
		await revision(g1, GLOBAL, "G2", body, {
			release: await activate(),
			number: version,
			meaningful,
		});
	}

	const links = new Map<string, string>();
	async function link(name: string) {
		const id = randomUUID();
		links.set(name, id);
		await run(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${id},${P.id},${orgs[name]!.id},clock_timestamp(),false,false,false,false,true,false,false)`);
	}
	const end = (name: string) =>
		run(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${links.get(name)!} AND ended_at IS NULL`);
	const rejoin = (name: string) =>
		run(sql`UPDATE affiliation SET ended_at=NULL,accepted_at=clock_timestamp() WHERE id=${links.get(name)!}`);
	const authority = async (who: Actor) => {
		const resolved = await RequestActor.resolve(db, who.session);
		assert.ok(resolved instanceof RequestActor, JSON.stringify(resolved));
		return resolved;
	};
	const ids = (names: readonly string[]) => names.map((n) => orgs[n]!.id);
	const names = (list: readonly string[]) => list.map((id) => nameOf.get(id) ?? id);
	const ranked = [...order.sending, ...order.networks] as string[];
	for (const name of ranked) await link(name);
	for (let n = 0; n < Number(stateNumber(order.observed_state)) && ranked.length; n++)
		assert.equal(
			ok(
				await api.setSourceOrder(
					db,
					await authority(planter),
					cmd({ churches: ids(order.sending), networks: ids(order.networks) }, String(n)),
				),
			).errorCode,
			null,
		);
	for (const [name, source] of sources) if (source.active && !links.has(name)) await link(name);

	for (const [name, source] of sources) {
		const org = orgs[name]!.id;
		if (source.article && !articles.has(source.article)) await article(source.article, org);
		const on = articles.get(source.article ?? "g1")!;
		const added = given.additions?.rows.some((r: Json) => r.version === source.override);
		if (added) continue;
		if (source.hidden) await edition(org, on, "hide", { body: `${name} hidden guidance.` });
		else if (source.override) await edition(org, on, "published", { label: source.override, body: source.body });
		else if (source.draft_body) await edition(org, on, "draft", { body: source.draft_body });
		else if (source.source_state === "relationship_ended")
			await edition(org, on, "published", { body: `${name} guidance.` });
	}
	for (const [index, row] of ((given.additions?.rows ?? []) as Json[]).entries()) {
		const name = row.id.startsWith("sending:") ? "S1" : "N1";
		await article(row.id, orgs[name]!.id);
		const body = given[name].override === row.version ? given[name].body : `${row.version} guidance.`;
		await edition(orgs[name]!.id, articles.get(row.id)!, "published", {
			...row,
			label: row.version,
			body,
			position: index + 2,
		});
	}

	const viewOf = (name: string | undefined): SourceView | undefined =>
		name === undefined
			? undefined
			: name === "global"
				? { kind: "global" }
				: { kind: "organization", organizationId: orgs[name]!.id };
	const get = async (articleId: string, source?: string) =>
		ok(
			await api.getArticle(db, await authority(A), {
				articleId,
				...(source ? { source: viewOf(source) } : {}),
			}),
		);
	const versionOf = (seen: Json) =>
		seen.body === null
			? null
			: seen.state === "inherited"
				? nameOf.get(seen.sourceId)!
				: (versions.get(seen.revisionId) ?? null);
	const listed = async (source?: string) =>
		ok(await api.listArticles(db, await authority(A), source ? { source: viewOf(source) } : {}));
	const orders = () =>
		rows(
			sql`SELECT result FROM audit_event WHERE tenant_id=${P.id} AND action='wiki.source_order_changed' ORDER BY occurred_at,id`,
		);
	async function tool(operation: string, input: object) {
		const adapter = evry.get(operation)!;
		try {
			return await invokeRead(db, evryActor(await authority(A)), adapter, adapter.input.parse(input));
		} catch (error) {
			assert.ok(error instanceof EvryRefusal, String(error));
			return { refused: error.code };
		}
	}

	const reads = (articleId: string, source: string) => {
		const view = viewOf(source);
		const on = async <R,>(body: (who: RequestActor) => Promise<R>) => body(await authority(A));
		const held: Record<string, () => Promise<unknown>> = {
			article: () => get(articleId),
			"source view": () => get(articleId, source),
			excerpt: () => on((a) => api.referenceExcerpt(db, a, { articleId })),
			"source excerpt": () => on((a) => api.referenceExcerpt(db, a, { articleId, source: view })),
			print: () => on((a) => api.printArticle(db, a, { articleId, source: view })),
			export: async () => {
				const made = ok(await on((a) => api.exportPdf(db, a, { articleId, source: view })));
				return made.bytes === null ? made : Buffer.from(made.bytes, "base64").toString("latin1");
			},
			tool: () => tool("wiki.referenceExcerpt", { articleId }),
		};
		const kept: Record<string, () => Promise<unknown>> = {
			list: () => listed(),
			"source list": () => listed(source),
			search: () => on((a) => api.search(db, a, { query: "guidance body draft" })),
			"source search": () => on((a) => api.search(db, a, { query: "guidance", source: view })),
			"tool search": () => tool("wiki.search", { query: "guidance" }),
			bookmarks: () => on((a) => api.bookmarksList(db, a, {})),
			recent: () => on((a) => api.readingRecent(db, a, {})),
			resume: () => on((a) => api.readingResume(db, a, {})),
			"tool resume": () => tool("wiki.reading.resume", {}),
			navigation: () => on((a) => api.navigation(db, a, { source: view })),
			suggested: () => on((a) => api.recommendForPhase(db, a, { source: view })),
			preview: () => api.renderGlobalPreview(db, { path: "/wiki/preparing-leaders" }),
			draft: () => on((a) => api.getOrganizationDraft(db, a, { articleId, organizationId: orgs[source]!.id })),
		};
		return { held, kept };
	};
	async function leaks(from: Record<string, () => Promise<unknown>>, text: string) {
		const found: string[] = [];
		for (const [name, read] of Object.entries(from)) if (JSON.stringify(await read()).includes(text)) found.push(name);
		return found;
	}
	async function history(articleId: string) {
		const reader = await authority(A);
		ok(await api.recordView(db, reader, keyed({ articleId, plantId: P.id })));
		ok(await api.updateProgress(db, reader, keyed({ articleId, plantId: P.id, fraction: "0.9" })));
		ok(await api.setBookmark(db, reader, cmd({ articleId, desired: true }, "1")));
	}

	const gone = sources.filter(([name, s]) => !s.active && links.has(name)).map(([name]) => name);
	const endGone = async () => {
		for (const name of gone) await end(name);
	};
	return {
		db,
		run,
		rows,
		P,
		A,
		planter,
		orgs,
		order,
		sources,
		articles,
		nameOf,
		g1,
		names,
		ids,
		end,
		rejoin,
		endGone,
		article,
		edition,
		globalUpdate,
		authority,
		viewOf,
		get,
		versionOf,
		listed,
		orders,
		reads,
		leaks,
		history,
	};
}
type World = Awaited<ReturnType<typeof world>>;

const quiet = async <T,>(body: () => Promise<T>) => {
	const { value, added } = await recorded(database.admin, () => untouched(database.admin, body));
	assert.deepEqual(added, NOTHING, "a read adds nothing");
	return value;
};
const sorted = (list: readonly string[]) => [...list].sort();
const titled = (w: World, articles: readonly Json[]) =>
	articles.filter((a) => a.title === "Preparing leaders" && a.articleId !== w.g1);
const labelOf = (w: World, id: string) => [...w.articles].find(([, article]) => article === id)![0];

const SOURCES_WITH_EDITIONS: Record<string, readonly string[]> = {
	"WR-059": ["S1", "S2", "N1", "foreign-S"],
	"WR-060": ["S1"],
	"WR-073": ["S1", "S2"],
};

async function readCase(c: Case) {
	const w = await world(c);
	const args = c.action.arguments;
	const expected = c.expected.result;
	for (const name of SOURCES_WITH_EDITIONS[c.id] ?? [])
		await w.edition(w.orgs[name]!.id, w.g1, "published", { body: `${name} guidance.` });

	const draft = c.id === "WR-058" ? "S1" : null;
	if (draft) {
		await w.article("S1 draft", w.orgs[draft]!.id);
		for (const on of [w.g1, w.articles.get("S1 draft")!])
			await w.edition(w.orgs[draft]!.id, on, "draft", { body: `${draft} guidance.` });
	}
	const asked: string = c.given[args.article]?.article ?? args.article;
	const articleId = draft ? w.articles.get("S1 draft")! : w.articles.get(asked)!;
	const picked: string | undefined = args.selected_source ?? args.source ?? draft ?? undefined;
	const former =
		"former_source_body" in expected || "tool_body" in expected
			? (draft ?? w.sources.find(([, s]) => s.source_state === "relationship_ended")?.[0] ?? "S1")
			: null;
	const formerText = former && (c.given[former].body ?? `${former} guidance.`);
	const surfaces = former ? w.reads(articleId, former) : null;
	if (former && surfaces && !draft) {
		await w.history(articleId);
		assert.deepEqual(
			await w.leaks(surfaces.held, formerText),
			c.id === "WR-025"
				? ["article", "source view", "excerpt", "source excerpt", "print", "export", "tool"]
				: Object.keys(surfaces.held),
			"while linked, every read carries the source's words",
		);
		assert.ok((await w.leaks(surfaces.kept, formerText)).includes("list"));
		assert.ok((await w.listed()).churches.concat((await w.listed()).networks).includes(w.orgs[former]!.id));
	}
	await w.endGone();

	const bodies = async () =>
		w.rows(
			sql`SELECT tenant_id,body,revision_number FROM article_revision WHERE article_id=${w.g1} AND tenant_id<>${GLOBAL} ORDER BY tenant_id,revision_number`,
		);
	const kept = await bodies();
	const editors = [];
	let cue: { value: Json; added: { notices: number; mail: number } } | null = null;
	if (args.new_global_version) {
		for (const [name, s] of w.sources)
			if (s.active && (s.override || s.hidden)) editors.push(await database.actor(w.orgs[name], "admin"));
		await w.globalUpdate();
		cue = await recorded(database.admin, async () =>
			ok(await api.emitUpstreamReview(w.db, await w.authority(w.A), cmd({ articleId: w.g1 }))),
		);
		assert.deepEqual(sorted(cue.value.recipientIds), sorted([w.A.id, ...editors.map((e) => e.id)]));
		assert.equal(cue.added.notices, editors.length + 1);
	}

	const saved = {
		history: (await w.orders()).length,
		order: JSON.stringify((await w.orders()).at(-1)),
	};
	const first = await quiet(() => w.get(articleId, picked));
	const seen: Json = first.article;
	const hiddenSource = w.sources.find(([, s]) => s.hidden)?.[0];
	const sourceNames = (list: Json[]) => list.map((a) => w.nameOf.get(a.sourceId) ?? a.sourceId);
	const checks: Record<string, () => unknown> = {
		selected_version: () => seen && w.versionOf(seen),
		default_body: () => seen.body,
		default_state: () => seen.state,
		alternate_published_sources: () => sourceNames(seen.alternates),
		source_views: () => sorted(sourceNames(seen.alternates)),
		hidden_source_body: async () => {
			const view = await w.get(articleId, hiddenSource);
			const { held, kept: lists } = w.reads(articleId, hiddenSource!);
			assert.deepEqual(await w.leaks({ ...held, ...lists }, `${hiddenSource} hidden guidance.`), []);
			return view.article?.body ?? null;
		},
		article_ids: async () => titled(w, (await quiet(() => w.listed())).articles).map((a) => labelOf(w, a.articleId)),
		versions: async () => titled(w, (await w.listed()).articles).map((a) => w.versionOf(a)),
		count: async () => titled(w, (await w.listed()).articles).length,
		S1_body: async () => (await w.get(articleId, "S1")).article?.body ?? null,
		S2_body: () => seen.body,
		seat_active: async () =>
			(await w.rows(sql`SELECT ended_at IS NULL AS active FROM seat WHERE account_id=${w.A.id}`))[0]!.active,
		former_source_body: async () => ((await w.leaks(surfaces!.held, formerText)).length ? formerText : null),
		cached_former_source_body: async () => ((await w.leaks(surfaces!.kept, formerText)).length ? formerText : null),
		body: () => seen?.body ?? null,
		export: async () => {
			const at = { articleId, source: w.viewOf(former!) };
			const made = [
				ok(await api.exportPdf(w.db, await w.authority(w.A), at)),
				ok(await api.printArticle(w.db, await w.authority(w.A), at)),
			];
			for (const m of made) assert.equal(m.errorCode, "content_access_denied");
			return made[0]!.bytes ?? made[0]!.html ?? made[1]!.html;
		},
		tool_body: async () =>
			(await w.leaks({ ...surfaces!.held, ...surfaces!.kept }, formerText)).length ? formerText : null,
		error_code: () => first.errorCode,
		source_ids: () => sorted(sourceNames([seen, ...seen.alternates])),
		foreign_sources: async () => {
			const found = [];
			for (const name of ["foreign-S", "S1", "S2"]) {
				const view = await w.get(articleId, name);
				if (view.article !== null || view.errorCode !== "content_access_denied") found.push(name);
			}
			const { churches, networks } = await w.listed();
			assert.deepEqual(
				sorted(w.names([...churches, ...networks])),
				sorted(w.sources.filter(([, s]) => s.active).map(([n]) => n)),
			);
			return found;
		},
		plant_wiki_write: async () => {
			const before = await bodies();
			for (const organizationId of [w.P.id, w.orgs.S1!.id])
				for (const write of [
					api.addOrganizationArticle,
					api.editOrganizationArticle,
					api.publishOrganizationArticle,
					api.hideOrganizationArticle,
				]) {
					const refused = await untouched(database.admin, async () =>
						ok(
							await write(w.db, await w.authority(w.A), cmd({ articleId, organizationId, body: c.given.P1.body }, "1")),
						),
					);
					assert.equal(refused.errorCode, "editorial_access_denied");
				}
			return JSON.stringify(await bodies()) !== JSON.stringify(before);
		},
		plant_document_write: async () => {
			const body = nativeFromText(c.given.P1.body);
			const written = ok(
				await documentsWriter.saveNative(w.db, await w.authority(w.A), {
					title: "P1",
					body,
					expectedRevision: "0",
				}),
			);
			const read = ok(
				await documentsWriter.getAuthorized(w.db, await w.authority(w.A), {
					documentId: written.id,
				}),
			);
			assert.ok(JSON.stringify(read.body).includes(c.given.P1.body));
			assert.deepEqual(w.versionOf((await w.get(articleId)).article), expected.selected_version);
			return true;
		},
		organization_body_unchanged: async () => JSON.stringify(await bodies()) === JSON.stringify(kept),
		upstream_notice: () => (cue!.added.notices > 0 && cue!.added.mail === 0 ? "in_app" : "other"),
		email_intents: async () => {
			assert.equal(cue!.value.emailIntents, cue!.added.mail);
			assert.equal(cue!.value.autoAdoptions, 0);
			return cue!.added.mail;
		},
		saved_preference_changed: async () => {
			const back = await w.get(articleId);
			assert.equal(w.versionOf(back.article), "G1", "the next plain read is the default again");
			return JSON.stringify((await w.orders()).at(-1)) !== saved.order;
		},
		stored_sending_order: async () => w.names((await w.orders()).at(-1)!.result.churches),
		saved_sending_order: async () => w.names((await w.orders()).at(-1)!.result.churches),
		order_history_added: async () => (await w.orders()).length - saved.history,
		preference_writes: async () => (await w.orders()).length - saved.history,
	};
	for (const [key, value] of Object.entries(expected)) {
		assert.ok(checks[key], `no check for ${c.id} ${key}`);
		const wanted = ["source_ids", "source_views"].includes(key) ? sorted(value as string[]) : value;
		assert.deepEqual(await checks[key]!(), wanted, `${c.id} ${key}`);
	}
	const version = expected.selected_version;
	if (version) {
		const fixtureOf = Object.values(c.given as Record<string, Json>).find((s) => s.override === version);
		const said = fixtureOf?.body ?? (version === "G2" ? c.given.G2.body : "Global guidance.");
		assert.equal(seen.body, said, `${c.id} reads the words of ${version}`);
	}
	if (draft) {
		const view = await w.get(w.g1, draft);
		assert.equal(view.article!.state, "inherited", "a draft is no version of the source");
		const g = w.reads(w.g1, draft);
		assert.deepEqual(await w.leaks({ ...g.held, ...g.kept }, formerText), []);
		await w.run(
			sql`UPDATE article_editor_state SET state='hide' WHERE organization_id=${w.orgs[draft]!.id} AND article_id=${w.g1}`,
		);
		assert.equal((await w.get(w.g1, draft)).article!.body, null);
		await w.end(draft);
		assert.equal((await w.get(w.g1, draft)).errorCode, "content_access_denied");
		assert.deepEqual(await w.leaks({ ...g.held, ...g.kept }, formerText), []);
	}
}

const named = (title: string) => /^AC:(\S+) /.exec(title)![1]!;

const READS = [
	"AC:WR-001 a sending church's edit comes before a network's",
	"AC:WR-002 a network's edit shows when the sending church has none",
	"AC:WR-003 the global article shows when no source edited it",
	"AC:WR-004 a sending church with no version does not stand in a network's way",
	"AC:WR-005 a sending church's edit shows over a network's default",
	"AC:WR-006 a sending church's own article is read",
	"AC:WR-007 a network's own article is read",
	"AC:WR-008 two sources' own articles with one title and slug both stay",
	"AC:WR-009 a hiding church hides the default and the network's edit stays findable",
	"AC:WR-010 a hiding church leaves only the global version to find",
	"AC:WR-011 a hiding church hides the default when the network has no version",
	"AC:WR-012 a church's unpublished draft does not count as its version",
	"AC:WR-013 a network's hide does not beat a church's edit",
	"AC:WR-014 a network's hide hides the default under a church's default",
	"AC:WR-015 a network's hide hides the default when the church has no version",
	"AC:WR-017 an ended church leaves the global article",
	"AC:WR-018 a plant writes Church Documents and never the Wiki",
	"AC:WR-019 a new global version reaches a church whose sources did not edit",
	"AC:WR-020 a new global version leaves a network's edit and cues its editors in the app",
	"AC:WR-021 a new global version leaves both edits and cues their editors in the app",
	"AC:WR-022 a new global version does not uncover a hidden article",
	"AC:WR-023 an ended church's words leave every read and the network's show",
	"AC:WR-024 an ended church's own article is refused",
	"AC:WR-025 an ended network's words leave every read and the global shows",
	"AC:WR-026 an ended church's earlier version is refused",
	"AC:WR-027 an ended church's cached preview is refused",
	"AC:WR-038 no source leaves the global article",
	"AC:WR-039 the only church's edit shows",
	"AC:WR-040 the only network's edit shows",
	"AC:WR-041 a church's edit shows over a network's when each stands alone",
	"AC:WR-043 the first church in the saved order shows",
	"AC:WR-044 the first network in the saved order shows",
	"AC:WR-045 the first church's hide hides the default and the second church stays findable",
	"AC:WR-046 each source's own article is listed once",
	"AC:WR-047 one church ends and the other's version and the reader's seat stay",
	"AC:WR-048 a saved church order beats the order of joining",
	"AC:WR-049 a saved network order beats the order of joining",
	"AC:WR-050 a church's edit shows over a one-network order",
	"AC:WR-051 the second church's edit shows when the first has none",
	"AC:WR-052 a network's edit shows when the only church has none",
	"AC:WR-053 the global article shows when nobody in either order edited it",
	"AC:WR-054 picking the global view changes no saved preference",
	"AC:WR-055 picking another church's view changes no saved preference",
	"AC:WR-056 an only church's hide leaves the network and global versions findable",
	"AC:WR-057 a network's hide leaves the global version findable",
	"AC:WR-058 a draft, a hide and an ended link give no source words",
	"AC:WR-059 the source list holds only current published sources",
	"AC:WR-060 a link that ends after the source list was read is checked again on every read",
	"AC:WR-061 own articles with one title stay two articles",
	"AC:WR-062 a new global version leaves the church's edit and cues its editors in the app",
	"AC:WR-064 a hidden default names the sources that can still be opened",
	"AC:WR-066 the next church in the saved order shows when the first has none",
	"AC:WR-067 the next network in the saved order shows when the first has none",
	"AC:WR-068 an ended first church is skipped and the saved order is not rewritten",
	"AC:WR-074 an ended first church is skipped with no order write",
];
for (const title of READS) test(title, () => readCase(caseOf(named(title))));

async function publishCase(c: Case) {
	const w = await world(c);
	const args = c.action.arguments;
	const organizationId: string = args.organization === "global" ? GLOBAL : w.orgs[args.organization]!.id;
	const reviewed = stateNumber(args.reviewed_state);
	for (const [name, org] of Object.entries(w.orgs))
		if (c.given[name]?.fixture_type === "organization")
			await w.edition(org.id, w.g1, "published", { body: args.published_body, revision: reviewed });
	const stored = () =>
		w.rows(sql`SELECT r.tenant_id,r.revision_number,r.body,r.published_at IS NOT NULL AS published,e.state,e.revision::text AS revision,e.current_revision_id=r.id AS shown
			FROM article_revision r LEFT JOIN article_editor_state e ON e.article_id=r.article_id AND e.organization_id=r.tenant_id
			WHERE r.article_id=${w.g1} ORDER BY r.tenant_id,r.revision_number`);
	const before = await stored();
	const publish = async () =>
		ok(
			await api.publishOrganizationArticle(
				w.db,
				await w.authority(w.A),
				cmd(
					{
						articleId: w.g1,
						organizationId,
						body: args.body,
						...(args.adapter ? { adapter: args.adapter } : {}),
					},
					reviewed,
				),
			),
		);
	const expected = c.expected.result;
	if (expected.error_code) {
		const refused = await quiet(publish);
		assert.deepEqual(
			[refused.errorCode, refused.additionalHistoryEntries, refused.publishedRevision, refused.publicationsAdded],
			[expected.error_code, expected.additional_history_entries, null, 0],
		);
		assert.deepEqual(await stored(), before);
		return;
	}
	const { value, added } = await recorded(database.admin, publish);
	assert.equal(value.errorCode, null);
	assert.equal(value.publishedRevision, expected.published_revision);
	assert.equal(w.nameOf.get(value.organizationId!), expected.organization);
	assert.deepEqual(added, {
		audits: ["wiki.published (receipt)"],
		jobs: ["wiki_embedding"],
		notices: 0,
		mail: 0,
	});
	const own = (await stored()).filter((r) => r.tenant_id === organizationId);
	assert.deepEqual(
		own.map((r) => [r.revision_number, r.body, r.published, r.shown]),
		[
			[1, args.published_body, true, false],
			[expected.published_revision, args.body, true, true],
		],
	);
	assert.equal(own[0]!.revision, String(Number(reviewed) + 1));
	assert.deepEqual(
		(await stored()).filter((r) => r.tenant_id !== organizationId),
		before.filter((r) => r.tenant_id !== organizationId),
	);
}

const PUBLISHES = [
	"AC:WR-028 a sending church's Owner publishes its next version",
	"AC:WR-029 a sending church's Admin publishes its next version",
	"AC:WR-030 a network's Owner publishes its next version",
	"AC:WR-031 a network's Admin publishes its next version",
	"AC:WR-032 a Member publishes nothing",
	"AC:WR-033 a church's Owner publishes nothing for another church",
	"AC:WR-034 a church's Admin publishes nothing global",
	"AC:WR-035 a plant's Owner publishes nothing for its church",
	"AC:WR-036 an Admin whose seat ended publishes nothing",
	"AC:WR-037 Evry publishes nothing without a person's review",
];
for (const title of PUBLISHES) test(title, () => publishCase(caseOf(named(title))));

async function orderCase(c: Case) {
	const w = await world(c);
	const args = c.action.arguments;
	const expected = c.expected.result;
	for (const name of SOURCES_WITH_EDITIONS[c.id] ?? [])
		await w.edition(w.orgs[name]!.id, w.g1, "published", { body: `${name} guidance.` });
	const rights = async () => {
		const { article } = await w.get(w.g1);
		const open = [];
		for (const name of [...Object.keys(w.orgs), "global"]) {
			const view = await w.get(w.g1, name);
			if (view.article && view.article.state !== "inherited") open.push(name);
		}
		return {
			listed: sorted([article!, ...article!.alternates].map((a) => w.nameOf.get(a.sourceId)!)),
			open: sorted(open),
		};
	};
	const access = async () =>
		w.rows(sql`SELECT 'seat' AS kind,row_to_json(s)::text AS held FROM seat s WHERE account_id IN (${w.A.id},${w.planter.id})
			UNION ALL SELECT 'link',row_to_json(f)::text FROM affiliation f WHERE plant_id=${w.P.id} ORDER BY 1,2`);
	const held = {
		rights: await rights(),
		access: await access(),
		orders: (await w.orders()).length,
	};
	const listed = async () => {
		const seen = ok(await api.listArticles(w.db, await w.authority(w.planter), {}));
		return {
			sending: w.names(seen.churches),
			networks: w.names(seen.networks),
			revision: seen.orderRevision,
		};
	};
	const before = await listed();
	assert.deepEqual(before, {
		sending: w.order.sending,
		networks: w.order.networks,
		revision: stateNumber(w.order.observed_state),
	});
	const save = async () =>
		ok(
			await api.setSourceOrder(
				w.db,
				await w.authority(w.A),
				cmd(
					{ churches: w.ids(args.sending_order), networks: w.ids(args.network_order) },
					stateNumber(args.reviewed_state),
				),
			),
		);
	const { value, added } = await recorded(database.admin, save);
	assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []]);
	const now = await listed();
	const orders = await w.orders();
	const refused = () => {
		assert.equal(value.historyAdded, 0);
		assert.equal(value.orderUnchanged, true);
		assert.deepEqual(now, before);
		assert.deepEqual(w.names(orders.at(-1)!.result.churches), before.sending);
		return orders.length - held.orders;
	};
	const checks: Record<string, () => unknown> = {
		error_code: () => value.errorCode,
		order_unchanged: () => refused() === 0,
		stored_order: () => now.sending,
		history_added: refused,
		sending_order: () => {
			assert.deepEqual(w.names(value.churches), now.sending);
			assert.equal(orders.length, held.orders + 1);
			return now.sending;
		},
		observed_state: () => `fixture-state-${now.revision}`,
		CRM_lead_permission: async () => JSON.stringify(await access()) !== JSON.stringify(held.access),
		org_editor_permission: async () => {
			for (const name of args.sending_order) {
				const refusal = ok(
					await api.publishOrganizationArticle(
						w.db,
						await w.authority(w.A),
						cmd({
							articleId: w.g1,
							organizationId: w.orgs[name]!.id,
							body: "Edited organization guidance.",
						}),
					),
				);
				assert.equal(refusal.errorCode, "editorial_access_denied");
			}
			return (
				(await w.rows(sql`SELECT 1 FROM article_revision WHERE article_id=${w.g1} AND tenant_id<>${GLOBAL}`)).length > 0
			);
		},
		default_version: async () => {
			assert.equal(held.rights.listed.length, expected.source_view_rights.length);
			return w.versionOf((await w.get(w.g1)).article!);
		},
		source_view_rights: async () => {
			const { listed, open } = await rights();
			assert.deepEqual(open, sorted(listed));
			return listed;
		},
		rights_added: async () => {
			const after = await rights();
			return after.open.filter((name) => !held.rights.open.includes(name)).length;
		},
	};
	for (const [key, wanted] of Object.entries(expected)) {
		assert.ok(checks[key], `no check for ${c.id} ${key}`);
		assert.deepEqual(
			await checks[key]!(),
			key === "source_view_rights" ? sorted(wanted as string[]) : wanted,
			`${c.id} ${key}`,
		);
	}
}

const ORDERS = [
	"AC:WR-063 a plant Admin saves the order and gains no other right",
	"AC:WR-065 an Admin of a sending church cannot save the plant's order",
	"AC:WR-069 a church named twice is refused",
	"AC:WR-070 a network or a church that is not linked is refused in the church order",
	"AC:WR-071 an order reviewed in an earlier state is refused",
	"AC:WR-072 an empty order is refused while churches are linked",
	"AC:WR-073 a new order changes the default and no one's source views",
];
for (const title of ORDERS)
	test(title, async (t) => {
		const c = caseOf(named(title));
		await orderCase(c);
		for (const sub of c.subcases ?? [])
			await t.test(sub.name!, () => orderCase({ ...c, ...sub, id: c.id, given: { ...c.given, ...sub.given } }));
	});

test("AC:WIKI-ORDER-001 a hide wins by order, the next church wins when the first leaves, and a rejoin takes no rank", async () => {
	const c = caseOf("WIKI-ORDER-001");
	const input = c.given["case-input"];
	const expected = c.expected.result;
	const source = (name: string, state: string) => ({
		fixture_type: "article_source_fixture",
		active: true,
		hidden: state === "hidden",
		override: state === "edited" ? name : null,
		body: state === "edited" ? `${name} guidance.` : null,
	});
	const w = await world({
		...c,
		given: {
			...c.given,
			S1: source("S1", input.S1_state),
			S2: source("S2", input.S2_state),
			N1: source("N1", input.N1_state),
		},
	});
	const order = cmd({ churches: w.ids(input.sending_order), networks: w.ids(["N1"]) });
	const { value, added } = await recorded(database.admin, async () =>
		ok(await api.setSourceOrder(w.db, await w.authority(w.A), order)),
	);
	assert.deepEqual([value.errorCode, w.names(value.churches)], [null, input.sending_order]);
	assert.deepEqual([added.notices, added.mail, added.jobs], [0, 0, []]);
	assert.equal((await w.get(w.g1)).article!.body, expected.default_body);
	const view = (await w.get(w.g1, input.source_view)).article!;
	assert.equal(view.body === "S2 guidance.", expected.S2_source_view_allowed);
	const saved = (await w.orders()).length;

	await w.end("S1");
	const left = (await w.get(w.g1)).article!;
	assert.equal(w.versionOf(left), expected.S1_departure_winner);
	assert.equal(left.state === "source_order_required", expected.adoption_gate_required);
	await w.rejoin("S1");
	const back = (await w.get(w.g1)).article!;
	assert.equal(w.versionOf(back) !== "S2", expected.automatic_rejoin_rank_restored);
	assert.equal(back.body, "S2 guidance.");
	assert.equal(back.state === "source_order_required", expected.adoption_gate_required);
	assert.equal((await w.orders()).length, saved, "leaving and rejoining save no order");
	const again = ok(
		await api.setSourceOrder(
			w.db,
			await w.authority(w.A),
			cmd({ churches: w.ids(input.sending_order), networks: w.ids(["N1"]) }, "1"),
		),
	);
	assert.equal(again.errorCode, null);
	assert.equal((await w.get(w.g1)).article!.body, null, "a person's new order ranks the rejoined church first");
});
