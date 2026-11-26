import {
	APP_ORIGIN,
	appCookie,
	appModule,
	closeAppPools,
	element,
	flight,
	html,
	inRequest,
	useApp,
} from "./security-web.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { sessionId, type Owner } from "../../../../packages/contracts/src/common/index.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { sectionOperations, withSettingsWrite } from "../../../../packages/domain/src/settings/index.ts";
import { createOrganizationAdapter } from "../../../../packages/domain/src/organizations/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { evryActor, readCatalog } from "../../../../packages/evry/src/index.ts";
import { rolesWorld, type RolesWorld } from "./roles-world.mts";
import * as identity from "../../identity/support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

let w: RolesWorld;
before(async () => {
	w = await rolesWorld("security_requests");
	useApp(w.logins.runtime.url.href);
});
after(async () => {
	await closeAppPools();
	await w?.close();
});

const settings = sectionOperations({
	effects: { replan: async () => assert.fail("a profile edit replans nothing") },
} as never);
type Who = { id: string; session: string };
const profile = async (who: Who, selected: Owner, raw: unknown, authority?: RequestActor | null) => {
	const found = authority === undefined ? await RequestActor.resolve(w.db, sessionId.parse(who.session)) : authority;
	const ctx = { session: sessionId.parse(who.session), selected };
	return withSettingsWrite(w.db, found instanceof RequestActor ? found : undefined, ctx, (tx) =>
		settings.updatePlantProfile(tx, ctx, raw),
	).catch((error: Error) => ({ status: "thrown", error: { code: error.message } }) as const);
};
const revisionOf = async (plant: { id: string }) =>
	String((await w.rows<{ r: string }>(sql`SELECT revision::text AS r FROM plant WHERE id=${plant.id}`))[0]!.r);
const footprint = async () =>
	(
		await w.rows(sql`SELECT (SELECT md5(string_agg(p::text,'' ORDER BY p.id)) FROM plant p) AS plants,
			(SELECT count(*)::int FROM audit_event) AS audits, (SELECT count(*)::int FROM job) AS jobs,
			(SELECT count(*)::int FROM seat) AS seats, (SELECT count(*)::int FROM mail) AS mail`)
	)[0]!;
const CARE = /care|privateWeek|weekly/i;
const operationsOf = (actor: RequestActor) => {
	const catalog = readCatalog(evryActor(actor));
	return [
		...catalog.domains.flatMap((d) => d.operations.map((o) => o.operation)),
		...catalog.reviewedWrites.map((o) => o.operation),
	];
};

test("AC:SEC-02 foreign ids, a seatless, Member or deferred login, spoofed actor or plant, a revoked seat, a stale revision and a guessed object are refused the same way and write nothing", async (t) => {
	const c = caseOf("SEC-02");
	const { result } = c.expected;
	const exec = c.given.execution!;
	assert.deepEqual([exec.actor_role, exec.claimed_role, exec.requested_scope], ["Member", "Owner", "Q"]);
	assert.equal(c.action.arguments.operation, "plant.updateProfile");
	const P = w.plant as Owner;
	const Q = w.hidden as Owner;
	const A = w.people.admin;
	const member = w.people.member;
	const seatless = await (async () => {
		const id = randomUUID();
		const user = randomUUID();
		const session = randomUUID();
		await w.admin.execute(
			sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES(${user},'Seatless',${`${id}@example.test`},true)`,
		);
		await w.admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${id},${user},'active','discovery')`,
		);
		await w.admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
		return { id, session };
	})();
	const command = (plant: Owner, patch: Record<string, unknown>, expectedRevision: string, extra = {}) => ({
		requestKey: randomUUID(),
		expectedRevision,
		input: { plant, patch, ...extra },
	});
	const named = { name: "Taken over" };
	const answers: Record<string, unknown> = {};
	const before = await footprint();
	const qRevision = await revisionOf(Q);
	const pRevision = await revisionOf(P);

	await t.test("every attempt on the other church, or by an actor without exact authority, is refused", async () => {
		answers["own seat, foreign plant"] = await profile(A, Q, command(Q, named, qRevision));
		answers["own seat, plant id swapped into own scope"] = await profile(A, P, command(Q, named, qRevision));
		answers["the foreign id in the right shape for its own church"] = await profile(A, Q, command(P, named, pRevision));
		answers["a Member of the church"] = await profile(member, P, command(P, named, pRevision));
		answers["a seatless login"] = await profile(seatless, P, command(P, named, pRevision));
		answers["a seatless login on the foreign church"] = await profile(seatless, Q, command(Q, named, qRevision));
		answers["a guessed church that does not exist"] = await profile(
			A,
			{ kind: "plant", id: randomUUID() } as Owner,
			command({ kind: "plant", id: randomUUID() } as Owner, named, "1"),
		);
		await w.admin
			.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,role,recipient_email,token_hash,state,created_at,revision)
			VALUES(${randomUUID()},${Q.id},'seat','admin',${A.email},${randomUUID()},'pending',clock_timestamp(),1)`);
		answers["a deferred invitation to the foreign church"] = await profile(A, Q, command(Q, named, qRevision));
		const forged = await RequestActor.resolve(w.db, sessionId.parse(member.session));
		assert.ok(forged instanceof RequestActor);
		const owner = await RequestActor.resolve(w.db, sessionId.parse(w.hiddenOwner.session));
		assert.ok(owner instanceof RequestActor);
		answers["a Member carrying another session's actor"] = await profile(
			member,
			Q,
			command(Q, named, qRevision),
			owner,
		);
		for (const [name, reply] of Object.entries(answers)) {
			const code = (reply as { error?: { code?: string } }).error?.code;
			assert.equal(code === "unavailable" ? "access_denied" : code, result.error_code, name);
			assert.equal((reply as { value?: unknown }).value ?? null, result.body, name);
			assert.equal(JSON.stringify(reply).includes("Hidden Hollow"), false, name);
		}
		const bodies = new Set(
			Object.values(answers).map((reply) => JSON.stringify(reply, (k, v) => (k === "correlationId" ? "id" : v))),
		);
		assert.equal(bodies.size, 1, `a real foreign church and a guessed one answer alike: ${[...bodies].join(" | ")}`);
		assert.equal(bodies.size === 1 ? null : "existence differs", result.existence);
	});

	await t.test("claimed roles, actors and scopes in the payload are refused before any read", async () => {
		for (const extra of [
			{ role: "owner" },
			{ actorId: w.hiddenOwner.id },
			{ tenantId: Q.id },
			{ claimedRole: "Owner" },
		]) {
			const reply = await profile(A, P, command(P, named, pRevision, extra));
			assert.equal((reply as { error: { code: string } }).error.code, "invalid_input", JSON.stringify(extra));
		}
		const spoofedPlant = await profile(A, P, command({ ...P, kind: "organization" } as Owner, named, pRevision));
		assert.equal((spoofedPlant as { status: string }).status, "refused");
	});

	await t.test("an ended seat and a stale reviewed revision are refused even for the right Admin", async () => {
		const held = await RequestActor.resolve(w.db, sessionId.parse(A.session));
		assert.ok(held instanceof RequestActor);
		await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id}`);
		try {
			const revoked = await profile(A, P, command(P, named, pRevision), held);
			assert.equal((revoked as { error: { code: string } }).error.code, "unavailable");
			assert.equal((revoked as { value?: unknown }).value ?? null, result.body);
			const now = await RequestActor.resolve(w.db, sessionId.parse(A.session));
			assert.equal(now instanceof RequestActor && now.actor.context.kind === "seat", false);
		} finally {
			await w.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${A.id}`);
		}
		const stale = await profile(A, P, command(P, named, String(BigInt(pRevision) - 1n)));
		assert.equal((stale as { error: { code: string } }).error.code, "conflict");
	});

	await t.test("nothing was written and no private-care tool is offered to any of these actors", async () => {
		const after = await footprint();
		assert.deepEqual(
			{ ...after, audits: Number(after.audits) - Number(before.audits) },
			{ ...before, audits: result.domain_writes },
		);
		for (const who of [A, member, w.hiddenOwner]) {
			const actor = await RequestActor.resolve(w.db, sessionId.parse(who.session));
			assert.ok(actor instanceof RequestActor);
			assert.equal(
				operationsOf(actor).some((o) => CARE.test(o)),
				result.private_care_tool_registered,
			);
		}
		const saved = await profile(A, P, command(P, named, pRevision));
		assert.equal((saved as { status: string }).status, "ok", "the same Admin's exact own write still works");
	});
});

type Handler = (request: Request, context?: unknown) => Promise<Response>;
type Page = (props: object) => Promise<unknown>;
const webPeople = () =>
	Promise.all([
		appModule<{ GET: Handler }>("features/people/read.ts"),
		appModule<{ PeoplePage: Page; PersonPage: Page }>("features/people/routes.tsx"),
		appModule<{ exportRoute: Handler }>("features/people/import-export/server.ts"),
		appModule<{ GET: Handler }>("features/people/fields/photo-route.ts"),
	]);
const readUrl = (what: string, input: unknown) =>
	`${APP_ORIGIN}/people/read?what=${what}&in=${encodeURIComponent(JSON.stringify(input))}`;
const unstamped = (text: string) =>
	text
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
		.replace(/"digest":"[^"]*"/g, '"digest":"<digest>"')
		.replace(/"(time|start|end)":-?[\d.e+-]+/g, '"$1":0')
		.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "<instant>")
		.replace(/^:N[\d.]+$/m, ":N");

const COMPONENT_INFO = /^\{"name":"[^"]*","key":[^,]*,"env":"Server"/;
const STACK = /^\[\["[^"]*","[a-z]+:\/\//;
const rscData = (text: string) => {
	const rows = new Map<string, string>();
	for (const line of text.split("\n")) {
		const row = /^([0-9a-f]+):(.*)$/s.exec(line);
		if (row) rows.set(row[1]!, row[2]!);
	}
	const seen = new Set<string>();
	const walk = (id: string) => {
		const payload = rows.get(id);
		if (seen.has(id) || payload === undefined || /^[DJWN]/.test(payload)) return;
		if (COMPONENT_INFO.test(payload) || STACK.test(payload)) return;
		seen.add(id);
		for (const [, ref] of payload.matchAll(/"\$[@LQWBKF]?([0-9a-f]+)(?::[^"]*)?"/g)) walk(ref!);
	};
	walk("0");
	return [...seen]
		.map((id) => rows.get(id)!)
		.map((payload) => {
			if (!payload.startsWith("E")) return payload.replace(/"\$[@LQWBKF]?[0-9a-f]+(?::[^"]*)?"/g, '"$ref"');
			const { digest, message, name } = JSON.parse(payload.slice(1)) as Record<string, unknown>;
			return `E${JSON.stringify({ digest, message, name })}`;
		})
		.sort()
		.join("\n");
};

test("AC:SEC-04 another church's person, contact and assessment reach no JSON, RSC, HTML, error, stream, file or count, and a crawler header previews no organization Wiki", async (t) => {
	const c = caseOf("SEC-04");
	const { private_canary: canary } = c.action.arguments as { private_canary: string };
	const { result } = c.expected;
	const quinn = w.ids.quinn;
	await w.admin.execute(sql`UPDATE person SET display_name=${`Quinn ${canary}`} WHERE id=${quinn}`);
	const hidden = await w.as(w.hiddenOwner);
	const { withPeopleWrite, assessments } = await import("../../../../packages/domain/src/people/index.ts");
	const lens = { score: 4, notes: `${canary} assessment words` };
	const made = await withPeopleWrite(w.db, hidden, (tx, cx) =>
		assessments.createAssessment(tx, cx, {
			requestKey: randomUUID(),
			input: {
				personId: quinn,
				occurredOn: "2026-10-01",
				committed: lens,
				compelled: lens,
				contagious: lens,
				courageous: lens,
			},
		}),
	);
	assert.equal(made.status, "ok");
	const leaks = (bytes: string) => [canary, "quinn@example.test"].find((secret) => bytes.includes(secret)) ?? null;
	const [people, pages, exporter, photo] = await webPeople();
	const A = await appCookie(w.admin, w.people.admin.session);
	const B = await appCookie(w.admin, w.hiddenOwner.session);
	const json = async (cookie: string, what: string, input: unknown) =>
		inRequest({ cookie }, async () => {
			const response = await people.GET(new Request(readUrl(what, input)));
			return { status: response.status, cache: response.headers.get("cache-control"), text: await response.text() };
		});
	const missing = randomUUID();
	const surfaces: Record<string, (cookie: string, id: string) => Promise<string>> = {
		"JSON person": async (cookie, id) => (await json(cookie, "person", { personId: id })).text,
		"JSON page": async (cookie, id) => (await json(cookie, "page", { personId: id })).text,
		"JSON activities": async (cookie, id) => (await json(cookie, "activities", { personId: id, page: 1 })).text,
		"JSON assessments": async (cookie, id) => (await json(cookie, "assessments", { personId: id, page: 1 })).text,
		"JSON warnings": async (cookie, id) => (await json(cookie, "warnings", { personId: id })).text,
		"RSC and error of the person page": (cookie, id) =>
			inRequest({ cookie }, () =>
				flight(
					element(pages.PersonPage as never, {
						params: Promise.resolve({ personId: id }),
						searchParams: Promise.resolve({}),
					}),
				),
			),
		"file metadata of the photo": (cookie, id) =>
			inRequest({ cookie, headers: { "if-none-match": `"${missing}"` } }, async () => {
				const response = await photo.GET(new Request(`${APP_ORIGIN}/people/${id}/photo/${missing}`), {
					params: Promise.resolve({ personId: id, versionId: missing }),
				});
				return `${response.status} ${JSON.stringify([...response.headers])} ${await response.text()}`;
			}),
	};

	await t.test("the owning church sees the canary on the same surfaces, so the check can see it", async () => {
		assert.equal(leaks(await surfaces["JSON person"]!(B, quinn)), canary);
		const theirs = await surfaces["RSC and error of the person page"]!(B, quinn);
		assert.equal(leaks(theirs), canary);
		assert.match(await surfaces["JSON assessments"]!(B, quinn), new RegExp(canary));
	});

	await t.test("each read surface answers the foreign person exactly as an id that never existed", async () => {
		for (const [name, read] of Object.entries(surfaces)) {
			const foreign = await read(A, quinn);
			assert.equal(leaks(foreign), result.private_canary, name);
			assert.equal(leaks(foreign) ?? null, result.foreign_person_output, name);
			const shape = name.startsWith("RSC") ? (bytes: string) => unstamped(rscData(bytes)) : unstamped;
			assert.equal(shape(foreign), shape(await read(A, missing)), `${name}: existence shows`);
		}
		const refused = await json(A, "person", { personId: quinn });
		assert.deepEqual([refused.status, refused.cache], [200, "private, no-store"]);
	});

	await t.test("lists, counts, the export stream and the server-rendered HTML hold no foreign row", async () => {
		const search = (q: string) => `?q=${encodeURIComponent(q)}`;
		for (const q of ["Quinn", "Hidden", "Nobody At All"]) {
			const view = await json(A, "view", { search: search(q) });
			assert.equal(leaks(view.text), null, q);
			assert.equal(JSON.parse(view.text).data.page.total, 0, q);
			const exported = await inRequest({ cookie: A }, async () => {
				const response = await exporter.exportRoute(new Request(`${APP_ORIGIN}/api/people/export${search(q)}`));
				return { matched: response.headers.get("x-export-matched"), text: await response.text() };
			});
			assert.equal(leaks(exported.text), null, q);
			assert.equal(exported.matched, "0", q);
			const element = await inRequest({ cookie: A }, () => pages.PeoplePage({ searchParams: Promise.resolve({ q }) }));
			const rsc = await inRequest({ cookie: A }, () => flight(element));
			assert.equal(leaks(rsc), null, `RSC ${q}`);
			const page = await html(element as never, "/people");
			assert.match(page, /<h1[^>]*>People<\/h1>/);
			assert.equal(leaks(page), null, `HTML ${q}`);
		}
		const all = await json(A, "view", { search: "" });
		assert.equal(leaks(all.text), null);
		const theirs = await inRequest({ cookie: B }, () =>
			pages.PeoplePage({ searchParams: Promise.resolve({ q: "Quinn" }) }),
		);
		assert.equal(leaks(await html(theirs as never, "/people")), canary, "the owning church's HTML shows the canary");
	});

	await t.test("a crawler user agent gets no organization Wiki title, excerpt or body", async () => {
		const [article, revision, slug] = [randomUUID(), randomUUID(), "cedar/private-plan"];
		const { cedar } = (
			await w.rows<{ cedar: string }>(
				sql`SELECT tenant_id AS cedar FROM article_revision WHERE article_id=${w.ids.articles.cedar}`,
			)
		)[0]!;
		await w.admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article',${slug},${cedar})`,
		);
		await w.admin
			.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,
			excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			SELECT ${revision},${article},${cedar},NULL,1,${`Cedar ${canary}`},${slug},${`${canary} excerpt`},${`${canary} body`},
			'safe_nodes',1,2,md5(${revision}),clock_timestamp(),true,1,section_id FROM article_revision WHERE article_id=${w.ids.articles.cedar}`);
		await w.admin
			.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
			VALUES(${randomUUID()},${cedar},${article},'published',${revision},1)`);
		const { createWikiProducer } = await import("../../../../packages/domain/src/wiki/index.ts");
		const wiki = createWikiProducer();
		const path = `/wiki/${slug}`;
		const routes = await appModule<{ generateMetadata: Page; WikiPage: Page }>("features/wiki/routes.tsx");
		for (const userAgent of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "crawler", "facebookexternalhit/1.1"]) {
			for (const reply of [
				await wiki.renderGlobalPreview(w.db, { path, userAgent }),
				await wiki.publicPreviewMetadata(w.db, { path, userAgent }),
			]) {
				assert.equal(reply.status, "ok");
				const value = (reply as { value: { title: string | null; excerpt: string | null; crawler: boolean } }).value;
				assert.equal(value.crawler, true);
				assert.equal(leaks(JSON.stringify(value)), null, userAgent);
				assert.equal(
					value.title === `Cedar ${canary}` || value.excerpt !== null,
					result.org_preview_allowed,
					userAgent,
				);
			}
			const params = Promise.resolve({ slug: slug.split("/") });
			for (const cookie of [undefined, A]) {
				const bytes = await inRequest(
					{ ...(cookie ? { cookie } : {}), headers: { "user-agent": userAgent } },
					async () =>
						JSON.stringify(await routes.generateMetadata({ params })) +
						(await flight(element(routes.WikiPage as never, { params, searchParams: Promise.resolve({}) }))),
				);
				assert.equal(leaks(bytes), null, `${userAgent} ${cookie ? "signed in" : "signed out"}`);
			}
		}
	});
});

test("AC:SEC-05 a private read is never cached for the next request: after a tenant switch or a revoked seat, the warm body, memo, page, download and organization Wiki answer from current authority", async (t) => {
	const c = caseOf("SEC-05");
	const note = String(c.given["private-A"]!.note);
	const { result } = c.expected;
	const A = w.people.admin;
	const P = w.plant;
	const Q = w.hidden;
	const { createPrivateCare } = await import("../../../../packages/domain/src/intelligence/index.ts");
	const care = createPrivateCare();
	await w.admin.execute(
		sql`UPDATE account SET personal_timezone=${String(c.given.A?.personal_timezone ?? "America/Chicago")} WHERE id=${A.id}`,
	);
	const author = await w.as(A);
	const current = await care.readCurrent(w.db, author, {});
	assert.equal(current.status, "ok", JSON.stringify(current));
	const levels = { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" };
	const saved = await care.save(w.db, author, {
		requestKey: randomUUID(),
		expectedRevision: (current as { value: { revision: string } }).value.revision,
		input: { answers: levels, note },
	});
	assert.equal(saved.status, "ok", JSON.stringify(saved));
	const intelligence = await appModule<{ GET: Handler }>("features/intelligence/read.ts");
	const wikiReads = await appModule<{ GET: Handler }>("features/wiki/read.ts");
	const [people, pages, exporter] = await webPeople();
	const cookie = await appCookie(w.admin, A.session);
	const request = async () =>
		inRequest({ cookie }, async () => {
			const history = await intelligence.GET(
				new Request(
					`${APP_ORIGIN}/intelligence/read?what=history&in=${encodeURIComponent(JSON.stringify({ page: 1 }))}`,
				),
			);
			const view = await people.GET(new Request(readUrl("view", { search: "" })));
			const print = async (articleId: string) =>
				(
					await wikiReads.GET(
						new Request(
							`${APP_ORIGIN}/wiki/read?what=print&in=${encodeURIComponent(JSON.stringify({ articleId, source: null }))}`,
						),
					)
				).text();
			const exported = await exporter.exportRoute(new Request(`${APP_ORIGIN}/api/people/export`));
			const page = await flight(await pages.PeoplePage({ searchParams: Promise.resolve({}) }));
			return {
				history: await history.text(),
				cache: [
					history.headers.get("cache-control"),
					view.headers.get("cache-control"),
					exported.headers.get("cache-control"),
				],
				owner:
					(JSON.parse(await view.text()) as { data?: { page?: { owner?: { id: string } } } }).data?.page?.owner?.id ??
					null,
				page,
				download: [exported.status, await exported.text()] as const,
				grace: await print(w.ids.articles.grace),
				global: await print(w.ids.articles.global),
			};
		});
	const noStore = (header: string | null) => (header && /(^|,\s*)no-store(\s*,|$)/.test(header) ? "no-store" : header);

	const warm = await request();
	await t.test("the author's own warm read holds the note, privately and uncached", () => {
		assert.ok(warm.history.includes(note), warm.history.slice(0, 300));
		for (const header of warm.cache) {
			assert.equal(noStore(header), result.personal_cache_control, String(header));
			assert.match(String(header), /private/);
			assert.doesNotMatch(String(header), /public|max-age=[1-9]|s-maxage/);
		}
		assert.equal(warm.owner, P.id);
		assert.match(warm.grace, /Gather the Grace way/);
		assert.match(warm.global, /Gather a core group of adults/);
		assert.equal(warm.download[0], 200);
		assert.match(warm.download[1], /alma@example\.test/);
		assert.match(warm.page, /Alma Reyes/);
	});

	await t.test("after the seat moves to another church the next request reads only that church", async () => {
		await w.admin.execute(
			sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id} AND ended_at IS NULL`,
		);
		await w.admin.execute(
			sql`INSERT INTO seat(id,account_id,plant_id,role,accepted_at) VALUES(${randomUUID()},${A.id},${Q.id},'admin',clock_timestamp())`,
		);
		const moved = await request();
		assert.equal(moved.history.includes(note) ? note : null, result.private_cache_body);
		assert.equal(moved.owner === P.id, result.cross_request_memo_reused);
		assert.equal(moved.owner, Q.id);
		for (const bytes of [moved.page, moved.download[1], moved.grace])
			assert.equal(/Alma|alma@example|Gather the Grace way/.test(bytes), false, bytes.slice(0, 200));
		assert.match(moved.global, /Gather a core group of adults/, "the global corpus stays open");
		for (const header of moved.cache) assert.equal(noStore(header), result.personal_cache_control);
	});

	await t.test(
		"after the grant is revoked the next request reads nothing private, and the warm bodies are not served again",
		async () => {
			await w.admin.execute(
				sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id} AND ended_at IS NULL`,
			);
			const revoked = await request();
			assert.equal(revoked.history.includes(note) ? note : null, result.private_cache_body);
			assert.match(revoked.history, /access_denied|refused/);
			assert.equal(revoked.owner, null);
			assert.equal(revoked.download[0], 403);
			assert.equal(revoked.download[1], "");
			assert.equal(/Alma|alma@example|Gather the Grace way/.test(revoked.page + revoked.grace), false);
			assert.notEqual(revoked.history, warm.history);
			await w.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${A.id} AND plant_id=${P.id}`);
			await w.admin.execute(sql`DELETE FROM seat WHERE account_id=${A.id} AND plant_id=${Q.id}`);
			const restored = await request();
			assert.ok(restored.history.includes(note), "the author's own note comes back only with the seat");
		},
	);
});

const sideEffects = async () =>
	(
		await w.rows(sql`SELECT (SELECT count(*)::int FROM audit_event) AS audits, (SELECT count(*)::int FROM job) AS jobs,
			(SELECT count(*)::int FROM mail) AS mail, (SELECT count(*)::int FROM person_email_opt_out) AS opt_outs,
			(SELECT count(*)::int FROM auth_session) AS sessions, (SELECT count(*)::int FROM seat) AS seats,
			(SELECT md5(string_agg(g::text,'' ORDER BY g.id)) FROM participation g) AS guests,
			(SELECT md5(string_agg(j.state||j.id,'' ORDER BY j.id)) FROM job j) AS job_states`)
	)[0]!;

test("AC:SEC-06 forged hosts, origins and actor headers, an unsafe return, a GET mutation and an unsigned machine call are refused; a replayed unsubscribe or RSVP link changes nothing more", async (t) => {
	const c = caseOf("SEC-06");
	const args = c.action.arguments as {
		Host: string;
		Origin: string;
		method: string;
		repeat: number;
		request_key: string;
	};
	const { result } = c.expected;
	const web = await identity.fixture();
	t.after(() => web.close());
	const cookie = await appCookie(w.admin, w.people.admin.session);
	const [people] = await webPeople();
	const before = await sideEffects();
	const email = "origins@example.test";
	assert.equal((await identity.register(web, email)).status, 200);

	await t.test("a forged Host or forwarded host never names the app, and the return path stays on site", async () => {
		const status = await new Promise<number>((resolve, reject) => {
			const r = httpRequest(`${web.origin}/api/auth/get-session`, { headers: { host: args.Host } }, (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
			r.on("error", reject);
			r.end();
		});
		assert.equal(status, 403);
		for (let n = 0; n < args.repeat; n++) {
			const forwarded = await web.req(
				"sign-in/email",
				{ email, password: identity.password, returnTo: `https://${args.Host}/x` },
				undefined,
				{
					"x-forwarded-host": args.Host,
					"x-forwarded-proto": "https",
				},
			);
			assert.equal(forwarded.status, 200);
			assert.equal(
				forwarded.headers.getSetCookie().some((v) => v.includes(args.Host)),
				false,
			);
			assert.equal((await forwarded.json()).returnTo, null);
			for (const returnTo of [`//${args.Host}`, args.Origin, `/\\${args.Host}`, "javascript:alert(1)"]) {
				const unsafe = await web.req("sign-in/email", { email, password: identity.password, returnTo });
				assert.equal((await unsafe.json()).returnTo, null, returnTo);
			}
		}
	});

	await t.test("a browser mutation with a foreign or missing Origin is refused before it runs", async () => {
		const preview = await appModule<{ previewRoute: Handler }>("features/documents/preview-route.ts");
		const body = JSON.stringify({ templateId: "commitment-card", format: "pdf" });
		const statuses: number[] = [];
		for (let n = 0; n < args.repeat; n++)
			for (const headers of [
				{ origin: args.Origin } as Record<string, string>,
				{},
				{ origin: "null" },
				{ origin: `${APP_ORIGIN}.${args.Host}` },
				{ origin: APP_ORIGIN.replace("https:", "http:") },
				{ "sec-fetch-site": "cross-site", origin: APP_ORIGIN },
			]) {
				const response = await inRequest({ cookie, headers }, () =>
					preview.previewRoute(new Request(`${APP_ORIGIN}/documents/preview`, { method: "POST", headers, body })),
				);
				statuses.push(response.status);
				assert.deepEqual(
					[response.status, await response.json()],
					[403, { code: "origin_denied" }],
					JSON.stringify(headers),
				);
				const signIn = await web.req("sign-in/email", { email, password: identity.password }, undefined, {
					origin: (headers as { origin?: string }).origin ?? "",
				});
				statuses.push(signIn.status);
				assert.equal(signIn.headers.getSetCookie().length, 0);
				assert.equal(signIn.status, 403);
			}
		const same = await inRequest({ cookie, headers: { origin: APP_ORIGIN } }, () =>
			preview.previewRoute(
				new Request(`${APP_ORIGIN}/documents/preview`, { method: "POST", headers: { origin: APP_ORIGIN }, body }),
			),
		);
		assert.equal(same.status, 200, "the exact origin is let through to the route's own authority checks");
		assert.equal(statuses.length, 2 * 6 * args.repeat);
		assert.equal(
			statuses.some((status) => status < 400),
			result.mutation_allowed,
		);
	});

	await t.test("actor, account, plant and forwarding headers from the client choose nothing", async () => {
		const read = (headers: Record<string, string>, withCookie = true) =>
			inRequest({ ...(withCookie ? { cookie } : {}), headers }, async () =>
				JSON.parse(await (await people.GET(new Request(readUrl("view", { search: "" }), { headers }))).text()),
			);
		const forged = {
			"x-everyfield-actor": w.hiddenOwner.id,
			"x-user-id": w.hiddenOwner.user,
			"x-account-id": w.hiddenOwner.id,
			"x-plant-id": w.hidden.id,
			"x-tenant-id": w.hidden.id,
			"x-forwarded-user": w.hiddenOwner.email,
			"x-forwarded-for": "198.51.100.9",
			"x-vercel-forwarded-for": "198.51.100.10",
			authorization: `Bearer ${w.hiddenOwner.session}`,
		};
		const honest = await read({});
		const spoofed = await read(forged);
		assert.equal(spoofed.data.page.owner.id === w.hidden.id, result.forged_actor_header_trusted);
		assert.deepEqual(spoofed, honest);
		const anonymous = await read(forged, false);
		assert.deepEqual(anonymous, { status: "refused", code: "access_denied", route: true });
	});

	await t.test("GET requests and link pages write nothing", async () => {
		const start = await sideEffects();
		const { describeMessagesOptOut, messagesOptOutToken } =
			await import("../../../../packages/domain/src/communication/opt-out.ts");
		const { describeRsvpToken } = await import("../../../../packages/domain/src/meetings/index.ts");
		const ring = { current: randomBytes(32), previous: [] };
		const token = messagesOptOutToken(ring, { plantId: w.plant.id, personId: w.ids.alma });
		const webhook = await appModule<{ resendWebhookGet: () => Response }>("server/jobs/webhook-route.ts");
		for (let n = 0; n < args.repeat; n++) {
			for (const what of ["view", "person", "activities", "warnings", "page", "assessments"])
				await inRequest({ cookie }, () =>
					people.GET(new Request(readUrl(what, what === "view" ? { search: "" } : { personId: w.ids.alma, page: 1 }))),
				);
			assert.equal((await describeMessagesOptOut(w.db, ring, { token })).status, "ok");
			await describeRsvpToken(w.db, { token: randomBytes(32).toString("base64url").slice(0, 43) });
			assert.equal(webhook.resendWebhookGet().status, 405);
			for (const path of ["sign-in/email", "register", "sign-out", "reset-password"])
				assert.ok([404, 405].includes((await web.req(path)).status), path);
		}
		const end = await sideEffects();
		const changed = Object.keys(start).filter((k) => start[k] !== end[k]);
		assert.equal(changed.length, result.GET_side_effects, changed.join(", "));
	});

	await t.test("an unsigned or wrongly signed machine call runs nothing", async () => {
		const cron = await appModule<{ GET: Handler }>("app/api/cron/jobs/route.ts");
		const start = await sideEffects();
		const saved = process.env.CRON_SECRET;
		try {
			delete process.env.CRON_SECRET;
			assert.equal((await cron.GET(new Request(`${APP_ORIGIN}/api/cron/jobs`))).status, 503);
			process.env.CRON_SECRET = randomBytes(32).toString("hex");
			for (let n = 0; n < args.repeat; n++)
				for (const authorization of [
					undefined,
					"Bearer wrong",
					`Bearer ${process.env.CRON_SECRET}x`,
					process.env.CRON_SECRET,
				]) {
					const response = await cron.GET(
						new Request(`${APP_ORIGIN}/api/cron/jobs`, { headers: authorization ? { authorization } : {} }),
					);
					assert.equal(response.status === 200, result.unsigned_machine_call_allowed, String(authorization));
					assert.equal(response.status, 401);
				}
			const { resendWebhook } = await appModule<{
				resendWebhook: (r: Request, db: () => unknown, secret: string) => Promise<Response>;
			}>("server/jobs/webhook-route.ts");
			const unsigned = await resendWebhook(
				new Request(`${APP_ORIGIN}/api/webhooks/resend`, {
					method: "POST",
					body: JSON.stringify({ type: "email.bounced" }),
				}),
				() => w.db,
				`whsec_${randomBytes(32).toString("base64")}`,
			);
			assert.deepEqual([unsigned.status, (await unsigned.json()).code], [401, "invalid_signature"]);
		} finally {
			if (saved === undefined) delete process.env.CRON_SECRET;
			else process.env.CRON_SECRET = saved;
		}
		assert.deepEqual(await sideEffects(), start);
	});

	await t.test("a replayed one-click unsubscribe or RSVP link applies once", async () => {
		const ring = { current: randomBytes(32), previous: [] };
		process.env.NOTIFICATION_OPT_OUT_KEYS = ring.current.toString("base64");
		const { messagesOptOutToken } = await import("../../../../packages/domain/src/communication/opt-out.ts");
		const { POST } = await appModule<{ POST: Handler }>("features/communication/unsubscribeOneClick.ts");
		const token = messagesOptOutToken(ring, { plantId: w.plant.id, personId: w.ids.ben });
		const click = (value: string) =>
			POST(
				new Request(`${APP_ORIGIN}/unsubscribe/${value}/one-click`, {
					method: "POST",
					headers: { origin: `https://${args.Host}` },
					body: "List-Unsubscribe=One-Click",
				}),
				{ params: Promise.resolve({ token: value }) },
			);
		const optOuts = async () =>
			(
				await w.rows<{ n: number }>(
					sql`SELECT count(*)::int AS n FROM person_email_opt_out WHERE person_id=${w.ids.ben}`,
				)
			)[0]!.n;
		const clicks = [];
		for (let n = 0; n < args.repeat; n++) clicks.push((await click(token)).status);
		assert.deepEqual(clicks, [200, 200]);
		assert.equal(await optOuts(), 1);
		const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
		assert.ok([400, 403, 404].includes((await click(tampered)).status));
		assert.equal(await optOuts(), 1);

		const { answerRsvpToken } = await import("../../../../packages/domain/src/meetings/index.ts");
		const raw = randomBytes(32).toString("base64url");
		const hash = createHash("sha256").update(raw).digest("hex");
		const [guest] = await w.rows<{
			id: string;
		}>(sql`UPDATE participation SET rsvp_token_hash=${hash}, rsvp_token_open=true,
			rsvp_token_expires_at=clock_timestamp()+interval '1 day' WHERE id=(SELECT id FROM participation
			WHERE meeting_id=${w.ids.planning} AND removed_at IS NULL LIMIT 1) RETURNING id`);
		assert.ok(guest);
		const answers = [];
		for (let n = 0; n < args.repeat; n++) {
			const reply = await answerRsvpToken(w.db, { token: raw, rsvp: n === 0 ? "confirmed" : "declined" });
			answers.push(reply.status === "ok" ? "ok" : (reply as { error: { code: string } }).error.code);
		}
		assert.deepEqual(answers, ["ok", "token_closed"]);
		const [stored] = await w.rows(sql`SELECT rsvp, rsvp_source FROM participation WHERE id=${guest.id}`);
		assert.deepEqual(stored, { rsvp: "confirmed", rsvp_source: "token" });
		const recorded = await w.rows<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${guest.id} AND action='meetings.rsvp_recorded'`,
		);
		assert.equal(recorded[0]!.n, 1);
	});
	const after = await sideEffects();
	assert.deepEqual([after.seats, after.sessions, after.mail], [before.seats, before.sessions, before.mail]);
});

test("AC:SEC-07 profile patches parse on the server: no mass assignment, malformed, blank, oversize or unknown field writes, independent null clears, nothing inferred, a changed digest conflicts, roles are exact, and limits trust no forged IP", async (t) => {
	const c = caseOf("SEC-07");
	const { result } = c.expected;
	const { patch, repeat_key_with_changed_digest } = c.given["case-input"] as {
		patch: Record<string, unknown>;
		repeat_key_with_changed_digest: boolean;
	};
	const invalid = c.given.execution!.invalid_control as { id: string; name: string };
	const P = w.plant as Owner;
	const owner = w.people.owner;
	const admin = w.people.admin;
	const plantRow = async () =>
		(await w.rows<{ row: Record<string, unknown> }>(sql`SELECT to_jsonb(p) AS row FROM plant p WHERE id=${P.id}`))[0]!
			.row;
	const save = async (
		who: Who,
		input: Record<string, unknown>,
		requestKey: string = randomUUID(),
		plant: unknown = P,
	) => {
		const reply = await profile(who, P, {
			requestKey,
			expectedRevision: await revisionOf(P),
			input: { plant, patch: input },
		});
		return reply.status === "ok" ? "ok" : (reply as { error: { code: string } }).error.code;
	};

	await t.test("immutable, unknown, malformed, blank and oversize patches are refused and write nothing", async () => {
		const start = await plantRow();
		const writes = await footprint();
		const refusedPatches: Record<string, unknown>[] = [
			patch,
			{ name: "Jamie", kind: "network" },
			{ name: "Jamie", assessment_input_state: "fixture-state-999" },
			{ name: "Jamie", id: randomUUID() },
			{ name: "Jamie", tenantId: w.hidden.id },
			{ name: "Jamie", lifecycle: "pending_deletion" },
			{ name: "Jamie", timeZone: "America/New_York" },
			{ name: "Jamie", phase: 4 },
			{ name: invalid.name },
			{ name: "" },
			{ name: "x".repeat(201) },
			{ street: "x".repeat(501) },
			{ city: "x".repeat(201) },
			{ description: "x".repeat(5001) },
			{ contact: { email: "office@example.test" } },
			{ profile: { name: "Jamie" } },
			{ website: "http://not-https.example" },
			{ name: 7 },
			{},
		];
		for (const bad of refusedPatches)
			assert.equal(await save(admin, bad), "invalid_input", JSON.stringify(bad).slice(0, 80));
		assert.equal(
			await save(admin, { name: "Jamie" }, randomUUID(), { kind: "plant", id: invalid.id }),
			"invalid_input",
		);
		assert.equal(await save(admin, { name: "Jamie" }, "k".repeat(201)), "invalid_input");
		assert.equal(await save(admin, { name: "Jamie" }, ""), "invalid_input");
		const after = await plantRow();
		assert.equal(JSON.stringify(after) !== JSON.stringify(start), result.immutable_fields_changed);
		const now = await footprint();
		assert.equal(Number(now.audits) - Number(writes.audits), result.invalid_patch_writes);
		assert.deepEqual(now, writes);
	});

	await t.test(
		"boundary lengths pass, an explicit null clears only its own field, and no locality or zone is inferred",
		async () => {
			assert.equal(
				await save(admin, {
					name: ` ${"N".repeat(200)} `,
					street: "S".repeat(500),
					description: "D".repeat(5000),
					city: "Waco",
					stateProvince: "TX",
					country: "US",
				}),
				"ok",
			);
			const full = await plantRow();
			assert.deepEqual([String(full.name).length, full.street, full.city], [200, "S".repeat(500), "Waco"]);
			assert.equal(await save(admin, { city: null }), "ok");
			const cleared = await plantRow();
			assert.equal(
				cleared.city === null &&
					cleared.state_province === "TX" &&
					cleared.country === "US" &&
					cleared.street === full.street,
				result.nullable_independent_clear_allowed,
			);
			assert.equal(await save(admin, { stateProvince: null, country: null }), "ok");
			assert.equal(await save(admin, { city: "Brooklyn", stateProvince: "NY" }), "ok");
			const moved = await plantRow();
			assert.equal(moved.country !== null, result.locality_inferred);
			assert.equal(moved.timezone !== full.timezone, result.timezone_inferred);
			assert.equal(moved.timezone, "America/Chicago");
			assert.equal(await save(admin, { street: "1 Main St" }), "ok");
			assert.deepEqual([(await plantRow()).city, (await plantRow()).state_province], ["Brooklyn", "NY"]);
		},
	);

	await t.test("the same request key with a changed body is a conflict and keeps the first answer", async () => {
		assert.equal(repeat_key_with_changed_digest, true);
		const key = randomUUID();
		const first = {
			requestKey: key,
			expectedRevision: await revisionOf(P),
			input: { plant: P, patch: { name: "Jamie" } },
		};
		const saved = await profile(admin, P, first);
		assert.equal(saved.status, "ok");
		// The fresh revision, so only the stored request digest can refuse the changed body.
		const changed = await profile(admin, P, {
			requestKey: key,
			expectedRevision: await revisionOf(P),
			input: { plant: P, patch: { name: "Jamie Two" } },
		});
		const code = (changed as { error: { code: string } }).error.code;
		assert.equal(code === "conflict" ? "idempotency_conflict" : code, result.changed_digest_error);
		assert.equal((await plantRow()).name, "Jamie");
	});

	await t.test("only the church's own Owner or Admin edits its profile", async () => {
		assert.equal(await save(owner, { description: "Owner wrote this" }), "ok");
		for (const who of [w.people.member, w.people.lead, w.people.director, w.hiddenOwner])
			assert.equal(await save(who, { description: "Taken" }), "unavailable", who.email);
		assert.equal((await plantRow()).description, "Owner wrote this");
	});

	await t.test(
		"an organization profile takes its own Owner or Admin only, and refuses malformed email, unknown keys and kind changes",
		async () => {
			const { seeds } = await import("../../../support/fixture.mts");
			const seed = seeds(w.admin);
			const grace = w.grace as Owner & { kind: "organization" };
			const orgAdmin = await seed.actor(grace, "admin");
			const orgMember = await seed.actor(grace, "member");
			const other = await seed.organization("sending_church", { name: "Other Church" });
			const otherAdmin = await seed.actor(other, "admin");
			const organizations = createOrganizationAdapter(
				{ invitation: async () => {}, invalidate: () => sql`SELECT 1` },
				{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
			);
			const orgRevision = async () =>
				String(
					(await w.rows<{ r: string }>(sql`SELECT revision::text AS r FROM organization WHERE id=${grace.id}`))[0]!.r,
				);
			const update = async (who: { session: string }, selected: Owner, input: Record<string, unknown>) => {
				const v = {
					requestKey: randomUUID(),
					expectedRevision: await orgRevision(),
					input: { organization: grace, patch: input },
				};
				return gatedTransaction(w.db, async (tx) => {
					await RequestActor.claimWrite(tx, sessionId.parse(who.session), selected);
					return organizations["organizations.updateProfile"](tx, sessionId.parse(who.session), selected, v);
				}).then(
					() => "ok",
					(error: Error) => (error.name === "ZodError" ? "invalid_input" : error.message),
				);
			};
			const orgRow = async () =>
				(await w.rows(sql`SELECT kind,name,contact_email,city FROM organization WHERE id=${grace.id}`))[0]!;
			const start = await orgRow();
			for (const [who, selected] of [
				[orgMember, grace],
				[otherAdmin, other],
				[otherAdmin, grace],
				[admin, P],
				[admin, grace],
			] as const)
				assert.notEqual(await update(who, selected as Owner, { name: "Taken" }), "ok", who.email);
			for (const bad of [
				{ contactEmail: "not-an-email" },
				{ contactEmail: "a@b" },
				{ name: "   " },
				{ name: "x".repeat(201) },
				{ kind: "sending_network" },
				{ organizationKind: "sending_network" },
				{ contact: { email: "office@example.test" } },
				{ website: "http://not-https.example" },
				{ id: randomUUID() },
			])
				assert.equal(await update(orgAdmin, grace, bad), "invalid_input", JSON.stringify(bad).slice(0, 60));
			assert.deepEqual(await orgRow(), start);
			assert.equal(await update(orgAdmin, grace, { contactEmail: " Office@Example.Test ", city: null }), "ok");
			assert.equal(await update(w.people.director, grace, { name: "N".repeat(200) }), "ok");
			const saved = await orgRow();
			assert.deepEqual(
				[saved.kind, saved.contact_email, saved.city, String(saved.name).length],
				[start.kind, "office@example.test", null, 200],
			);
		},
	);

	await t.test("a forged client IP is not trusted and a parallel burst reserves exactly the budget", async () => {
		const { trustedIdentityIp } = await import("../../../../packages/domain/src/identity/index.ts");
		const forged = new Request(APP_ORIGIN, { headers: { "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.3" } });
		assert.equal(trustedIdentityIp(forged, true), null);
		assert.equal(
			trustedIdentityIp(
				new Request(APP_ORIGIN, { headers: { "x-vercel-forwarded-for": "192.0.2.1, 192.0.2.2" } }),
				true,
			),
			null,
		);
		assert.equal(
			trustedIdentityIp(new Request(APP_ORIGIN, { headers: { "x-vercel-forwarded-for": "192.0.2.2" } }), false),
			null,
		);
		const web = await identity.fixture();
		t.after(() => web.close());
		web.setIp("127.0.7.1");
		assert.equal((await identity.register(web, "burst@example.test")).status, 200);
		const statuses = await Promise.all(
			Array.from({ length: 8 }, (_, n) =>
				web
					.req("sign-in/email", { email: "burst@example.test", password: "Wrong-password-1" }, undefined, {
						"x-forwarded-for": `198.51.100.${n}`,
					})
					.then((r) => r.status),
			),
		);
		assert.deepEqual(statuses.sort(), [401, 401, 401, 401, 401, 429, 429, 429]);
		assert.equal(
			(await identity.signIn(web, "burst@example.test")).status,
			429,
			"a forged header buys no fresh budget",
		);
	});
});

test("AC:SEC-03 the real BetterAuth flows keep one credential owner: login, renewal, reset, email change and logout, a revoked or stale session reads nothing, a failed staged registration holds no account or seat and its retry converges", async (t) => {
	const c = caseOf("SEC-03");
	const input = c.given["case-input"] as {
		credential_provider: string;
		session_revoked: boolean;
		pending_registration: boolean;
	};
	const { result } = c.expected;
	assert.deepEqual(
		[input.credential_provider, input.session_revoked, input.pending_registration],
		["BetterAuth", true, true],
	);
	const web = await identity.fixture();
	t.after(() => web.close());
	web.setIp("127.0.8.1");
	const { createAccountCredentials } = await import("../../../../packages/domain/src/settings/index.ts");
	const one = async (query: SQL) => (await web.db.execute(query)).rows[0] as Record<string, unknown>;
	const session = async (cookie: string) => (await web.req("get-session", undefined, cookie)).json();
	const email = "sec03@example.test";
	const login = async (address = email, secret = identity.password) => {
		const response = await identity.signIn(web, address, secret);
		return { status: response.status, cookie: identity.cookie(response), set: response.headers.getSetCookie() };
	};
	const proofs: string[] = [];
	const credentials = createAccountCredentials({
		db: web.runtime,
		authDb: web.authDb,
		admissionDb: web.runtime,
		origin: web.origin,
		secret: web.previewSettings.IDENTITY_SECRET,
		request: async (cx) => {
			const held = cx as unknown as { cookie: string; id: string; address: string };
			return {
				request: new Request(`${web.origin}/api/settings`, {
					method: "POST",
					headers: { origin: web.origin, cookie: held.cookie },
				}),
				trustedIp: "127.0.8.2",
				viewer: { accountId: held.id, email: held.address, verified: true },
			};
		},
		responseCookies: async () => {},
		diagnostic: () => {},
		deliverVerification: async (_tx, i) => void proofs.push(i.token),
		securityNotice: async () => randomUUID(),
	});

	await t.test(
		"a staged registration whose account row cannot be written leaves a resumable credential only, and its retry converges",
		async () => {
			const count = () =>
				one(sql`SELECT (SELECT count(*)::int FROM auth_user) users,(SELECT count(*)::int FROM auth_account) creds,
				(SELECT count(*)::int FROM account) accounts,(SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM audit_event) events`);
			const before = await count();
			await web.db.execute(
				sql`CREATE FUNCTION sec03_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sec03_fault'; END $$`,
			);
			await web.db.execute(
				sql`CREATE TRIGGER sec03_fault BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION sec03_fault()`,
			);
			try {
				const failed = await identity.register(web, "rolled-back@example.test");
				assert.equal(identity.cookie(failed), "");
			} finally {
				await web.db.execute(sql`DROP TRIGGER sec03_fault ON account`);
				await web.db.execute(sql`DROP FUNCTION sec03_fault()`);
			}
			const staged = await count();
			assert.deepEqual(
				[staged.accounts, staged.seats, staged.events, Number(staged.users) - Number(before.users)],
				[before.accounts, before.seats, before.events, 1],
			);
			assert.equal((await identity.register(web, "rolled-back@example.test")).status, 200);
			const resumed = await count();
			assert.deepEqual(
				[Number(resumed.users) - Number(before.users), Number(resumed.creds) - Number(before.creds), resumed.seats],
				[1, 1, before.seats],
				"the retry reuses the staged credential and adds no second owner",
			);
		},
	);

	assert.equal((await identity.register(web, email)).status, 200);
	const first = await login();
	assert.equal(first.status, 200);
	const viewer = await session(first.cookie);
	const who = {
		id: viewer.accountId as string,
		address: email,
		cookie: first.cookie,
		session: viewer.sessionId as string,
		selected: { kind: "account", id: viewer.accountId },
	};

	await t.test("a pending registration is signed in but holds no seat and no authority", async () => {
		assert.equal(viewer.status, "pending_domain");
		const { n } = await one(sql`SELECT count(*)::int n FROM seat WHERE account_id=${who.id} AND ended_at IS NULL`);
		assert.equal(n, result.pending_active_seats);
		assert.equal(
			await RequestActor.resolve(web.runtime, sessionId.parse(who.session)).then(
				(a) => a instanceof RequestActor && a.actor.context.kind === "seat",
			),
			false,
		);
	});

	await t.test(
		"the session cookie is host-only, HttpOnly and Lax, and a forged or re-signed cookie reads nothing",
		async () => {
			const token =
				first.set.find((v) => v.startsWith("better-auth.session_token=")) ?? assert.fail(first.set.join(" | "));
			assert.match(token, /HttpOnly/i);
			assert.match(token, /SameSite=Lax/i);
			assert.match(token, /Path=\//);
			assert.doesNotMatch(token, /Domain=/i);
			const raw = decodeURIComponent(token.split(";")[0]!.split("=").slice(1).join("="));
			const [bare] = raw.split(".");
			for (const forged of [
				"better-auth.session_token=forged.canary",
				`better-auth.session_token=${bare}`,
				`better-auth.session_token=${encodeURIComponent(`${bare}.${"A".repeat(43)}=`)}`,
				`better-auth.session_token=${encodeURIComponent(`${who.session}.${raw.split(".")[1]}`)}`,
			])
				assert.deepEqual(await session(forged), { status: "unauthenticated" }, forged);
		},
	);

	await t.test("renewal extends the same row; logout and a revoked row read nothing", async () => {
		await web.db.execute(sql`UPDATE auth_session SET updated_at=clock_timestamp()-interval '16 days',
			expires_at=clock_timestamp()+interval '14 days' WHERE id=${who.session}`);
		const renewed = await web.req("get-session", undefined, first.cookie);
		assert.equal(renewed.status, 200);
		const { days } = await one(
			sql`SELECT round(extract(epoch FROM expires_at-clock_timestamp())/86400)::int days FROM auth_session WHERE id=${who.session}`,
		);
		assert.equal(days, 30);
		const second = await login();
		assert.equal((await session(second.cookie)).status, "pending_domain");
		await web.db.execute(sql`DELETE FROM auth_session WHERE id=${who.session}`);
		const revoked = await session(first.cookie);
		assert.equal(revoked.status === "pending_domain" || revoked.status === "active", result.session_authenticated);
		for (let n = 0; n < 2; n++)
			assert.deepEqual(await (await web.req("sign-out", {}, second.cookie)).json(), { status: "signed_out" });
		assert.deepEqual(await session(second.cookie), { status: "unauthenticated" });
	});

	await t.test("a reset and an email change move the one credential, and every older session ends", async () => {
		await web.db.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
		await web.db.execute(sql`UPDATE account SET registration_state='active' WHERE id=${who.id}`);
		const before = await login();
		assert.equal((await web.req("request-password-reset", { email })).status, 200);
		await web.dispatch();
		const mail = web.effects.filter((m) => m.to === email && m.text.startsWith("Reset your password")).at(-1);
		const proof =
			new URL(mail?.text.split("\n")[2] ?? assert.fail("no reset mail")).searchParams.get("token") ??
			assert.fail("no token");
		const fresh = "Reset-sec03-pass-2";
		const [stale, reset] = await Promise.all([
			login(email, identity.password),
			web.req("reset-password", { proof, newPassword: fresh, confirmPassword: fresh }),
		]);
		assert.equal(reset.status, 200);
		for (const ended of [before.cookie, stale.cookie].filter(Boolean))
			assert.deepEqual(await session(ended), { status: "unauthenticated" }, "a session from the old password ends");
		assert.equal((await login(email, identity.password)).status, 401);
		const now = await login(email, fresh);
		assert.equal(now.status, 200);
		const current = await session(now.cookie);
		const held = { ...who, cookie: now.cookie, session: current.sessionId };
		assert.equal(
			(await credentials.requestEmailChange(held as never, { newEmail: "sec03-new@example.test" })).status,
			"ok",
		);
		assert.equal((await credentials.confirmEmailChange(held as never, { proof: proofs.at(-1)! })).status, "succeeded");
		assert.equal((await login("sec03-new@example.test", fresh)).status, 200);
		assert.equal((await login(email, fresh)).status, 401);
		const { owners, users } =
			await one(sql`SELECT count(DISTINCT a.user_id)::int owners, count(DISTINCT u.id)::int users
			FROM auth_user u JOIN account x ON x.auth_user_id=u.id LEFT JOIN auth_account a ON a.user_id=u.id AND a.provider_id='credential'
			WHERE x.id=${who.id}`);
		assert.deepEqual([owners, users], [result.auth_credential_owners, 1]);
		const { n } = await one(
			sql`SELECT count(*)::int n FROM auth_account WHERE user_id=(SELECT auth_user_id FROM account WHERE id=${who.id})`,
		);
		assert.equal(n, result.auth_credential_owners);
	});

	await t.test("BetterAuth is the only credential and session store", async () => {
		const stores = await web.db
			.execute(sql`SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema()
			AND (column_name IN ('password','password_hash','session_token') OR (table_name LIKE '%session%' AND column_name='token'))
			GROUP BY table_name ORDER BY table_name`);
		const other = stores.rows
			.map((r) => r.table_name)
			.filter((name) => !["auth_session", "auth_account"].includes(String(name)));
		assert.equal(other.length ? other.join(",") : null, result.parallel_auth_owner);
	});
});
