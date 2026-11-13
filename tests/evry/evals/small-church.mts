// A small church for the household and follow-up evals, seeded as real records into an isolated, migrated schema on
// Postgres (tests/support/test-database.mts), as golden-church.mts seeds Hope Fellowship. Each suite names its own
// people, households and plant actors; every read the model calls then runs the real adapter against these rows.
// Every id the model can see is pinned by the suite, so a replay sends exactly the recorded provider calls.
//
// Derived facts come from their source rows, never from a stored label (the technique golden-church.mts documents).
// Inactivity is the real board's comparison of each person's latest activity with the church's 7 and 14 inactivity
// days, against the database clock. So that it reads the same on every day the suite runs, a person at level none or
// warning has a last contact (a follow-up outcome) 2 or 10 days before the seed runs; an alert-level person has no
// contact and was created months ago. Coverage is whether a person has an open task.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { stepCountIs, streamText } from "../../../packages/evry/node_modules/ai/dist/index.js";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { evryActor, type EvryActor } from "../../../packages/evry/src/context/actor.ts";
import { resolveSelf } from "../../../packages/evry/src/context/self.ts";
import { EvryRefusal } from "../../../packages/evry/src/context/errors.ts";
import { READ_DOMAINS, readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { compileContext } from "../../../packages/evry/src/context/compile.ts";
import { LIMITS } from "../../../packages/evry/src/context/limits.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter, SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import { readTools, resultForModel, type ToolHandlers } from "../../../packages/evry/src/runtime/tools.ts";
import { testDatabase, type Database } from "../../support/test-database.mts";
import { RECORDED, type ToolCall } from "./golden-harness.mts";

/** A pinned id in the eval namespace, as golden-church.mts writes them. */
export const id = (n: number) => `5b6d1f0e-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const PLANT = id(1);

type Stage = "prospect" | "attendee" | "following_up" | "interviewed" | "core_group" | "launch_team" | "leader";
export type SmallPerson = {
	id: string;
	name: string;
	city: string;
	stage: Stage;
	household?: { id: string; role: "head" | "spouse" | "child" | "other" };
	/** The inactivity level the seeded activity produces on the real pipeline board. */
	inactivity?: "none" | "warning" | "alert";
	/** One open, unassigned task about this person: the board shows them covered. */
	covered?: boolean;
	/** The plant actor whose account this person row is linked to: that actor's own row. */
	linkedTo?: string;
};
export type SmallChurchSpec<A extends string> = {
	name: string;
	timezone: string;
	households?: { id: string; name: string; city: string; state: string }[];
	people: SmallPerson[];
	/** Each plant actor's seat role. Account, user and session ids are pinned from the actor's position. */
	actors: Record<A, "owner" | "admin">;
};
export type SmallChurch<A extends string> = { db: Database; actors: Record<A, EvryActor>; close(): Promise<void> };

/** A fresh schema with the church seeded, the runtime pool the reads use and each actor as the turn builds it. */
export async function smallChurch<A extends string>(spec: SmallChurchSpec<A>): Promise<SmallChurch<A>> {
	const database = await testDatabase({ prefix: "evrysmall" });
	try {
		const run = (q: ReturnType<typeof sql>) => database.admin.execute(q);
		await run(sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
			VALUES(${PLANT},${spec.name},${spec.timezone},7,14,1,8,1,1)`);
		const names = Object.keys(spec.actors) as A[];
		const accounts = new Map<string, { account: string; session: string }>();
		for (const [k, who] of names.entries()) {
			const a = { account: id(0xf01 + k), user: id(0xf11 + k), session: id(0xf21 + k) };
			accounts.set(who, a);
			await run(
				sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${`${who}@example.test`},true,'Synthetic')`,
			);
			await run(sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind)
				VALUES(${a.account},${a.user},'active','planter')`);
			await run(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
				VALUES(${a.session},${a.user},${`small-${who}`},clock_timestamp()+interval '1 day')`);
			// Accepted by the database clock, so a host clock ahead of it never makes the seat look unaccepted.
			await run(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at)
				VALUES(${a.account},${PLANT},${spec.actors[who]},clock_timestamp()-interval '1 day')`);
		}
		for (const h of spec.households ?? [])
			await run(
				sql`INSERT INTO household(id,plant_id,name,city,state_province) VALUES(${h.id},${PLANT},${h.name},${h.city},${h.state})`,
			);
		const owner = accounts.get(names.find((who) => spec.actors[who] === "owner")!)!.account;
		let task = 0x8000;
		for (const [i, p] of spec.people.entries()) {
			const linked = p.linkedTo ? accounts.get(p.linkedTo)!.account : null;
			await run(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,city,source,created_at,stage,
					adult_classification,commitment_state,pipeline_position,state,household_id,household_role,linked_account_id)
				VALUES(${p.id},${PLANT},${PLANT},${p.name},${p.city},'other',${new Date(Date.UTC(2026, 3, 1 + i)).toISOString()},
					${p.stage},'unknown','unknown',${i + 1},'live',${p.household?.id ?? null},${p.household?.role ?? null},${linked})`);
			if (p.covered)
				await run(sql`INSERT INTO task(id,plant_id,title,category,priority,status,creator_id,created_at,due_kind,person_id)
					VALUES(${id(++task)},${PLANT},${`Follow up with ${p.name}`},'follow_up','medium','not_started',${owner},'2026-10-20T15:00:00.000Z','undated',${p.id})`);
			if ((p.inactivity ?? "none") !== "alert")
				await run(sql`INSERT INTO contact_outcome(plant_id,person_id,outcome,occurred_at,recorded_at,contact_channel)
					SELECT ${PLANT},${p.id},'contacted',t,t,'phone'
					FROM (SELECT clock_timestamp()-make_interval(days=>${p.inactivity === "warning" ? 10 : 2}) AS t) x`);
		}
		const db = database.pools.runtime;
		const actors = {} as Record<A, EvryActor>;
		for (const who of names) {
			const viewer = await readViewer(db, accounts.get(who)!.session as never);
			if (!viewer?.authority) throw Error(`No live authority for the ${who} actor`);
			const actor = evryActor(viewer.authority);
			actors[who] = { ...actor, selfPersonId: await resolveSelf(db, actor) };
		}
		return { db, actors, close: database.close };
	} catch (error) {
		await database.close();
		throw error;
	}
}

const ADAPTERS = new Map<string, ReadAdapter<unknown>>(
	Object.values(READ_DOMAINS)
		.flat()
		.map((a) => [a.operation, a as ReadAdapter<unknown>]),
);
/** One real read by operation name, as a test reads the seed back. */
export const readAs = (db: Database, actor: EvryActor, operation: string, input: unknown): Promise<SourceResult> =>
	invokeRead(db, actor, ADAPTERS.get(operation)!, input);

/**
 * The read handler of one conversation: each read the model calls runs the real adapter through invokeRead, and is
 * pushed to `calls`. The turn runs a step's tool calls side by side; here they run one after another
 * in call order, and each takes its result id before its first await, so a replay sends exactly the recorded prompt.
 * A refused read answers `source_unavailable`, as the golden harness answers it.
 */
function realReads(db: Database, actor: EvryActor, calls: ToolCall[]): ToolHandlers["read"] {
	let queue: Promise<unknown> = Promise.resolve();
	return (adapter, input) => {
		const call: ToolCall = { operation: adapter.operation, input };
		calls.push(call);
		const resultId = calls.length;
		const next = queue.then(async () => {
			try {
				return resultForModel(resultId, await invokeRead(db, actor, adapter, input));
			} catch (error) {
				call.error = error instanceof EvryRefusal ? error.code : "source_unavailable";
				return { error: "source_unavailable" };
			}
		});
		queue = next.catch(() => undefined);
		return next;
	};
}

/** One request, as the runtime asks it: the real system prompt and read tools, up to four model steps. */
export async function converse(model: LanguageModelV4, db: Database, actor: EvryActor, text: string, now: Date) {
	const calls: ToolCall[] = [];
	const tools = readTools(actor, realReads(db, actor, calls), RECORDED);
	const context = compileContext({ actor, catalog: readCatalog(actor, RECORDED), history: [], text, references: [], now });
	const run = streamText({
		model,
		system: context.system,
		messages: context.messages,
		tools,
		stopWhen: stepCountIs(4),
		maxRetries: 0,
		maxOutputTokens: LIMITS.outputTokensPerCall,
		onError: () => undefined,
	});
	return { calls, answer: await run.text };
}
