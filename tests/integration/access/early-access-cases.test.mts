import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { PHASES } from "../../../packages/domain/src/early-access/contract.ts";
import { receiveAccessRequest } from "../../../packages/domain/src/early-access/index.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { closeDatabase } from "../../../packages/db/src/client.ts";
import { afterReply, START } from "../../../apps/web/src/access/steps.ts";
import { GET as accessRetention } from "../../../apps/web/src/app/api/cron/access-retention/route.ts";
import { jobDatabase } from "../../../apps/web/src/server/database.ts";
import { waitingOnLock } from "../../support/fixture.mts";
import { failingWrite, NOTHING, recorded, touched } from "../../support/recorded.mts";
import { setServerEnv } from "../../support/server-env.mts";
import { testDatabase, type Database } from "../../support/test-database.mts";
import { freezeClock } from "../target/sql/knowledge/support.mts";

type Fields = Record<string, unknown>;
type StoredRequest = {
	id: string;
	created_at: string;
	kind: string;
	email: string;
	data: Fields;
	ip_address: string | null;
	mail_payload: Fields;
	mail_id: string | null;
	mailed_at: string | null;
};
type Attempt = { created_at: string; email: string; ip_key: string };
type Configuration = {
	email_to: string | null;
	contact_fallback: string;
	storage: "available" | "unavailable";
	provider: "available" | "refused";
	trusted_ip: string;
	existing_requests: StoredRequest[];
	email_attempts_in_24_hours: number;
	ip_attempts_in_one_hour: number;
	existing_attempts?: Attempt[];
	provider_mail_id?: string;
	mail_receipt_storage?: "unavailable";
};
type Subcase = {
	name: string;
	given: {
		configuration: Configuration;
		execution?: {
			parallel_calls: { arguments: { kind: string; fields: Fields } }[];
			barrier: string;
		};
	};
	clock: { now: string };
	action: { operation: string; arguments: { kind: string; fields: Fields } };
	expected: { state: Fields; result: Fields; error_code?: string; event: null };
};
type Case = Omit<Subcase, "name"> & { id: string; subcases: Subcase[] };

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(REPO, path), "utf8"));
const main = (json("docs/acceptance/operations.json").cases as Case[]).find((c) => c.id === "CASE-ADM-006")!;
const form = json("design/marketing-copy.json").shared.access_page as {
	contact_email: string;
	phases: string[];
	outcomes: Record<string, { title: string; body: string; link?: string }>;
};
const CASES = new Map<string, Subcase>([
	["the planter form stores and emails every field", { ...main, name: "planter" }],
	...main.subcases.map((s) => [s.name, s] as const),
]);
const NOW = new Date(main.clock.now);

const database = await testDatabase({ prefix: "earlycases", clock: NOW, max: 6 });
const { admin, schema } = database;
const runtime = database.pools.runtime;
const SECRET = "early-access-cron-secret";
before(async () => {
	await freezeClock(admin, schema, NOW);
	mock.timers.enable({ apis: ["Date"], now: NOW });
	setServerEnv({ IDENTITY_DATABASE_URL: database.logins.runtime.url.href });
	process.env.CRON_SECRET = SECRET;
});
after(async () => {
	mock.timers.reset();
	delete process.env.CRON_SECRET;
	await closeDatabase(jobDatabase() as Database);
	await database.close();
});
const rowsOf = async (query: SQL) => (await admin.execute(query)).rows;
const instant = (value: unknown) => (value === null ? null : new Date(value as string).toISOString());

let calls: {
	key: string;
	payload: { from: string; to: string[]; reply_to: string; subject: string; text: string };
}[];
let sent: Map<string, string>;
beforeEach(async () => {
	await admin.execute(sql`TRUNCATE early_access_request, early_access_attempt`);
	calls = [];
	sent = new Map();
});

const stored = async (): Promise<StoredRequest[]> =>
	(
		await rowsOf(sql`SELECT id,created_at,kind,email,data,host(ip_address) AS ip_address,mail_payload,mail_id,mailed_at
			FROM early_access_request ORDER BY created_at,id`)
	).map((r) => ({
		...r,
		created_at: instant(r.created_at),
		mailed_at: instant(r.mailed_at),
	})) as StoredRequest[];
const seeded = (r: StoredRequest) => ({
	...r,
	created_at: instant(r.created_at),
	mailed_at: instant(r.mailed_at),
});
const attempts = async () =>
	(await rowsOf(sql`SELECT created_at,email,ip_key FROM early_access_attempt ORDER BY created_at,email,ip_key`)).map(
		(r) => ({ ...r, created_at: instant(r.created_at) }),
	) as Attempt[];

async function given(c: Subcase) {
	const { configuration: g } = c.given;
	for (const r of g.existing_requests)
		await admin.execute(sql`INSERT INTO early_access_request(id,created_at,kind,email,data,ip_address,mail_payload,mail_id,mailed_at)
			VALUES(${r.id},${r.created_at},${r.kind},${r.email},${JSON.stringify(r.data)}::jsonb,${r.ip_address}::inet,
			${JSON.stringify(r.mail_payload)}::jsonb,${r.mail_id},${r.mailed_at})`);
	const email = String(c.action.arguments.fields?.email ?? "")
		.trim()
		.toLowerCase();
	const seen: Attempt[] = [
		...(g.existing_attempts ?? []),
		...Array.from({ length: g.email_attempts_in_24_hours }, (_, i) => ({
			created_at: "2026-10-13T16:00:01Z",
			email,
			ip_key: `198.51.100.${i + 1}`,
		})),
		...Array.from({ length: g.ip_attempts_in_one_hour }, (_, i) => ({
			created_at: "2026-10-14T15:00:01Z",
			email: `visitor${i}@example.test`,
			ip_key: g.trusted_ip,
		})),
	];
	for (const a of seen)
		await admin.execute(
			sql`INSERT INTO early_access_attempt(created_at,email,ip_key) VALUES(${a.created_at},${a.email},${a.ip_key})`,
		);
}

const provider =
	(g: Configuration, held: () => Promise<void> = async () => {}): typeof fetch =>
	async (url, init) => {
		assert.equal(url, "https://api.resend.com/emails");
		assert.equal(init?.method, "POST");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer fake-provider-key");
		const key = headers.get("idempotency-key") ?? assert.fail("no idempotency key");
		calls.push({ key, payload: JSON.parse(String(init.body)) });
		await held();
		if (g.provider === "refused") return new Response("", { status: 422 });
		if (!sent.has(key)) sent.set(key, g.provider_mail_id ?? `mail-${sent.size + 1}`);
		return Response.json({ id: sent.get(key) });
	};
const submit = (
	c: Subcase,
	{ kind, fields } = c.action.arguments,
	held?: () => Promise<void>,
	configuration = c.given.configuration,
) =>
	receiveAccessRequest(kind, fields, configuration.trusted_ip, {
		db: runtime,
		fetch: provider(configuration, held),
		env: {
			...({} as NodeJS.ProcessEnv),
			VERCEL_ENV: "production",
			RESEND_API_KEY: "fake-provider-key",
			EMAIL_FROM: "Everyfield <hello@example.test>",
			...(configuration.email_to && { EARLY_ACCESS_EMAIL_TO: configuration.email_to }),
		},
	});

async function brokenStorage<T>(body: () => Promise<T>) {
	await admin.execute(sql`ALTER TABLE early_access_request RENAME TO early_access_request_away`);
	try {
		return await body();
	} finally {
		await admin.execute(sql`ALTER TABLE early_access_request_away RENAME TO early_access_request`);
	}
}
async function attempted<T>(c: Subcase, body: () => Promise<T>) {
	const g = c.given.configuration;
	if (g.storage === "unavailable") return brokenStorage(body);
	if (g.mail_receipt_storage === "unavailable")
		return failingWrite(admin, { on: "early_access_request", event: "UPDATE OF mail_id" }, body);
	return body();
}

const LABELS: Record<string, string> = {
	Form: "kind",
	Name: "name",
	Email: "email",
	"Plant name": "plant_name",
	City: "city",
	Phase: "phase",
	"Sending church or network": "sending",
	"Network or church": "organization",
	Role: "role",
	"Plants sent or supported": "plants",
	Message: "message",
};
const emailed = (text: string) =>
	Object.fromEntries(
		text.split("\n").map((line) => {
			const [, label, value] = /^([^:]+): (.*)$/.exec(line) ?? assert.fail(line);
			const field = LABELS[label!] ?? assert.fail(`unknown label ${label}`);
			return [field, field === "plants" && /^\d+$/.test(value!) ? Number(value) : value];
		}),
	);
const optional = (text: string) =>
	Object.entries(emailed(text))
		.filter(([, value]) => value === "(not provided)")
		.map(([field]) => field);

const admits = (c: Subcase) =>
	!["invalid", "rate_limited"].includes(String(c.expected.result.status)) &&
	!c.action.arguments.fields.website &&
	c.given.configuration.storage === "available" &&
	c.given.configuration.email_to !== null;

const population = () =>
	rowsOf(sql`SELECT (SELECT count(*) FROM account)+(SELECT count(*) FROM auth_user) AS accounts,
		(SELECT count(*) FROM person)+(SELECT count(*) FROM plant)+(SELECT count(*) FROM organization) AS crm`).then(([r]) => ({
		accounts: Number(r!.accounts),
		crm: Number(r!.crm),
	}));

type Seen = {
	result: unknown;
	rows: StoredRequest[];
	fresh: StoredRequest[];
};
const SUPPORTED = new Set([
	"new_access_requests",
	"new_account_rows",
	"new_crm_rows",
	"mail_http_attempts",
	"stored_fields",
	"email_to",
	"emailed_fields",
	"contact_fallback",
	"mail_id",
	"mailed_at",
	"early_access_request_rows",
	"idempotency_key",
	"provider_emails_sent",
	"original_mail_payload_preserved",
	"old_pending_row",
	"new_request_id_differs_from",
	"new_mail_id",
	"new_mailed_at",
	"new_request_plant_name",
	"provider_idempotency_key_uses_new_request_id",
	"second_owner_email_acceptable",
]);

function assertState(c: Subcase, seen: Seen) {
	const { state } = c.expected;
	for (const key of Object.keys(state)) assert.ok(SUPPORTED.has(key), `no assertion reads ${key}`);
	assert.equal(seen.fresh.length, state.new_access_requests);
	assert.equal(calls.length, state.mail_http_attempts);
	const [only] = seen.rows;
	const [fresh] = seen.fresh;
	if ("stored_fields" in state) {
		assert.deepEqual({ ...fresh!.data, kind: fresh!.kind }, state.stored_fields);
		assert.equal(fresh!.email, (state.stored_fields as Fields).email);
		assert.equal(fresh!.ip_address, c.given.configuration.trusted_ip);
		assert.equal(fresh!.created_at, instant(c.clock.now));
	}
	if ("emailed_fields" in state) assert.deepEqual(emailed(calls[0]!.payload.text), state.emailed_fields);
	if ("email_to" in state) for (const call of calls) assert.deepEqual(call.payload.to, [state.email_to]);
	for (const call of calls) assert.deepEqual(call.payload.to, [c.given.configuration.email_to]);
	if ("early_access_request_rows" in state) assert.equal(seen.rows.length, state.early_access_request_rows);
	if ("mail_id" in state) assert.equal(only!.mail_id, state.mail_id);
	if ("mailed_at" in state) assert.equal(only!.mailed_at, instant(state.mailed_at));
	if ("idempotency_key" in state)
		assert.deepEqual(
			calls.map((call) => call.key),
			[state.idempotency_key],
		);
	if ("provider_emails_sent" in state) assert.equal(sent.size, state.provider_emails_sent);
	if ("original_mail_payload_preserved" in state) {
		const [original] = c.given.configuration.existing_requests;
		assert.equal(
			state.original_mail_payload_preserved,
			JSON.stringify(calls[0]!.payload) === JSON.stringify(original!.mail_payload),
		);
		assert.deepEqual(only!.mail_payload, original!.mail_payload);
		assert.deepEqual(only!.data, original!.data);
	}
	if ("old_pending_row" in state) {
		const old = state.old_pending_row as StoredRequest;
		assert.deepEqual(
			seen.rows.find((r) => r.id === old.id),
			seeded(old),
		);
		assert.notEqual(fresh!.id, state.new_request_id_differs_from);
		assert.equal(fresh!.mail_id, state.new_mail_id);
		assert.equal(fresh!.mailed_at, instant(state.new_mailed_at));
		assert.equal(fresh!.data.plant_name, state.new_request_plant_name);
		assert.equal(calls[0]!.key === `early-access/${fresh!.id}`, state.provider_idempotency_key_uses_new_request_id);
		assert.match(calls[0]!.payload.text, /Plant name: Changed on retry/);
		assert.equal(sent.size === 2, state.second_owner_email_acceptable);
	}
	if ("contact_fallback" in state) {
		const shown = afterReply({ ...START, step: 3, who: "planter" }, { name: "Alex Rivera" }, seen.result as never);
		assert.equal(shown.status, "unavailable");
		assert.deepEqual(shown.values, { name: "Alex Rivera" });
		const notice = form.outcomes[shown.status]!;
		assert.ok(notice.body.includes(form.contact_email) && notice.link?.includes(form.contact_email), notice.body);
		assert.notEqual(notice.title, form.outcomes.received!.title);
	}
}

async function run(c: Subcase, body: () => Promise<unknown> = () => submit(c)): Promise<Seen> {
	assert.equal(c.action.operation, "marketing.requestInvitation");
	await given(c);
	const earlier = await stored();
	const earlierAttempts = await attempts();
	if ("old_pending_row" in c.expected.state) sent.set(`early-access/${earlier[0]!.id}`, "mail-lost");
	const people = await population();
	const { value, tables } = await touched(admin, () => recorded(admin, () => attempted(c, body)));
	const now = await population();
	const { new_account_rows, new_crm_rows } = c.expected.state;
	if (new_account_rows !== undefined)
		assert.deepEqual([now.accounts - people.accounts, now.crm - people.crm], [new_account_rows, new_crm_rows]);
	const rows = await stored();
	const fresh = rows.filter((r) => !earlier.some((e) => e.id === r.id));
	assert.deepEqual(value.added, NOTHING, "no audit, job, notice or mail row");
	assert.deepEqual(
		tables.filter((name) => !["early_access_request", "early_access_attempt"].includes(name)),
		[],
		"no account, CRM or other row",
	);
	assert.equal(c.expected.event, null);
	if (!("original_mail_payload_preserved" in c.expected.state))
		for (const e of earlier)
			assert.deepEqual(
				rows.find((r) => r.id === e.id),
				e,
				"an earlier request is kept as it was",
			);
	const admitted = (await attempts()).length - earlierAttempts.length;
	assert.equal(admitted, admits(c) ? (c.given.execution ? 2 : 1) : 0, "only an admitted submission is an attempt");
	return { result: value.value, rows, fresh };
}
async function requests(c: Subcase, extra?: (seen: Seen) => unknown) {
	const seen = await run(c);
	assert.deepEqual(seen.result, c.expected.result);
	assertState(c, seen);
	await extra?.(seen);
}

const requestRetention = (authorization?: string) =>
	accessRetention(
		new Request("https://app.example.test/api/cron/access-retention", {
			headers: authorization ? { authorization } : {},
		}),
	);
async function retention(c: Subcase) {
	assert.equal(c.action.operation, "marketing.expireAccessRequests");
	await given(c);
	const before = await stored();
	const { value, tables } = await touched(admin, () => recorded(admin, () => requestRetention(`Bearer ${SECRET}`)));
	assert.equal(value.value.status, 200);
	assert.deepEqual(await value.value.json(), c.expected.result);
	const { state } = c.expected;
	const left = await stored();
	assert.deepEqual(
		left.map(({ id, ip_address }) => ({ id, ip_address })),
		state.remaining_requests,
	);
	for (const r of left)
		assert.deepEqual({ ...r, ip_address: null }, { ...before.find((b) => b.id === r.id), ip_address: null });
	assert.deepEqual(
		before.map((r) => r.id).filter((id) => !left.some((r) => r.id === id)),
		state.deleted_request_ids ?? [],
	);
	assert.deepEqual(
		await attempts(),
		(state.remaining_attempts as Attempt[]).map((a) => ({
			...a,
			created_at: instant(a.created_at),
		})),
	);
	assert.deepEqual(value.added, NOTHING);
	assert.deepEqual(tables, c.expected.result.deleted === 0 ? [] : ["early_access_attempt", "early_access_request"]);
	assert.equal(c.expected.event, null);
}

const APP = join(REPO, "apps/web/src/app");
const patterns = globSync("**/{route.ts,route.tsx,page.tsx}", { cwd: APP }).map((file) => ({
	file,
	segments: file
		.split("/")
		.slice(0, -1)
		.filter((s) => !/^\(.*\)$/.test(s)),
}));
const served = (path: string) =>
	patterns.filter(({ segments }) => {
		const parts = path.split("/").filter(Boolean);
		for (const [i, segment] of segments.entries()) {
			if (/^\[\[?\.\.\./.test(segment)) return true;
			if (parts[i] === undefined || (!segment.startsWith("[") && segment !== parts[i])) return false;
		}
		return parts.length === segments.length;
	});
const exportTool = join(REPO, "packages/domain/scripts/export-access.ts");
const tsx = createRequire(join(REPO, "packages/domain/package.json")).resolve("tsx");
const exportCommand = (args: string[], url?: string) =>
	new Promise<{ code: number; out: string; err: string }>((done) => {
		const { NODE_OPTIONS: _options, DATABASE_URL: _url, ...env } = process.env;
		execFile(
			process.execPath,
			["--conditions=react-server", "--import", tsx, exportTool, ...args],
			{ env: { ...env, ...(url && { DATABASE_URL: url }) } },
			(error, out, err) => done({ code: error ? Number(error.code) : 0, out, err }),
		);
	});
const PUBLIC_EXPORTS = [
	"/api/access/export",
	"/api/access-export",
	"/api/access-requests",
	"/api/access-requests/export",
	"/api/access-requests.csv",
	"/api/early-access",
	"/api/early-access/export",
	"/api/cron/access-export",
	"/access/export",
	"/access/export.csv",
	"/access/requests",
];
async function noPublicExport(hidden: string) {
	assert.deepEqual(
		served("/api/cron/access-retention").map((p) => p.file),
		["api/cron/access-retention/route.ts"],
	);
	assert.deepEqual(
		PUBLIC_EXPORTS.flatMap(served).map((p) => p.file),
		[],
		"no route answers an export path",
	);
	for (const authorization of [undefined, "Bearer wrong"]) {
		const answer = await requestRetention(authorization);
		assert.equal(answer.status, 401);
		assert.equal((await answer.text()).includes(hidden), false);
	}
	return false;
}

const TABLE: Record<string, (c: Subcase) => Promise<unknown>> = {
	"the planter form stores and emails every field": (c) =>
		requests(c, async () => {
			const approved = [
				"0 · Discovery",
				"1 · Core group",
				"2 · Launch team",
				"3 · Training",
				"4 · Pre-launch",
				"5 · Launch Sunday",
				"6 · Post-launch",
			];
			assert.deepEqual([...PHASES], approved);
			assert.deepEqual(form.phases, approved);
			for (const [i, phase] of approved.entries()) {
				const { kind, fields } = c.action.arguments;
				const each = { kind, fields: { ...fields, email: `phase${i}@example.test`, phase } };
				assert.deepEqual(await submit(c, each), { status: "received" });
			}
			assert.deepEqual(
				await submit(c, {
					kind: "planter",
					fields: { ...c.action.arguments.fields, phase: "7 · Other" },
				}),
				{
					status: "invalid",
					fieldErrors: { phase: "required" },
				},
			);
		}),
	"network form stores and emails every field": (c) => requests(c),
	"required fields invalid": (c) => requests(c),
	"network required role invalid": (c) => requests(c),
	"planter optional field omitted": (c) =>
		requests(c, ({ fresh }) => {
			assert.deepEqual(fresh[0]!.data, {
				name: "Alex Rivera",
				email: "alex@example.test",
				plant_name: "Hope Church",
				city: "Chicago",
				phase: "1 · Core group",
			});
			assert.deepEqual(optional(calls[0]!.payload.text), ["sending"]);
		}),
	"network optional fields omitted": (c) =>
		requests(c, ({ fresh }) => {
			assert.deepEqual(fresh[0]!.data, {
				name: "Casey Lee",
				email: "casey@example.test",
				organization: "Grace Network",
				role: "Director",
			});
			assert.deepEqual(optional(calls[0]!.payload.text), ["plants", "message"]);
		}),
	"honeypot fake success": (c) => requests(c),
	"normalized duplicate within 24 hours": (c) => requests(c),
	"same email different form": (c) => requests(c, ({ fresh }) => assert.equal(fresh[0]!.kind, "network")),
	"duplicate at 24 hours expires": (c) => requests(c),
	"email fifth admitted": (c) => requests(c),
	"email sixth limited": (c) => requests(c),
	"IP twentieth admitted": (c) => requests(c),
	"IP twenty-first limited": (c) => requests(c),
	"storage failure": (c) =>
		requests(c, async () => {
			assert.deepEqual(await submit(c), { status: "received" });
			assert.equal((await stored()).length, 1);
		}),
	"provider refusal": (c) =>
		requests(c, async ({ fresh }) => {
			assert.equal(sent.size, 0);
			const recovered = { ...c.given.configuration, provider: "available" as const };
			assert.deepEqual(await submit(c, undefined, undefined, recovered), { status: "received" });
			assert.deepEqual(
				calls.map((call) => call.key),
				[`early-access/${fresh[0]!.id}`, `early-access/${fresh[0]!.id}`],
			);
			assert.equal((await stored()).length, 1);
		}),
	"failed mail retries the pending row with its original payload and key": (c) => requests(c),
	"missing recipient": (c) => requests(c),
	"concurrent same email and kind sends one provider email": async (c) => {
		const { execution, configuration } = c.given;
		assert.equal(execution!.barrier, "before_duplicate_admission_and_mail_receipt");
		const { kind, fields } = c.action.arguments;
		const both = [c.action.arguments, ...execution!.parallel_calls.map((call) => call.arguments)];
		assert.equal(both.length, 2);
		const arrived = Promise.withResolvers<void>();
		const held = async () => {
			if (calls.length === both.length) arrived.resolve();
			await arrived.promise;
		};
		const locked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = admin.transaction(async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('email:alex@example.test',0))`);
			locked.resolve();
			await release.promise;
		});
		await locked.promise;
		const settled = new AbortController();
		const seen = await run(c, async () => {
			const running = Promise.all(both.map((each) => submit(c, each, held))).finally(() => settled.abort());
			try {
				assert.equal(await waitingOnLock(runtime, { count: both.length, signal: settled.signal }), true);
				assert.equal(calls.length, 0, "both wait at admission before either mails");
			} finally {
				release.resolve();
				await holder;
			}
			return (await running).map((r) => r.status);
		}).finally(() => release.resolve());
		assert.deepEqual({ statuses: seen.result }, c.expected.result);
		assert.equal(seen.fresh.length, c.expected.state.new_access_requests);
		assert.equal(sent.size, c.expected.state.provider_emails_sent);
		assert.equal(new Set(calls.map((call) => call.key)).size, c.expected.state.distinct_provider_idempotency_keys);
		assert.deepEqual(
			calls.map((call) => call.key),
			[`early-access/${seen.fresh[0]!.id}`, `early-access/${seen.fresh[0]!.id}`],
		);
		assert.deepEqual(calls[0]!.payload, calls[1]!.payload);
		assert.equal(seen.fresh[0]!.mail_id, "mail-1");
		assert.deepEqual(await submit(c, { kind, fields }, undefined, configuration), {
			status: "received",
		});
		assert.equal(calls.length, 2, "the saved receipt stops a third call");
	},
	"operator CSV export": async (c) => {
		assert.equal(c.action.operation, "marketing.exportAccessRequests");
		await given(c);
		const url = database.logins.runtime.url.href;
		const directory = await mkdtemp(join(tmpdir(), "early-access-"));
		const file = join(directory, "requests.csv");
		try {
			const { value, tables } = await touched(admin, () => recorded(admin, () => exportCommand([file], url)));
			assert.deepEqual(value.value, { code: 0, out: "Early access requests exported.\n", err: "" });
			assert.deepEqual([value.added, tables], [NOTHING, []]);
			assert.equal(await readFile(file, "utf8"), c.expected.result.csv);
			const { state } = c.expected;
			assert.equal(((await stat(file)).mode & 0o7777).toString(8).padStart(4, "0"), state.output_file_mode);
			await admin.execute(sql`DELETE FROM early_access_request WHERE kind='network'`);
			assert.equal((await exportCommand([file], url)).code, 1, "an existing file is never overwritten");
			assert.equal(await readFile(file, "utf8"), c.expected.result.csv);
			assert.equal((await exportCommand([], url)).out.split("\r\n").length, 3);
			assert.equal(await noPublicExport("alex@example.test"), state.public_export_endpoint);
		} finally {
			await rm(directory, { recursive: true });
		}
		assert.equal(c.expected.event, null);
	},
	"anonymous CSV export denied": async (c) => {
		assert.equal(c.action.operation, "marketing.exportAccessRequests");
		await submit({ ...CASES.get("the planter form stores and emails every field")! });
		const before = await stored();
		assert.equal(await noPublicExport("alex@example.test"), c.expected.state.public_export_endpoint);
		assert.equal(c.expected.error_code, "not_found");
		const anonymous = await exportCommand([]);
		assert.notEqual(anonymous.code, 0);
		assert.equal(anonymous.out, "");
		assert.deepEqual(await stored(), before);
		assert.deepEqual([c.expected.result, c.expected.event], [{}, null]);
	},
	"scheduled retention boundaries": retention,
	"scheduled retention replay": retention,
	"anonymous retention denied": async (c) => {
		assert.equal(c.action.operation, "marketing.expireAccessRequests");
		await given(CASES.get("scheduled retention boundaries")!);
		const { tables, value } = await touched(admin, () =>
			recorded(admin, async () => {
				const refused = [];
				for (const authorization of [undefined, "Bearer wrong", SECRET]) {
					const answer = await requestRetention(authorization);
					refused.push([answer.status, await answer.json()]);
				}
				process.env.CRON_SECRET = "";
				const closed = await requestRetention("Bearer ");
				process.env.CRON_SECRET = SECRET;
				refused.push([closed.status, await closed.json()]);
				return refused;
			}),
		);
		assert.equal(c.expected.error_code, "access_denied");
		assert.deepEqual(value.value, [
			[401, { status: "unauthorized" }],
			[401, { status: "unauthorized" }],
			[401, { status: "unauthorized" }],
			[503, { status: "unavailable" }],
		]);
		assert.deepEqual([tables, value.added], [[], NOTHING]);
		assert.deepEqual([c.expected.state, c.expected.result, c.expected.event], [{}, {}, null]);
	},
	"email limit takes precedence over a sent duplicate": (c) => requests(c),
	"email limit takes precedence over a pending retry": (c) => requests(c),
	"pending at exactly 23 hours creates a new request and key": (c) => requests(c),
	"pending beyond 24 hours creates a new request and key": (c) => requests(c),
	"provider acceptance without a stored receipt stays pending": (c) =>
		requests(c, async ({ fresh }) => {
			assert.deepEqual(await submit(c), { status: "received" });
			assert.deepEqual(
				calls.map((call) => call.key),
				[`early-access/${fresh[0]!.id}`, `early-access/${fresh[0]!.id}`],
			);
			assert.equal(sent.size, 1, "the retry is the same provider email");
		}),
};

assert.equal(main.subcases.length, 28);
assert.deepEqual(Object.keys(TABLE).sort(), [...CASES.keys()].sort());
for (const c of CASES.values()) assert.equal(c.clock.now, main.clock.now);

for (const [name, assertCase] of Object.entries(TABLE))
	test(`AC:CASE-ADM-006 ${name}`, async () => {
		await assertCase(CASES.get(name)!);
	});
