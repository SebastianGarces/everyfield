// The permissions model's trace replay (T-399). `bin/dev formal` has TLC generate random behaviors of
// formal/permissions/Permissions.tla from a fixed seed and writes them to formal/permissions/traces.json. This test
// seeds the model's starting state for each behavior, runs every step through the real operation that
// .agents/skills/formal-permissions/map.json maps its action to, and after each step compares what the code did, and
// the state it left in Postgres, with the model. The first disagreement stops that behavior and fails with both sides.
//
// FORMAL_TRACES=<dir> replays <dir>/permissions/traces.json instead, a fresh set from
// `bin/dev formal --traces <dir> [--seed <n>]`. .agents/skills/formal-permissions/SKILL.md says how.
import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, type Actor, type Workspace } from "../../support/fixture.mts";
import {
	createIdentityService,
	createInvitationService,
	createSeatService,
	InvitationRefusal,
} from "../../../packages/domain/src/identity/index.ts";
import { accountPersonProducer, peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";

type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Entries = Record<string, Record<string, Value>>;
type Step = { action: string; args: Record<string, string>; ok?: boolean; after: Entries };
type Traces = { seed: number; traces: number; depth: number; init: Entries; behaviors: Step[][] };

const committed = fileURLToPath(new URL("../../../formal/permissions/traces.json", import.meta.url));
const source = process.env.FORMAL_TRACES ? join(process.env.FORMAL_TRACES, "permissions", "traces.json") : committed;
const traces = JSON.parse(readFileSync(source, "utf8")) as Traces;

const ORIGIN = "http://replay.example.test";
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = "Replay-pass-1";
/** The display name of each Person a replayed tenant write creates, so the write's effect is countable. */
const WRITTEN = "Replay write";

let fx: Awaited<ReturnType<typeof fixture>>;
let seats: ReturnType<typeof createSeatService>;
let invitations: ReturnType<typeof createInvitationService>;
let identity: ReturnType<typeof createIdentityService>;
let passwordHash: string;
/** Each invitation's proof, read from the mail the invite sent. */
const proofs = new Map<string, string>();
/** No seat the replay removes holds a dated task, so a reminder replan would be a bug. */
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

before(async () => {
	fx = await fixture({ prefix: "replay", max: 8, roles: { runtime: ["runtime"], auth: ["auth"] } });
	const db = fx.pools.runtime;
	seats = createSeatService(db);
	invitations = createInvitationService({
		db,
		origin: ORIGIN,
		budgetSecret: randomBytes(32).toString("hex"),
		people: accountPersonProducer,
		addressBlocked: () => sql`false`,
		enqueueMail: async (_tx, mail) => {
			const proof = /#proof=(\S+)/.exec(mail.text)?.[1];
			if (proof) proofs.set(mail.invitationId, decodeURIComponent(proof));
			return randomUUID();
		},
	});
	identity = createIdentityService({
		db,
		authDb: fx.pools.auth,
		admissionDb: fx.connect("runtime", { max: 2 }),
		origin: ORIGIN,
		secret: SECRET,
		scheduleDelivery: () => {},
		trustedIp: () => null,
		enqueueMail: async () => randomUUID(),
		diagnostic: () => {},
	});
	passwordHash = await (await identity.auth.$context).password.hash(PASSWORD);
});
after(async () => {
	await fx?.close();
});

/** The cookie Better Auth sets for a session token: the token signed with the auth secret. */
const sessionCookie = (token: string) =>
	`better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", SECRET).update(token).digest("base64")}`)}`;
/** A POST to the identity service, as the browser sends it. */
const post = (path: string, body: unknown, cookie?: string) =>
	identity.handle(
		new Request(`${ORIGIN}/api/auth/${path}`, {
			method: "POST",
			headers: {
				host: new URL(ORIGIN).host,
				origin: ORIGIN,
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
const command = (expectedRevision: string, input: Record<string, unknown>) => ({
	requestKey: randomUUID(),
	expectedRevision,
	input,
});
const rows = async (query: ReturnType<typeof sql>) => (await fx.admin.execute(query)).rows as Record<string, any>[];

/** What the code did with a step: allowed, admitted or refused, with the refusal's code. */
type Outcome = string;
/** Runs an operation; a domain refusal or a contract that rejects the input is a refusal, anything else fails. */
async function outcome(run: () => Promise<unknown>, success = "allowed"): Promise<Outcome> {
	try {
		const result = (await run()) as { status?: string; error?: { code?: string } } | undefined;
		if (result && result.status === "refused") return `refused (${result.error?.code})`;
		return success;
	} catch (error) {
		if (error instanceof InvitationRefusal) return `refused (${error.value.code})`;
		if (error instanceof Error && error.name === "ZodError") return "refused (invalid_input)";
		return `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
	}
}

/**
 * One behavior's world: the model's starting state seeded through the fixture, and which row stands for each model
 * seat, session, invitation and request.
 */
class World {
	plants = new Map<string, Workspace>();
	accounts = new Map<string, Actor>();
	seats = new Map<string, string>();
	sessions = new Map<string, { id: string; cookie: string }>();
	invitations = new Map<string, string>();
	requests = new Map<string, RequestActor>();
	/** Each mapped seat's revision after the last step. */
	revisions = new Map<string, string>();
	/** Each plant's count of replayed writes after the last step. */
	writes = new Map<string, number>();

	static async seed(init: Entries) {
		const world = new World();
		for (const w of Object.keys(init.data!)) world.plants.set(w, await fx.plant());
		const names = [...new Set(Object.keys(init.sessions!).map((k) => k.split("/")[0]!))];
		for (const name of names) {
			const live = Object.entries(init.seats!).filter(([k, s]) => k.startsWith(`${name}/`) && seatOf(s).state === "live");
			if (live.length > 1) throw Error(`the model starts ${name} with ${live.length} live seats`);
			const seat = live[0] && seatOf(live[0][1]);
			const actor = await fx.actor(seat ? world.plants.get(seat.ws)! : null, (seat?.role ?? "member") as "owner");
			world.accounts.set(name, actor);
			await fx.admin.execute(
				sql`INSERT INTO auth_account(user_id, provider_id, provider_account_id, password_hash)
				VALUES(${actor.user}::uuid, 'credential', ${actor.user}, ${passwordHash})`,
			);
			if (live[0]) world.seats.set(live[0][0], (await rows(sql`SELECT id FROM seat WHERE account_id=${actor.id}::uuid`))[0]!.id);
			for (const [key, state] of Object.entries(init.sessions!).filter(([k]) => k.startsWith(`${name}/`))) {
				if (state === "unused") continue;
				if (state !== "live" || !key.endsWith("/1")) throw Error(`the replay seeds only a live first session, not ${key} ${state}`);
				const [s] = await rows(sql`SELECT token FROM auth_session WHERE id=${actor.session}::uuid`);
				world.sessions.set(key, { id: actor.session, cookie: sessionCookie(s!.token) });
			}
		}
		for (const [k, i] of Object.entries(init.invitations!))
			if ((i as { state: string }).state !== "unused") throw Error(`the replay seeds no invitation, not ${k}`);
		await world.observe();
		world.settle();
		return world;
	}

	account = (key: string) => this.accounts.get(key.split("/")[0]!)!;
	session(key: string) {
		const s = this.sessions.get(key);
		if (!s) throw Error(`model session ${key} has no session row`);
		return s;
	}
	async authority(key: string) {
		const actor = await fx.pools.runtime.transaction((tx) => RequestActor.resolve(tx, sessionId.parse(this.session(key).id)));
		if (!(actor instanceof RequestActor)) throw new Unresolved(actor.status);
		return actor;
	}
	plantOf(seat: string) {
		const [row] = this.seatRows.filter((r) => r.id === this.seats.get(seat));
		return [...this.plants.values()].find((p) => p.id === row?.plant_id)!;
	}

	seatRows: Record<string, any>[] = [];
	liveSessions = new Set<string>();
	invitationRow: Record<string, any> | undefined;
	written = new Map<string, number>();
	/** Reads the rows the model's state stands for. */
	async observe() {
		const ids = [...this.accounts.values()].map((a) => a.id);
		const users = [...this.accounts.values()].map((a) => a.user);
		this.seatRows = await rows(
			sql`SELECT id, account_id, plant_id, role, revision::text AS revision, ended_at FROM seat
			WHERE account_id=ANY(${`{${ids.join(",")}}`}::uuid[]) ORDER BY id`,
		);
		this.liveSessions = new Set(
			(
				await rows(
					sql`SELECT id, user_id FROM auth_session WHERE user_id=ANY(${`{${users.join(",")}}`}::uuid[]) AND expires_at>clock_timestamp()`,
				)
			).map((r) => `${r.user_id}/${r.id}`),
		);
		const invitation = [...this.invitations.values()][0];
		this.invitationRow = invitation
			? (
					await rows(
						sql`SELECT state, created_at+interval '30 days'<=clock_timestamp() AS expired FROM invitation WHERE id=${invitation}::uuid`,
					)
				)[0]
			: undefined;
		const plants = [...this.plants.values()].map((p) => p.id);
		const counts = await rows(
			sql`SELECT p.id, (SELECT count(*)::int FROM person x WHERE x.plant_id=p.id AND x.display_name=${WRITTEN}) AS n
			FROM plant p WHERE p.id=ANY(${`{${plants.join(",")}}`}::uuid[])`,
		);
		this.written = new Map(counts.map((r) => [r.id, r.n]));
	}
	/** Maps each model seat or session a step brought into use to the one new row for its account. */
	adopt(model: Entries) {
		for (const [key, s] of Object.entries(model.seats!)) {
			if (seatOf(s).state === "unused" || this.seats.has(key)) continue;
			const mapped = new Set(this.seats.values());
			const fresh = this.seatRows.filter((r) => r.account_id === this.account(key).id && !mapped.has(r.id));
			if (fresh.length === 1) this.seats.set(key, fresh[0]!.id);
		}
	}
	/** The model's state and the code's, field by field, after a step. */
	fields(model: Entries, before: Entries) {
		const out: { field: string; model: string; code: string }[] = [];
		const wsName = (plant: string | null) =>
			[...this.plants].find(([, p]) => p.id === plant)?.[0] ?? `other workspace ${plant}`;
		for (const [key, value] of Object.entries(model.seats!)) {
			const s = seatOf(value),
				was = seatOf(before.seats![key]!);
			if (s.state === "unused") {
				if (this.seats.has(key)) out.push({ field: `seat ${key}`, model: "unused", code: "a seat row" });
				continue;
			}
			const rev = was.state === "unused" ? "new" : s.rev !== was.rev ? "revision changed" : "revision same";
			const row = this.seatRows.find((r) => r.id === this.seats.get(key));
			const code = row
				? `${row.ended_at ? "ended" : "live"} ${wsName(row.plant_id)} ${row.role} ${
						!this.revisions.has(row.id) ? "new" : this.revisions.get(row.id) !== row.revision ? "revision changed" : "revision same"
					}`
				: "no seat row";
			out.push({ field: `seat ${key}`, model: `${s.state} ${s.ws} ${s.role} ${rev}`, code });
		}
		const mappedSeats = new Set(this.seats.values());
		for (const [name, actor] of this.accounts) {
			const extra = this.seatRows.filter((r) => r.account_id === actor.id && !mappedSeats.has(r.id)).length;
			out.push({ field: `unmodeled seats of ${name}`, model: "0", code: `${extra}` });
		}
		for (const [key, state] of Object.entries(model.sessions!)) {
			const s = this.sessions.get(key);
			const code = s ? (this.liveSessions.has(`${this.account(key).user}/${s.id}`) ? "live" : "ended") : "unused";
			out.push({ field: `session ${key}`, model: String(state), code });
		}
		for (const [name, actor] of this.accounts) {
			const mapped = new Set([...this.sessions].filter(([k]) => k.startsWith(`${name}/`)).map(([, s]) => s.id));
			const extra = [...this.liveSessions].filter((k) => k.startsWith(`${actor.user}/`) && !mapped.has(k.split("/")[1]!));
			out.push({ field: `unmodeled live sessions of ${name}`, model: "0", code: `${extra.length}` });
		}
		for (const [key, value] of Object.entries(model.invitations!)) {
			const i = this.invitationRow;
			const code = !this.invitations.has(key) ? "unused" : i!.state === "pending" && i!.expired ? "expired" : i!.state;
			out.push({ field: `invitation ${key}`, model: String((value as { state: string }).state), code });
		}
		for (const [w, plant] of this.plants) {
			const changed = (n: boolean) => (n ? "changed" : "unchanged");
			out.push({
				field: `tenant data ${w}`,
				model: changed(model.data![w] !== before.data![w]),
				code: changed(this.written.get(plant.id) !== this.writes.get(plant.id)),
			});
		}
		return out;
	}
	/** Remembers this step's revisions and write counts, for the next step's "changed". */
	settle() {
		this.revisions = new Map(this.seatRows.map((r) => [r.id, r.revision]));
		this.writes = new Map(this.written);
	}
}
class Unresolved extends Error {
	constructor(readonly status: string) {
		super(`the session resolved no active actor (${status})`);
	}
}
const seatOf = (v: Value) => v as { state: string; ws: string; role: string; rev: number };

/** The real operation for each model action (map.json), returning what the code did. */
const handlers: Record<string, (world: World, args: Record<string, string>) => Promise<Outcome>> = {
	async SignIn(world, { session }) {
		const actor = world.account(session);
		const response = await post("sign-in/email", { email: actor.email, password: PASSWORD });
		if (response.status !== 200) return `refused (HTTP ${response.status} ${JSON.stringify(await response.json())})`;
		const cookie = response.headers
			.getSetCookie()
			.map((c) => c.split(";")[0]!)
			.find((c) => c.startsWith("better-auth.session_token="))!;
		const token = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
		const [row] = await rows(sql`SELECT id FROM auth_session WHERE token=${token}`);
		world.sessions.set(session, { id: row!.id, cookie });
		return "allowed";
	},
	async EndSession(world, { session }) {
		const response = await post("sign-out", {}, world.session(session).cookie);
		return response.status === 200 ? "allowed" : `refused (HTTP ${response.status})`;
	},
	async SeatAction(world, { session, op, to, target }) {
		const plant = world.plantOf(target);
		const [seat] = await rows(sql`SELECT id, role, revision::text AS revision FROM seat WHERE id=${world.seats.get(target)}::uuid`);
		const input =
			op === "remove"
				? { seatId: seat!.id, expectedRole: seat!.role, handoffs: [] }
				: { seatId: seat!.id, expectedRole: seat!.role, to };
		return outcome(async () => {
			const authority = await world.authority(session);
			const v = command(seat!.revision, input);
			if (op === "appointAdmin") return seats.appointAdmin(authority, plant, v);
			if (op === "demote") return seats.demote(authority, plant, v);
			if (op === "changeOrdinaryRole") return seats.changeOrdinaryRole(authority, plant, v);
			if (op === "remove") return seats.remove(authority, plant, v, noReminders);
			throw Error(`unknown seat action ${op}`);
		});
	},
	async Invite(world, { session, invitation, workspace, role, to }) {
		const plant = world.plants.get(workspace)!;
		const [p] = await rows(sql`SELECT revision::text AS revision FROM plant WHERE id=${plant.id}::uuid`);
		return outcome(async () => {
			const sent = await invitations.invite(
				await world.authority(session),
				command(p!.revision, { workspace: plant, recipientEmail: world.account(to).email, role }),
			);
			world.invitations.set(invitation, sent.invitation.invitationId as string);
		});
	},
	async Revoke(world, { session, invitation }) {
		const id = world.invitations.get(invitation)!;
		const [i] = await rows(sql`SELECT revision::text AS revision FROM invitation WHERE id=${id}::uuid`);
		return outcome(async () =>
			invitations.revoke(await world.authority(session), command(i!.revision, { invitationId: id })),
		);
	},
	// 30 days pass for the invitation: its dates move back, so `current` sees it as 30 days old.
	async Expire(world, { invitation }) {
		await fx.admin.execute(
			sql`UPDATE invitation SET created_at=created_at-interval '30 days', resent_at=resent_at-interval '30 days'
			WHERE id=${world.invitations.get(invitation)}::uuid`,
		);
		return "allowed";
	},
	async Accept(world, { session, invitation }) {
		const id = world.invitations.get(invitation)!;
		const [i] = await rows(sql`SELECT revision::text AS revision FROM invitation WHERE id=${id}::uuid`);
		return outcome(() =>
			invitations.accept(world.session(session).id, command(i!.revision, { invitationId: id, proof: proofs.get(id) })),
		);
	},
	async Resolve(world, { request, session }) {
		return outcome(async () => world.requests.set(request, await world.authority(session)));
	},
	async Run(world, { request, kind }) {
		const authority = world.requests.get(request)!;
		world.requests.delete(request);
		const workspace = authority.actor.context.owner;
		if (kind === "read") return outcome(() => seats.list(authority, { workspace }), "admitted");
		if (kind === "adminRead") return outcome(() => invitations.list(authority, { workspace }), "admitted");
		if (kind === "write")
			return outcome(
				() =>
					withPeopleWrite(fx.pools.runtime, authority, (t, c) =>
						peopleWriter.createPerson(t, c, { requestKey: randomUUID(), input: { displayName: WRITTEN } }),
					),
				"admitted",
			);
		throw Error(`unknown statement kind ${kind}`);
	},
};

/** The model's state after a step: the state before with the entries the step changed. */
function apply(state: Entries, step: Step): Entries {
	const next = structuredClone(state);
	for (const [name, changed] of Object.entries(step.after)) Object.assign((next[name] ??= {}), changed);
	return next;
}
const where = `seed ${traces.seed}, ${source === committed ? "formal/permissions/traces.json" : source}`;

test("INV-access: every action in the permissions model's traces has a replay handler", () => {
	assert.ok(traces.behaviors.length > 0);
	const actions = new Set(traces.behaviors.flat().map((s) => s.action));
	assert.deepEqual(
		[...actions].filter((a) => !Object.hasOwn(handlers, a)),
		[],
		"a model action has no handler in tests/integration/access/formal-replay.test.mts: add one",
	);
});

for (const [n, behavior] of traces.behaviors.entries())
	test(`INV-access: replayed behavior ${n + 1} of the permissions model (${behavior.length} steps) agrees with the code at every step`, async () => {
		const world = await World.seed(traces.init);
		let model = traces.init;
		for (const [k, step] of behavior.entries()) {
			const head = `Behavior ${n + 1} of ${traces.behaviors.length} (${where}) disagrees at step ${k + 1} of ${behavior.length}: ${step.action} ${JSON.stringify(step.args)}`;
			const handler = Object.hasOwn(handlers, step.action) ? handlers[step.action] : undefined;
			if (!handler) assert.fail(`${head}\nThe replay has no handler for the model action ${step.action}. Add one.`);
			const expected = step.action === "Run" ? (step.ok ? "admitted" : "refused") : "allowed";
			let code: Outcome;
			try {
				code = await handler(world, step.args);
			} catch (error) {
				if (!(error instanceof Unresolved)) throw error;
				code = `refused (${error.message})`;
			}
			const before = model;
			model = apply(model, step);
			await world.observe();
			world.adopt(model);
			const fields = [
				{ field: "result", model: expected, code: expected === "refused" && code.startsWith("refused") ? "refused" : code },
				...world.fields(model, before),
			];
			if (fields.some((f) => f.model !== f.code)) {
				const width = Math.max(...fields.map((f) => f.model.length), 5);
				const table = fields.map(
					(f) => `  ${f.field.padEnd(30)} ${f.model.padEnd(width)}  ${f.code}${f.model === f.code ? "" : "   <- differs"}`,
				);
				const steps = behavior
					.slice(0, k + 1)
					.map((s, i) => `  ${i + 1}. ${s.action} ${JSON.stringify(s.args)}${s.ok === undefined ? "" : ` ok=${s.ok}`}`);
				assert.fail(
					[
						head,
						`  ${"".padEnd(30)} ${"model".padEnd(width)}  code`,
						...table,
						"The behavior up to here:",
						...steps,
						`Generate it again: bin/dev formal --traces <dir outside the repo> --seed ${traces.seed}, then replay with FORMAL_TRACES=<dir>.`,
					].join("\n"),
				);
			}
			world.settle();
		}
	});
