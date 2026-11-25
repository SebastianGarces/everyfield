import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import type { PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import { readViewer, RequestActor } from "../../../packages/domain/src/access/session.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim, type Claim } from "../../../packages/domain/src/jobs/queue.ts";
import {
	approveProposal,
	cancelProposal,
	cancelTurn,
	createConversation,
	evryActor,
	executeProposal,
	LIMITS,
	observeConversation,
	readConversation,
	readReview,
	READ_DOMAINS,
	retryTurn,
	retryUnresolvedEffects,
	runTurn,
	stageAttachment,
	submitTurn,
	type EvryActor,
	type MailPort,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { scriptedModel } from "../../../packages/evry-scripted/src/index.ts";
import type { Reference } from "../../../packages/evry/src/conversations/store.ts";
import { bucket } from "./bucket.mts";
import { fixture, type Actor, type Workspace } from "../../support/fixture.mts";
import { recorded, touched, untouched } from "../../support/recorded.mts";
import { pinSchemaClock } from "../../support/test-database.mts";

export { sql };
export const NOW = "2026-10-13T16:00:00Z";
type Usage = { input: number; output: number };
const usageOf = ({ input, output }: Usage) => ({
	inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: output, text: output, reasoning: 0 },
});
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const OFFERED = /"const":"([a-zA-Z]+\.[A-Za-z.]+)"/g;

export type Reply = ReturnType<typeof JSON.parse>;
export type Call = { tool: string; input: unknown };
type Next = Call | Call[] | string;
export type Step = (replies: Reply[]) => Next | Promise<Next>;
export type Play = readonly Step[];
type Row = Record<string, unknown>;

const domains = new Map(
	Object.entries(READ_DOMAINS).flatMap(([domain, adapters]) => adapters.map((a) => [a.operation as string, domain])),
);
export function read(operation: string, input: unknown = {}): Call {
	const domain = domains.get(operation);
	assert.ok(domain, `${operation} is a read`);
	return { tool: `${domain}_read`, input: { operation, input } };
}
export const propose = (operation: string, input: unknown): Call => ({
	tool: "propose_change",
	input: { operation, input },
});
export const reads =
	(operation: string, input: unknown = {}): Step =>
	() =>
		read(operation, input);
export const proposes =
	(operation: string, input: unknown): Step =>
	() =>
		propose(operation, input);
export const refusal = (attempt: Promise<unknown>) =>
	attempt.then(
		() => "answered",
		(e: { code?: string }) => e.code,
	);
export const rowsOf = (reply: Reply, kind?: string): Reply[] =>
	(reply?.rows ?? []).filter((r: Row) => !kind || r.kind === kind);

const refuse = async (): Promise<never> => {
	throw Error("a turn never calls the email service");
};
const MAIL: MailPort = {
	keys: {
		encryptionKey: Buffer.alloc(32, 7),
		addressKey: Buffer.alloc(32, 9),
		from: "church@example.test",
		origin: "https://app.example.test",
	},
	transport: { paused: false, send: refuse, cancel: refuse, reschedule: refuse },
};

export type Turn = {
	conversation: string;
	outcome: string | null;
	replies: Reply[];
	offered: string[];
	tools: string[];
	prompts: string[];
	cards: { operation: string; input: unknown; result: Reply; originalTotal?: number | null }[];
	text: string;
	status: Reply;
	proposals: Proposal[];
	saved: string;
};

function playing(
	play: Play,
	hooks: { during?: () => Promise<void>; map: (text: string) => string; goOn: boolean; usage: Usage },
) {
	const prompts: string[] = [];
	const offered = new Set<string>();
	const tools = new Set<string>();
	let replies: Reply[] = [];
	let first = true;
	const failed: unknown[] = [];
	const base = scriptedModel();
	const outputsOf = (options: LanguageModelV4CallOptions) => {
		const start = options.prompt.findLastIndex((m) => m.role === "user");
		return options.prompt.slice(start + 1).flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) => {
						if (p.type !== "tool-result") return [];
						if (p.output.type === "json") return [p.output.value as Reply];
						return [{ error: "not_offered", said: JSON.stringify(p.output) }];
					})
				: [],
		);
	};
	const answer = async (): Promise<Call[] | string> => {
		const last = replies.at(-1);
		if (last?.error && !hooks.goOn) return `I could not finish that (${String(last.error)}).`;
		const step = play[calls];
		if (!step) return "Done.";
		try {
			const next = await step(replies);
			return typeof next === "string" ? next : Array.isArray(next) ? next : [next];
		} catch (error) {
			if (!(error instanceof TypeError)) failed.push(error);
			return "I found nothing to go on.";
		}
	};
	let calls = 0;
	const model: LanguageModelV4 = {
		...base,
		async doGenerate(options) {
			prompts.push(JSON.stringify(options.prompt));
			return base.doGenerate(options);
		},
		async doStream(options) {
			prompts.push(JSON.stringify(options.prompt));
			for (const t of options.tools ?? []) tools.add(t.name);
			for (const m of JSON.stringify(options.tools ?? []).matchAll(OFFERED)) offered.add(m[1]!);
			if (first) await hooks.during?.();
			first = false;
			replies = outputsOf(options);
			const next = await answer();
			calls++;
			const parts: LanguageModelV4StreamPart[] =
				typeof next === "string"
					? [
							{ type: "text-start", id: "t" },
							{ type: "text-delta", id: "t", delta: next },
							{ type: "text-end", id: "t" },
						]
					: next.map((c) => ({
							type: "tool-call" as const,
							toolCallId: randomUUID(),
							toolName: c.tool,
							input: hooks.map(JSON.stringify(c.input)),
						}));
			return {
				stream: new ReadableStream({
					start(c) {
						for (const p of parts) c.enqueue(p);
						c.enqueue({
							type: "finish",
							finishReason: { unified: typeof next === "string" ? "stop" : "tool-calls", raw: undefined },
							usage: usageOf(hooks.usage),
						});
						c.close();
					},
				}),
			};
		},
	};
	return { model, prompts, offered, tools, failed, replies: () => replies };
}

export async function caseWorld(
	prefix: string,
	{
		native: ports = null,
		now = NOW,
		on,
	}: { native?: NativePorts | null; now?: string; on?: Awaited<ReturnType<typeof fixture>> } = {},
) {
	const database = on ?? (await fixture({ prefix, max: 8, clock: new Date(now) }));
	mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
	const { admin } = database;
	const db = on ? on.connect("runtime") : database.pools.runtime;
	const files = bucket();
	const gone = new Set<string>();
	const cut = { left: 0 };
	db.$client.on("connect", (client) => {
		const query = client.query;
		let reading = false;
		client.query = function (this: typeof client, ...args: unknown[]) {
			const [first] = args;
			const text = typeof first === "string" ? first : (first as { text: string }).text;
			if (text.startsWith(`SET LOCAL statement_timeout = ${LIMITS.readTimeoutMs}`)) reading = true;
			else if (/^(begin|commit|rollback)/i.test(text)) reading = false;
			if (reading && cut.left > 0 && !text.startsWith("SET LOCAL")) {
				cut.left--;
				return Promise.reject(Object.assign(new Error("connection cut"), { code: "57P01" }));
			}
			if (reading && gone.size) {
				const away = text.replace(
					new RegExp(`\\b(from|join)(\\s+)"?(${[...gone].join("|")})"?(?![\\w"])`, "gi"),
					"$1$2$3_away",
				);
				args[0] = typeof first === "string" ? away : { ...(first as object), text: away };
			}
			return Reflect.apply(query, this, args);
		} as typeof client.query;
	});
	const rows = async <R extends Row = Row>(q: SQL) => (await admin.execute<R>(q)).rows;
	const one = async <R extends Row = Row>(q: SQL) => {
		const [row] = await rows<R>(q);
		assert.ok(row, "one row");
		return row;
	};
	const count = async (q: SQL) => Number((await one<{ n: number }>(q)).n);

	const freshActor = async (session: string) => {
		const viewer = await readViewer(db, session as never);
		return viewer?.authority ? evryActor(viewer.authority) : null;
	};
	const actorOf = async (a: Actor) => {
		const actor = await freshActor(a.session);
		assert.ok(actor, "a live session");
		return actor;
	};
	const authorityOf = async (a: Actor) => {
		const authority = await RequestActor.resolve(db, a.session);
		assert.ok(authority instanceof RequestActor);
		return authority;
	};
	const finish = (claim: Claim, outcome: string) =>
		transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	const lease = (claim: Claim) => ({
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	});
	async function eventsOf(who: EvryActor, id: string) {
		let page = await readConversation(db, who, id);
		const events = [...page.events];
		const reviews = { ...page.reviews };
		while (page.more) {
			page = await readConversation(db, who, id, events.at(-1)!.sequence);
			events.push(...page.events);
			Object.assign(reviews, page.reviews);
		}
		return { events, reviews };
	}
	const converse = async (who: EvryActor) => (await createConversation(db, who, { requestKey: randomUUID() })).id;
	type Options = {
		conversation?: string;
		references?: Reference[];
		attachments?: { id: string; name: string }[];
		storage?: PrivateStorage | null;
		during?: () => Promise<void>;
		map?: (text: string) => string;
		requestKey?: string;
		model?: LanguageModelV4;
		at?: Date;
		onError?: "stop" | "go_on";
		usage?: Usage;
	};
	async function work(
		play: Play,
		{
			storage = null,
			during,
			map = (t) => t,
			model,
			at,
			onError,
			usage = { input: 10, output: 5 },
		}: Pick<Options, "storage" | "during" | "map" | "model" | "at" | "onError" | "usage"> = {},
	) {
		const played = playing(play, { ...(during && { during }), map, goOn: onError === "go_on", usage });
		const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
		if (!claim) return { played, outcome: null };
		const outcome = await runTurn(
			{
				db,
				model: { status: "qualified", id: "case", model: model ?? played.model },
				freshActor,
				native: ports,
				mail: MAIL,
				storage,
				...(at && { now: () => at }),
			},
			lease(claim),
			{ claimStart: new Date(), claimEnd: new Date() },
		);
		if (outcome !== "lost") await finish(claim, outcome);
		return { played, outcome };
	}
	async function ask(a: Actor, text: string, play: Play, options: Options = {}): Promise<Turn> {
		const who = await actorOf(a);
		const conversation = options.conversation ?? (await converse(who));
		await submitTurn(db, who, conversation, {
			requestKey: options.requestKey ?? randomUUID(),
			text,
			references: options.references ?? [],
			...(options.attachments && { attachments: options.attachments }),
		});
		const { played, outcome } = await work(play, options);
		if (played.failed.length) throw played.failed[0];
		const { events, reviews } = await eventsOf(who, conversation);
		const turn = events.slice(events.findLastIndex((e) => e.kind === "user_message"));
		const cards = turn.filter((e) => e.kind === "tool_result").map((e) => e.body as Turn["cards"][number]);
		return {
			conversation,
			outcome,
			replies: played.replies(),
			offered: [...played.offered].sort(),
			tools: [...played.tools].sort(),
			prompts: played.prompts,
			cards: cards.filter((c) => c.operation !== "evry.prepareProposal"),
			text: turn
				.filter((e) => e.kind === "assistant_text")
				.map((e) => e.body.text)
				.join(""),
			status: turn.findLast((e) => e.kind === "status")?.body,
			proposals: cards.flatMap((c) => {
				const p = c.result?.proposalId ? reviews[c.result.proposalId] : undefined;
				return p ? [p] : [];
			}),
			saved: JSON.stringify(turn),
		};
	}
	async function effect(mail: MailPort | null = null) {
		const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
		if (!claim) return null;
		const outcome = await executeProposal(
			db,
			{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
			{ reminders: async () => undefined as never, phaseNotices: async () => undefined },
			mail,
			ports,
		);
		if (outcome !== "lost") await finish(claim, outcome);
		return outcome;
	}
	const witness = (p: Proposal) => ({ revision: p.revision, digest: p.digest });
	async function approve(a: Actor, p: Proposal, mail: MailPort | null = null) {
		const who = await actorOf(a);
		await approveProposal(db, who, p.id, witness(p), null);
		const outcome = await effect(mail);
		return { outcome, review: await readReview(db, who, p.id) };
	}

	const OWN = new Set(["audit_event", "conversation", "conversation_event", "job", "record"]);
	async function quiet<T>(body: () => Promise<T>, changes: string[] = []) {
		const kinds = () =>
			rows(
				sql`SELECT kind,count(*)::int AS n FROM record WHERE kind NOT IN ('audit_event','conversation','job') GROUP BY kind ORDER BY kind`,
			);
		const records = await kinds();
		const { value, tables } = await touched(admin, () => recorded(admin, body));
		assert.deepEqual(await kinds(), records, "no new record but the conversation");
		assert.deepEqual(
			tables.filter((t) => !OWN.has(t)),
			changes,
			"no domain write",
		);
		assert.deepEqual(
			value.added.audits.filter((a) => !a.startsWith("evry.")),
			[],
			"no domain audit",
		);
		assert.deepEqual(
			value.added.jobs.filter((j) => !j.startsWith("assistant_turn")),
			[],
			"no effect job",
		);
		assert.deepEqual([value.added.notices, value.added.mail], [0, 0], "no provider effect");
		return value.value;
	}

	async function church(fields: Row = {}, at: { plant?: Workspace & { kind: "plant" }; admin?: Actor } = {}) {
		const P = at.plant ?? (await database.plant(fields));
		const Q = await database.plant({ timezone: "America/New_York" });
		const A = at.admin ?? (await database.actor(P, "admin", { user: { name: "Alex Admin" } }));
		const F = await database.actor(Q, "member", { user: { name: "Foreign Member" } });
		let position = 0;
		async function person(name: string, extra: Row & { plant?: string } = {}) {
			const id = randomUUID();
			const plant = extra.plant ?? P.id;
			await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,city,email,source,stage,adult_classification,
				commitment_state,pipeline_position,state,created_at) VALUES(${id},${plant},${plant},${name},
				${extra.city ?? null},${extra.email ?? null},'other',${extra.stage ?? "prospect"},'adult','unknown',${position++},'live',
				clock_timestamp())`);
			return id;
		}
		const rivera = await person("Alex Rivera", { city: "Chicago" });
		const chen = await person("Alex Chen", { city: "Evanston" });
		const casey = await person("Casey Reed", { stage: "leader" });
		const Aa = await actorOf(A);
		const C = await converse(Aa);
		const earlier = await ask(
			A,
			"Change Casey's phone",
			[proposes("people.updatePerson", { personId: casey, patch: { phone: "555-0199" } })],
			{ conversation: C },
		);
		assert.equal((await approve(A, earlier.proposals[0]!)).review.outcome, "completed");
		const kept = await eventsOf(Aa, C);

		const held = async () => {
			const { events, reviews } = await eventsOf(Aa, C);
			return { events, reviews: Object.values(reviews).map((r) => r && { ...r, now: null }) };
		};
		async function attach(a: Actor, conversation: string, name: string, text: string | Buffer) {
			const bytes = Buffer.from(text);
			const who = await actorOf(a);
			const staged = await stageAttachment(db, files.storage, who, conversation, { name, byteLength: bytes.length });
			const key = decodeURIComponent(new URL(staged.upload.url).pathname).replace("/synthetic-only/", "");
			files.objects.set(key, bytes);
			return { ...staged.attachment, key };
		}
		async function foreignReview(p: Proposal) {
			const stranger = await actorOf(F);
			for (const [id, wit] of [
				[p.id, witness(p)],
				[randomUUID(), witness(p)],
			] as const)
				assert.deepEqual(
					await untouched(admin, async () => [
						await refusal(readReview(db, stranger, id)),
						await refusal(approveProposal(db, stranger, id, wit, null)),
						await refusal(cancelProposal(db, stranger, id)),
						await refusal(retryUnresolvedEffects(db, stranger, id)),
					]),
					["not_found", "not_found", "not_found", "not_found"],
					"a real review answers as a made-up one",
				);
			assert.equal(await effect(), null);
		}
		async function effectOutage(p: Proposal, table: string, mail: MailPort | null = null) {
			const kept = await rows(sql`SELECT * FROM proposal WHERE tenant_id=${P.id} AND outcome='completed' ORDER BY id`);
			const before = await touched(admin, async () => {
				await approveProposal(db, Aa, p.id, witness(p), null);
				await admin.execute(sql.raw(`ALTER TABLE ${table} RENAME TO ${table}_away`));
				try {
					assert.equal(await effect(mail), "failed");
				} finally {
					await admin.execute(sql.raw(`ALTER TABLE ${table}_away RENAME TO ${table}`));
				}
			});
			assert.deepEqual(
				before.tables.filter((t) => !OWN.has(t) && t !== "proposal"),
				[],
				"no domain write or send",
			);
			const after = await readReview(db, Aa, p.id);
			assert.deepEqual(
				[after.outcome, after.executing, after.receipt],
				["unknown", false, null],
				"the outcome is told as not known",
			);
			assert.deepEqual(
				await rows(sql`SELECT * FROM proposal WHERE tenant_id=${P.id} AND outcome='completed' ORDER BY id`),
				kept,
			);
			return after;
		}
		async function modelOutage(a: Actor, text: string) {
			const before = await held();
			const down = async (): Promise<never> => {
				throw Error("provider down");
			};
			const asked = await quiet(() =>
				ask(a, text, [], { model: { ...scriptedModel(), doGenerate: down, doStream: down } }),
			);
			assert.deepEqual(
				[asked.outcome, asked.status.state, asked.status.error.code, asked.status.error.retry],
				["failed", "failed", "model_unavailable", "new_turn"],
			);
			assert.deepEqual([asked.text, asked.cards, asked.proposals], ["", [], []], "nothing is claimed");
			assert.deepEqual(await held(), before, "earlier committed outcomes are kept");
		}
		async function foreign(
			text: string,
			play: Play,
			{
				secrets = [],
				found = [],
				shared = [],
				on = {},
			}: {
				secrets?: string[];
				found?: string[];
				shared?: string[];
				on?: Pick<Options, "storage" | "references" | "attachments">;
			} = {},
		) {
			const stranger = await actorOf(F);
			const before = await held();
			await untouched(admin, async () => {
				for (const attempt of [
					() => readConversation(db, stranger, C),
					() => submitTurn(db, stranger, C, { requestKey: randomUUID(), text }),
					() => retryTurn(db, stranger, C, { requestKey: randomUUID() }),
					() => cancelTurn(db, stranger, C),
					async () => {
						for await (const _ of observeConversation(db, stranger, C, 0, AbortSignal.timeout(500))) void _;
					},
					...before.reviews.map((r) => () => readReview(db, stranger, r!.id)),
				])
					assert.equal(await refusal(attempt()), "not_found");
			});
			const own = new Set([F.id, Q.id, ...shared]);
			const guesses = new Map<string, string>();
			const guess = (t: string) =>
				t.replace(UUID, (id) => {
					if (own.has(id)) return id;
					if (!guesses.has(id)) guesses.set(id, randomUUID());
					return guesses.get(id)!;
				});
			const asked = await quiet(() => ask(F, text, play, on));
			const guessed = await ask(F, guess(text), play, { map: guess });
			const back = new Map([...guesses].map(([id, g]) => [g, id]));
			const plain = (t: Turn) =>
				JSON.stringify(t.replies)
					.replace(UUID, (id) => back.get(id) ?? id)
					.replaceAll(/"resultId":\d+/g, "");
			assert.equal(plain(asked), plain(guessed), "a real id answers exactly as a made-up one");
			assert.deepEqual(asked.proposals, [], "no review is prepared");
			assert.deepEqual(
				asked.cards.flatMap((card) => rowsOf(card.result).map((r) => r.label)).sort(),
				[...found].sort(),
				"only the caller's own rows",
			);
			const told = JSON.stringify([asked.replies, asked.saved, asked.prompts]);
			for (const secret of ["Casey Reed", "Evanston", "555-0199", ...secrets])
				assert.equal(told.includes(secret), false, `no ${secret}`);
			assert.deepEqual(await held(), before, "the conversation is unchanged");
			return asked;
		}
		async function outage(
			text: string,
			play: Play,
			source: string | string[],
			{ told, as = A, ...on }: Options & { told?: (reply: Reply) => unknown; as?: Actor } = {},
		) {
			const own = as === A ? C : await converse(await actorOf(as));
			const reviews = await rows(sql`SELECT * FROM proposal WHERE tenant_id=${P.id} ORDER BY id`);
			const before = await held();
			const asked = await quiet(async () => {
				try {
					return await ask(as, text, play, {
						...on,
						conversation: on.conversation ?? own,
						during: async () => {
							for (const table of [source].flat()) gone.add(table);
						},
					});
				} finally {
					gone.clear();
				}
			});
			const last = asked.replies.at(-1);
			if (told) assert.ok(told(last), JSON.stringify(last));
			else assert.equal(last?.error, "source_unavailable", JSON.stringify(asked.replies));
			assert.deepEqual(asked.proposals, [], "no review is prepared");
			assert.equal(asked.status.state, "completed");
			assert.deepEqual(await rows(sql`SELECT * FROM proposal WHERE tenant_id=${P.id} ORDER BY id`), reviews);
			const after = await held();
			assert.deepEqual(after.events.slice(0, before.events.length), before.events, "earlier turns are kept");
			assert.deepEqual(after.reviews, before.reviews, "earlier committed outcomes are kept");
			assert.equal((await one(sql`SELECT phone FROM person WHERE id=${casey}`)).phone, "555-0199");
			return asked;
		}
		return {
			P,
			Q,
			A,
			F,
			Aa,
			C,
			kept,
			attach,
			rivera,
			chen,
			casey,
			person,
			foreign,
			outage,
			modelOutage,
			foreignReview,
			effectOutage,
		};
	}
	async function at(instant: string) {
		await pinSchemaClock(admin, database.schema, new Date(instant));
		mock.timers.setTime(Date.parse(instant));
	}
	return {
		...database,
		db,
		admin,
		ports,
		files,
		cut,
		rows,
		one,
		count,
		actorOf,
		authorityOf,
		eventsOf,
		converse,
		work,
		ask,
		effect,
		approve,
		witness,
		quiet,
		church,
		at,
		seated: (workspace: Workspace, role: "owner" | "admin" | "member", overrides = {}) =>
			database.actor(workspace, role, overrides),
		async close() {
			mock.timers.reset();
			await database.close();
		},
	};
}
export type CaseWorld = Awaited<ReturnType<typeof caseWorld>>;
export type Church = Awaited<ReturnType<CaseWorld["church"]>>;
