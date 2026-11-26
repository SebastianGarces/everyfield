import { appCookie, appModule, closeAppPools, element, flight, html, inRequest, useApp } from "./security-web.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	createPrivateCare,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { readIntelligence, requestIntelligenceRefresh } from "../../../../packages/domain/src/oversight/index.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok } from "../../../support/fixture.mts";
import { church, ZONE, type Church, type ChurchPlant } from "../../intelligence/assessment-church.mts";
import { caseOf } from "../sql/core/support.mts";

const NI031 = caseOf("intelligence", "NI-031") as ReturnType<typeof caseOf> & { clock: { now: string } };
const result = NI031.expected.result as { private_fields_in_diagnostics: number; raw_manifest: null };
const args = NI031.action.arguments as { surfaces: string[]; canaries: string[] };
let shift = 0;
const clock = { now: () => new Date(Date.now() + shift).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const care = createPrivateCare();
const CHECK_IN = `ni031-checkin-${randomUUID().slice(0, 8)}`;
const BODY = `ni031-assessment-${randomUUID().slice(0, 8)}`;
const MANIFEST = [424242, 313131] as const;
const canaries = [CHECK_IN, BODY, ...MANIFEST.map(String)];
const drafter = () =>
	scriptedAssessmentDrafter({
		script: (draft) => ({
			...draft,
			summary: `${draft.summary} ${BODY} summary.`,
			focus: { ...draft.focus, body: `${draft.focus.body} ${BODY} body.` },
		}),
	});

type Page = (props: object) => Promise<unknown>;
let c0: Church;
let P: ChurchPlant, Q: ChurchPlant;
let director: { id: string; session: string };
let runId: string;

before(async () => {
	const now = NI031.clock.now;
	shift = Date.parse(now) - Date.now();
	c0 = await church("ni031", { clock: new Date(now) });
	useApp(c0.database.logins.runtime.url.href);
	await c0.release("methodology-2026.11");
	const network = await c0.database.organization("sending_network", { name: "Org-A", timezone: ZONE });
	director = await c0.database.actor(network, "admin");
	P = await c0.plant("P");
	Q = await c0.plant("Q");
	for (const p of [P, Q]) {
		await c0.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
			share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${p.id},${network.id},clock_timestamp()-interval '1 day',true,true,true,true,true,true,true)`);
		ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
		await runAssessmentBatch(job, c0.db, drafter(), 20);
		const current = ok(await assessments.readAssessment(c0.db, p.actor, {})).current!;
		ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: current.runId }));
	}
	const current = ok(await care.readCurrent(c0.db, P.actor, {}));
	ok(
		await care.save(c0.db, P.actor, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: {
				answers: { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" },
				note: CHECK_IN,
			},
		}),
	);
	runId = randomUUID();
	const authority = (await RequestActor.resolve(c0.db, director.session as never)) as RequestActor;
	ok(await requestIntelligenceRefresh(c0.db, authority, { runId }));
	await c0.admin.execute(sql`UPDATE network_intelligence_plant SET growth_days=${MANIFEST[0]},
		days_to_launch=${MANIFEST[1]} WHERE run_id=${runId} AND plant_id=${P.id}`);
});
after(async () => {
	await closeAppPools();
	await c0?.database.close();
});

async function captured<T>(body: () => Promise<T>) {
	const lines: string[] = [];
	const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
	const saved = methods.map((m) => console[m]);
	const out = process.stdout.write.bind(process.stdout);
	const err = process.stderr.write.bind(process.stderr);
	for (const m of methods)
		console[m] = (...xs: unknown[]) =>
			void lines.push(
				xs
					.map((x) =>
						x instanceof Error ? `${x.name} ${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x),
					)
					.join(" "),
			);
	process.stdout.write = ((chunk: unknown) => (lines.push(String(chunk)), true)) as never;
	process.stderr.write = ((chunk: unknown) => (lines.push(String(chunk)), true)) as never;
	try {
		return { value: await body(), lines };
	} finally {
		methods.forEach((m, i) => (console[m] = saved[i]!));
		process.stdout.write = out;
		process.stderr.write = err;
	}
}
type Node = { type: unknown; props: { children?: unknown } & Record<string, unknown> };
function clientsOf(node: unknown): Node[] {
	if (!node || typeof node !== "object") return [];
	if (Array.isArray(node)) return node.flatMap(clientsOf);
	const n = node as Node;
	if ((typeof n.type === "object" || typeof n.type === "function") && n.type !== null && "$$id" in n.type) return [n];
	if (typeof n.type === "function") return clientsOf((n.type as (p: object) => unknown)(n.props));
	return clientsOf(n.props?.children);
}
const hits = (text: string) => canaries.filter((c) => text.includes(c));

test("AC:NI-031 a private check-in, the raw input manifest and an individual assessment body reach no log, error, trace, cache result, HTML, RSC or stream of the Network Intelligence page", async () => {
	assert.deepEqual(args.surfaces, ["log", "error", "trace", "cache key/result", "HTML", "RSC", "stream"]);
	assert.deepEqual(args.canaries, ["private checkin", "raw input manifest", "individual assessment"]);
	const own = JSON.stringify([
		ok(await assessments.readAssessment(c0.db, P.actor, {})),
		ok(await care.readCurrent(c0.db, P.actor, {})),
		await c0.rows(sql`SELECT * FROM network_intelligence_plant WHERE run_id=${runId}`),
	]);
	assert.deepEqual(hits(own), canaries, "every canary is planted where its owner reads it");

	const routes = await appModule<{ IntelligencePage: Page; intelligenceMetadata: Page }>(
		"features/oversight/routes.tsx",
	);
	const cookie = await appCookie(c0.admin, director.session);
	await c0.admin.execute(sql`UPDATE auth_session SET expires_at=pg_catalog.clock_timestamp()+interval '30 days'
		WHERE id=${director.session}`);
	const surfaces: Record<string, string> = {};
	const { lines } = await captured(async () => {
		for (const params of [{}, { level: "region" }, { level: "state" }, { level: "country" }, { run: runId }]) {
			const props = { searchParams: Promise.resolve(params) };
			const key = JSON.stringify(params);
			const tree = await inRequest({ cookie }, () => routes.IntelligencePage(props));
			surfaces[`RSC stream ${key}`] = await inRequest({ cookie }, () =>
				flight(element(routes.IntelligencePage, props)),
			);
			const clients = clientsOf(tree);
			assert.ok(clients.some((n) => String((n.type as { $$id: string }).$$id).endsWith("#IntelligenceBody")));
			surfaces[`HTML ${key}`] = (await Promise.all(clients.map((n) => html(n as never, "/network/intelligence")))).join(
				"\n",
			);
			surfaces[`metadata ${key}`] = JSON.stringify(
				await inRequest({ cookie }, () => routes.intelligenceMetadata(props)),
			);
		}
		surfaces["cached result"] = JSON.stringify(
			await readIntelligence(c0.db, (await RequestActor.resolve(c0.db, director.session as never)) as RequestActor, {
				level: "portfolio",
				runId,
			}),
		);
		await c0.admin.execute(sql`ALTER TABLE network_intelligence_plant RENAME TO network_intelligence_plant_gone`);
		try {
			surfaces["error RSC stream"] = await inRequest({ cookie }, () =>
				flight(element(routes.IntelligencePage, { searchParams: Promise.resolve({}) })),
			);
		} finally {
			await c0.admin.execute(sql`ALTER TABLE network_intelligence_plant_gone RENAME TO network_intelligence_plant`);
		}
	});
	assert.ok(surfaces["HTML {}"]!.includes(">P<"), "the page renders P");
	assert.ok(surfaces["HTML {}"]!.includes(">Q<"), "and Q");
	assert.match(surfaces["error RSC stream"]!, /^[0-9a-f]+:E/m, "the failure reaches the stream as an error row");
	assert.ok(
		lines.some((l) => /read_failed|oversight/.test(l)),
		`the failure is logged: ${lines.join("\n").slice(0, 400)}`,
	);
	surfaces["log, error and trace output"] = lines.join("\n");
	const found = Object.entries(surfaces).flatMap(([name, text]) => hits(text).map((c) => `${name}: ${c}`));
	assert.deepEqual(found, [], "no surface carries a canary");
	assert.equal(found.length, result.private_fields_in_diagnostics);
	assert.equal(result.raw_manifest, null);
	assert.doesNotMatch(surfaces["log, error and trace output"]!, /network_intelligence|SELECT|struggling/);
});
