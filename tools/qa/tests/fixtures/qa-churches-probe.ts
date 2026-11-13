// T-255: what the two church Owners see on a seeded QA database. Each signs in through the identity service; the probe
// reports the church its session selects, the people the People list read returns there, and that read for the other
// church. qa.test.ts runs it with tsx and the react-server condition and asserts on its JSON.
//
//   DATABASE_URL=<admin URL> QA_ROLE_PASSWORD=<role password> node --conditions=react-server --import tsx qa-churches-probe.ts
import { randomBytes } from "node:crypto";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase } from "../../../../packages/db/src/client.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { createIdentityService } from "../../../../packages/domain/src/identity/index.ts";
import { peopleReader } from "../../../../packages/domain/src/people/index.ts";
import { QA_LOGINS, QA_PASSWORD, QA_ROLES, roleUrl } from "../../qa-guard.ts";

const ORIGIN = "https://qa-probe.everyfield.invalid";
const source = process.env.DATABASE_URL!,
	password = process.env.QA_ROLE_PASSWORD!;
const admin = createDatabase({ connectionString: source, max: 2 });
const runtime = createDatabase({ connectionString: roleUrl(source, QA_ROLES.runtime, password), max: 2 });
const authDb = createDatabase({ connectionString: roleUrl(source, QA_ROLES.auth, password), max: 2 });
let ip = 0;
const identity = createIdentityService({
	db: runtime,
	authDb,
	admissionDb: runtime,
	scheduleDelivery: () => {},
	origin: ORIGIN,
	secret: randomBytes(32).toString("hex"),
	trustedIp: () => `127.0.255.${++ip}`,
	enqueueMail: async () => "",
	diagnostic: () => {},
});
const host = new URL(ORIGIN).host;
const call = (path: string, body?: unknown, cookie?: string) =>
	identity.handle(
		new Request(`${ORIGIN}/api/auth/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { host, origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);

async function signIn(email: string) {
	const r = await call("sign-in/email", { email, password: QA_PASSWORD });
	const cookie = r.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const session = (await (await call("get-session", undefined, cookie)).json()) as { sessionId: string };
	const authority = await RequestActor.resolve(runtime, session.sessionId as never);
	if (!(authority instanceof RequestActor)) throw Error(`actor ${email}: ${JSON.stringify(authority)}`);
	return { sessionId: session.sessionId, authority };
}

const plantOf = async (name: string) =>
	(await admin.execute(sql`SELECT id FROM plant WHERE name=${name}`)).rows[0]!.id as string;
const plants = { harvest: await plantOf("Harvest Point (QA)"), riverside: await plantOf("Riverside (QA)") };

/** Every person the People list read returns for `session` in `plant`, as name and email, or its refusal code. */
async function people(sessionId: string, plant: string) {
	const ctx = { session: sessionId, selected: { kind: "plant", id: plant } } as never;
	const reply = (await runtime.transaction((tx) =>
		peopleReader.listPeople(tx as never, ctx, { page: 1, limit: 100 } as never),
	)) as {
		status: string;
		value?: { items: { displayName: string; email: string | null }[] };
		error?: { code: string };
	};
	if (reply.status !== "ok") return { refused: reply.error?.code ?? reply.status };
	return reply
		.value!.items.map((p) => ({ name: p.displayName, email: p.email }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

const out: Record<string, unknown> = {};
try {
	for (const [login, own, other] of [
		["owner", plants.harvest, plants.riverside],
		["riverside", plants.riverside, plants.harvest],
	] as const) {
		const who = await signIn(QA_LOGINS[login]);
		const selected = who.authority.actor.context.owner as { kind: string; id: string };
		const names = await admin.execute(sql`SELECT name FROM plant WHERE id=${selected.id}`);
		out[login] = {
			context: { kind: who.authority.actor.context.kind, selected: selected.kind, church: names.rows[0]?.name ?? null },
			people: await people(who.sessionId, own),
			other: await people(who.sessionId, other),
		};
	}
	console.log(JSON.stringify(out));
} finally {
	await closeDatabase(runtime);
	await closeDatabase(authDb);
	await closeDatabase(admin);
}
