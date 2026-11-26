import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../packages/db/src/query.ts";
import { readViewer } from "../../../../packages/domain/src/access/session.ts";
import { claimDue, finishClaim } from "../../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import {
	createConversation,
	evryActor,
	readConversation,
	runTurn,
	submitTurn,
	type QualifiedModel,
} from "../../../../packages/evry/src/index.ts";
import type {
	LanguageModelV4,
	LanguageModelV4StreamPart,
} from "../../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import { ok, refusedWith } from "../../../support/fixture.mts";
import {
	CANDIDATE_EMAIL,
	CARE_NOTE,
	CONTACT,
	DRAFT_BODY,
	DRAFT_SUBJECT,
	INTAKE_NOTE,
	KINDS,
	PERSON_NOTE,
	randomIds,
	settled,
	VIEWERS,
	world,
	type Ids,
	type Kind,
	type Viewer,
	type World,
} from "./private-support.mts";

type Item = "care" | "assessment" | "draft" | "contact" | "candidate" | "intake" | "note";
type Seen = Partial<Record<Kind, Record<string, Item[]>>>;

const INSIDE: Seen = {
	direct: {
		"communication.get": ["draft"],
		"communication.getDraft": ["draft"],
		"communication.getDetail": ["draft"],
		"communication.deliveryTotals": ["draft"],
		"communication.recipients": ["draft"],
		"communication.executionResult": ["draft"],
		"communication.forPerson": ["draft"],
		"people.getPerson": ["contact"],
		"people.readPersonPage": ["contact", "note"],
		"people.getActivities": ["note"],
	},
	search: {
		"people.search name": ["contact"],
		"people.search email": ["contact"],
		"people.search phone": ["contact"],
		"people.list email": ["contact"],
		"communication.history": ["draft"],
	},
	export: { "people.export": ["contact"] },
	evry: {
		"people.getPerson personId": ["contact"],
		"communication.list all": ["draft"],
		"communication.list subject": ["draft"],
		"communication.get communicationId": ["draft"],
		"communication.getDraft communicationId": ["draft"],
		"communication.forMeeting all": ["draft"],
		"communication.forMeeting meetingId": ["draft"],
		"communication.deliveryTotals communicationId": ["draft"],
	},
	summary: {
		"people.listPeople": ["contact"],
		"people.pipelineData": ["contact"],
		"communication.listHistory": ["draft"],
		"communication.listDrafts": ["draft"],
		"communication.forMeeting": ["draft"],
	},
};
const ADMIN: Seen = {
	...INSIDE,
	direct: {
		...INSIDE.direct,
		"intelligence.readAssessment": ["assessment"],
		"intelligence.readHistory": ["assessment"],
		"people.readPersonPage": ["contact", "intake", "note"],
		"people.getAssessments": ["intake"],
		"people.getInterviews": ["intake"],
	},
	search: {
		...INSIDE.search,
		"communication.recipients": ["contact"],
		"launch.suggestGuests": ["contact"],
	},
	evry: {
		...INSIDE.evry,
		"communication.resendCandidates communicationId+selection": ["draft"],
		"people.getInterviews personId": ["intake"],
		"people.getAssessments personId": ["intake"],
		"intelligence.readScorecard all": ["assessment"],
		"intelligence.readAssessment all": ["assessment"],
		"intelligence.readAssessmentHistory all": ["assessment"],
		"intelligence.readAssessmentRun runId": ["assessment"],
	},
	summary: { ...INSIDE.summary, "intelligence.trends": ["assessment"] },
};
const AUTHOR: Seen = {
	...ADMIN,
	direct: {
		...ADMIN.direct,
		"care.readCurrent": ["care"],
		"care.readHistory": ["care"],
		"care.readTrends": ["care"],
	},
	summary: { ...ADMIN.summary, "care.trends": ["care"] },
};
const DIRECTOR: Seen = {
	direct: { "pipeline.personRecord": ["candidate"], "pipeline.organizationPerson": ["candidate"] },
	search: { "pipeline.board email": ["candidate"] },
	export: { "pipeline.export": ["candidate"] },
	evry: { "pipeline.listPeople all": ["candidate"] },
	summary: { "pipeline.board": ["candidate"] },
};
const SEEN: Record<Viewer, Seen> = {
	author: AUTHOR,
	admin: ADMIN,
	member: INSIDE,
	lead: INSIDE,
	director: DIRECTOR,
	staff: {},
	foreign: {},
};
const HIDDEN: Record<Viewer, (keyof Ids)[]> = {
	author: ["candidate", "candidateEmail"],
	admin: ["week", "candidate", "candidateEmail"],
	member: ["week", "run", "candidate", "candidateEmail"],
	lead: ["week", "run", "candidate", "candidateEmail"],
	director: ["week", "run", "person", "draft", "email", "phone", "subject", "body"],
	staff: ["week", "run", "person", "draft", "candidate", "candidateEmail", "email", "phone", "subject", "body"],
	foreign: ["week", "run", "person", "draft", "candidate", "candidateEmail", "email", "phone", "subject", "body"],
};

let w: World;
let marks: Record<Item, string[]>;
let citation: string;

before(async () => {
	w = await world("private_items");
	await w.actions.writeCare();
	await w.actions.assess();
	await w.actions.draft();
	await w.actions.contact(CONTACT);
	await w.actions.candidateEmail(CANDIDATE_EMAIL);
	await w.actions.intake();
	await w.actions.note();
	const text = await w.actions.assessmentText();
	citation = text.citation;
	marks = {
		care: [CARE_NOTE, w.ids.week],
		assessment: [w.ids.run, text.summary, text.focus],
		draft: [DRAFT_SUBJECT, DRAFT_BODY, w.ids.draft],
		contact: Object.values(CONTACT),
		candidate: [CANDIDATE_EMAIL, w.ids.candidate, "Casey Candidate"],
		intake: [INTAKE_NOTE],
		note: [PERSON_NOTE],
	};
});
after(() => w?.close());

const ITEMS: readonly Item[] = ["care", "assessment", "draft", "contact", "candidate", "intake", "note"];
const itemsIn = (value: unknown) => {
	const text = JSON.stringify(value ?? null);
	return ITEMS.filter((item) => marks[item].some((mark) => text.includes(mark)));
};

async function shown(v: Viewer) {
	const found: Record<string, unknown> = {};
	for (const kind of KINDS) {
		const read = await w.read(v, kind, w.ids, citation);
		const hits = Object.fromEntries(
			Object.entries(read).flatMap(([route, value]) => {
				const items = itemsIn(value);
				return items.length ? [[route, items]] : [];
			}),
		);
		if (Object.keys(hits).length) found[kind] = hits;
	}
	return found;
}

test("INV-privacy: the routes here ask every People, Messages, Intelligence, Oversight and Pipeline read Evry offers a role, except the import preview of an attached file", () => {
	const carries =
		/^(people|communication|intelligence|oversight|organizationIntelligence|pipeline|dashboard|signals|phases)\./;
	const unasked = (v: Viewer) => w.unasked(v).filter((operation) => carries.test(operation));
	assert.deepEqual(Object.fromEntries(VIEWERS.map((v) => [v, unasked(v)])), {
		author: ["people.previewImport"],
		admin: ["people.previewImport"],
		member: [],
		lead: [],
		director: [],
		staff: [],
		foreign: ["people.previewImport"],
	});
});

for (const v of VIEWERS)
	test(`AC:ROLE43-012 INV-privacy: by link, search, notification, digest, export, summary and Evry the ${v} sees exactly the private items their role may`, async () => {
		assert.deepEqual(await shown(v), SEEN[v]);
	});

test("INV-privacy: every role's notifications, digest and export answer with their own content and none of the private items", async () => {
	for (const v of VIEWERS) {
		const feed = (await w.read(v, "notification"))["notifications.feed"] as {
			value: { unread: number; feed: { items: { title: string }[] } };
		};
		assert.deepEqual([feed.value.unread, feed.value.feed.items.map((i) => i.title)], [1, ["Control notice"]], v);
	}
	const lines = async (v: Viewer, name: string) =>
		((await w.read(v, "digest"))[name] as { lines: string[] }).lines.length;
	assert.deepEqual(
		await Promise.all(
			VIEWERS.map(async (v) => [v, await lines(v, "digest.planter mail"), await lines(v, "digest.oversight mail")]),
		),
		[
			["author", 1, 0],
			["admin", 1, 0],
			["member", 0, 0],
			["lead", 0, 0],
			["director", 0, 1],
			["staff", 0, 0],
			["foreign", 0, 0],
		],
	);
	const matched = async (v: Viewer) =>
		((await w.read(v, "export"))["people.export"] as { value?: { receipt: { matched: number } } }).value?.receipt
			.matched ?? "refused";
	assert.deepEqual(await Promise.all(VIEWERS.map(async (v) => [v, await matched(v)])), [
		["author", 14],
		["admin", 14],
		["member", 14],
		["lead", 14],
		["director", "refused"],
		["staff", "refused"],
		["foreign", 1],
	]);
});

test("INV-privacy: a private record answers a role that may not see it exactly as a record that never existed, on every route", async () => {
	for (const v of VIEWERS) {
		const missing = randomIds();
		const gone = { ...w.ids, ...Object.fromEntries(HIDDEN[v].map((k) => [k, missing[k]])) } as Ids;
		for (const kind of KINDS) {
			const real = settled(await w.read(v, kind, w.ids, citation), w.ids);
			const none = settled(await w.read(v, kind, gone, citation), gone);
			assert.deepEqual(real, none, `${v} ${kind}`);
		}
	}
});

test("INV-privacy: the allowed role's same direct links tell a real record from a missing one", async () => {
	const differs = async (v: Viewer) => {
		const missing = randomIds();
		const real = settled(await w.read(v, "direct", w.ids, citation), w.ids) as Record<string, unknown>;
		const none = settled(settled(await w.read(v, "direct", missing, citation), missing), w.ids) as Record<
			string,
			unknown
		>;
		return Object.keys(real).filter((k) => JSON.stringify(real[k]) !== JSON.stringify(none[k]));
	};
	const people = [
		"communication.get",
		"communication.getDraft",
		"communication.getDetail",
		"communication.deliveryTotals",
		"communication.recipients",
		"communication.executionResult",
		"communication.forPerson",
		"people.getPerson",
		"people.readPersonPage",
		"people.getActivities",
	];
	const records = [
		"people.getAssessments",
		"people.getInterviews",
		"people.getCommitments",
		"people.listRecordCorrections",
	];
	assert.deepEqual(await differs("author"), ["intelligence.resolveCitation", ...people, ...records]);
	assert.deepEqual(await differs("member"), people);
	assert.deepEqual(await differs("director"), ["pipeline.personRecord", "pipeline.organizationPerson"]);
	assert.deepEqual(await differs("staff"), []);
	assert.deepEqual(await differs("foreign"), []);
});

test("INV-privacy: correcting a care note by its id answers another Admin, a Member and another church as a missing note", async () => {
	const bare = refusedWith({ details: {} });
	const attempt = (v: Viewer, weekId: string) =>
		w.care.correct(w.db, w.who[v], {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: {
				weekId,
				answers: { spiritual: "steady", family: "steady", financial: "steady", pace: "steady" },
				note: "",
			},
		});
	for (const [v, code] of [
		["admin", "not_found"],
		["member", "access_denied"],
		["lead", "access_denied"],
		["director", "access_denied"],
		["staff", "access_denied"],
		["foreign", "not_found"],
	] as const) {
		const real = await attempt(v, w.ids.week);
		const none = await attempt(v, randomUUID());
		bare(real, code);
		assert.deepEqual(settled(real), settled(none), v);
	}
	const stale = await attempt("author", w.ids.week);
	bare(stale, "revision_conflict");
	assert.equal(ok(await w.care.readCurrent(w.db, w.who.author, {})).week.answer!.note, CARE_NOTE);
});

type Call = { tool: string; input: { operation: string; input: unknown } };
function probing(calls: Call[], offered: string[], prompts: string[]): QualifiedModel {
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	};
	let asked = false;
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "test",
		modelId: "probing",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text: JSON.stringify({ kind: "application" }) }],
			finishReason: { unified: "stop", raw: undefined },
			usage,
			warnings: [],
		}),
		async doStream(options) {
			const results = JSON.stringify(
				options.prompt.flatMap((m): unknown[] =>
					m.role === "tool"
						? m.content.flatMap((part) => ("output" in part ? [part.output] : []))
						: m.role === "system"
							? [m.content]
							: [],
				),
			);
			prompts.push(JSON.stringify([options.prompt, options.tools]));
			offered.push(...(options.tools ?? []).map((t) => t.name));
			const parts: LanguageModelV4StreamPart[] = asked
				? [
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: results },
						{ type: "text-end", id: "t" },
						{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
					]
				: [
						...calls.map((c) => ({
							type: "tool-call" as const,
							toolCallId: randomUUID(),
							toolName: c.tool,
							input: JSON.stringify(c.input),
						})),
						{ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
					];
			asked = true;
			return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
		},
	};
	return { status: "qualified", id: "probing", model };
}

async function ask(v: Viewer, ids: Ids) {
	const call = (tool: string, operation: string, input: unknown): Call => ({ tool, input: { operation, input } });
	const calls = [
		call("intelligence_read", "privateCare.readCurrent", {}),
		call("intelligence_read", "intelligence.readAssessment", {}),
		call("communication_read", "communication.list", { subject: ids.subject }),
		call("communication_read", "communication.get", { communicationId: ids.draft }),
		call("people_read", "people.getPerson", { personId: ids.person }),
		call("peopleAssessments_read", "people.getInterviews", { personId: ids.person }),
		call("pipeline_read", "pipeline.listPeople", {}),
		call("oversight_read", "oversight.getPlant", { plantId: w.P.id }),
	];
	const offered: string[] = [];
	const prompts: string[] = [];
	const actor = evryActor(w.who[v]);
	const conversationId = (await createConversation(w.db, actor, { requestKey: randomUUID() })).id;
	await submitTurn(w.db, actor, conversationId, {
		requestKey: randomUUID(),
		text: "Show me everything you have",
		references: [],
	});
	const [claim] = await claimDue(w.db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const outcome = await runTurn(
		{
			db: w.db,
			model: probing(calls, offered, prompts),
			freshActor: async (session) => {
				const viewer = await readViewer(w.db, session as never);
				return viewer?.authority ? evryActor(viewer.authority, viewer.discovery) : null;
			},
		},
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(w.db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", v);
	const { events } = await readConversation(w.db, actor, conversationId);
	const results = events
		.flatMap((e) => (e.kind === "tool_result" ? [{ operation: String(e.body.operation), result: e.body.result }] : []))
		.sort((a, b) => a.operation.localeCompare(b.operation));
	const said = events.flatMap((e) => (e.kind === "assistant_text" ? [e.body.text] : []));
	assert.ok(said.length > 0 && offered.length > 0, v);
	return {
		items: itemsIn([results, said]),
		reads: results.map((r) => r.operation),
		results,
		prompts: prompts.join("\n"),
	};
}

test("AC:ROLE43-012 INV-privacy: asked through Evry with the model naming every private read, each role gets only what it may see and the answer is the same as for records that never existed", async () => {
	const draft = ["communication.list", "communication.get", "people.getPerson"];
	const asked: [Viewer, Item[], string[]][] = [
		[
			"author",
			["assessment", "draft", "contact", "intake"],
			["intelligence.readAssessment", ...draft, "people.getInterviews"],
		],
		[
			"admin",
			["assessment", "draft", "contact", "intake"],
			["intelligence.readAssessment", ...draft, "people.getInterviews"],
		],
		["member", ["draft", "contact"], draft],
		["lead", ["draft", "contact"], draft],
		["director", ["candidate"], ["pipeline.listPeople", "oversight.getPlant"]],
		["staff", [], ["oversight.getPlant", "pipeline.listPeople"]],
		["foreign", [], ["intelligence.readAssessment", ...draft, "people.getInterviews"]],
	];
	for (const [v, items, reads] of asked) {
		const real = await ask(v, w.ids);
		assert.deepEqual([real.items, real.reads], [items, reads.toSorted()], v);
	}
	for (const v of ["director", "staff", "foreign"] as const) {
		const missing = randomIds();
		const gone = { ...w.ids, ...Object.fromEntries(HIDDEN[v].map((k) => [k, missing[k]])) } as Ids;
		const real = await ask(v, w.ids);
		const none = await ask(v, gone);
		assert.deepEqual(settled(real.results, w.ids), settled(none.results, gone), v);
	}
});

test("INV-privacy: once the planter opens the assessment the sending church sees it by the routes that hid it, and no other disallowed role does", async () => {
	const kinds = ["direct", "evry", "summary"] as const;
	const before = new Map<Viewer, Record<string, unknown>>();
	for (const v of ["director", "staff"] as const) {
		for (const kind of kinds) assert.ok(!itemsIn(await w.read(v, kind)).includes("assessment"), v);
		before.set(v, await w.surface(v, kinds));
	}
	await w.actions.release();
	for (const v of ["director", "staff"] as const) {
		const now = await w.surface(v, kinds);
		assert.deepEqual(
			Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(before.get(v)![k])),
			[
				"direct: oversight.getPlant",
				"evry: oversight.listPlants all",
				"evry: oversight.getPlant plantId",
				"summary: oversight.listPlants",
				"summary: oversight.getPlant",
			],
			v,
		);
		assert.ok(itemsIn(await w.read(v, "direct")).includes("assessment"), v);
	}
	for (const v of ["member", "lead", "foreign"] as const) assert.deepEqual(await shown(v), SEEN[v], v);
});

test("AC:ROLE43-012 a check-in, its correction, week and hard answers reach no Evry prompt, model input, log, message, organization page or stored record outside the private tables", async () => {
	const logged: string[] = [];
	const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	for (const k of ["log", "error", "warn", "info"] as const)
		console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
	let asked;
	try {
		const fixed = await w.actions.correctCare("struggling", `${CARE_NOTE} corrected`);
		assert.deepEqual(
			fixed.week.revisions.map((r) => r.kind),
			["save", "correction"],
		);
		w.modelCalls.splice(0);
		await w.actions.assess();
		asked = await ask("author", w.ids);
		ok(await w.care.readHistory(w.db, w.who.author, { page: 1 }));
	} finally {
		Object.assign(console, original);
	}
	const leaks = (text: string) =>
		[CARE_NOTE, w.ids.week, "struggling", "private_week", "privateCare.readCurrent"].filter((mark) =>
			text.includes(mark),
		);
	assert.ok(w.modelCalls.length > 0);
	assert.ok(asked.prompts.length > 0);
	assert.deepEqual(
		{
			model: leaks(JSON.stringify(w.modelCalls)),
			prompt: leaks(asked.prompts).filter((mark) => mark !== "privateCare.readCurrent"),
			answers: leaks(JSON.stringify(asked.results)),
			log: leaks(logged.join("\n")),
		},
		{ model: [], prompt: [], answers: [], log: [] },
	);
	const tables = (
		await w.admin.execute<{ name: string }>(sql`SELECT table_name AS name FROM information_schema.tables
			WHERE table_schema=${w.schema} AND table_type='BASE TABLE' AND table_name NOT LIKE 'private\\_%' ORDER BY table_name`)
	).rows.map((r) => r.name);
	for (const surface of ["mail", "notice", "assessment_run", "audit_event", "network_intelligence_run"])
		assert.ok(tables.includes(surface), surface);
	assert.ok(tables.length > 50);
	const found: string[] = [];
	for (const table of tables) {
		const hit = await w.admin.execute<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} x WHERE x::text LIKE ${`%${CARE_NOTE}%`} OR x::text LIKE ${`%${w.ids.week}%`}`,
		);
		if (hit.rows[0]!.n) found.push(table);
	}
	assert.deepEqual(found, []);
	for (const v of ["admin", "member", "lead", "director", "staff", "foreign"] as const)
		for (const kind of KINDS) assert.ok(!itemsIn(await w.read(v, kind)).includes("care"), `${v} ${kind}`);
	for (const kind of ["search", "notification", "digest", "export", "evry"] as const)
		assert.ok(!itemsIn(await w.read("author", kind)).includes("care"), `author ${kind}`);
});
