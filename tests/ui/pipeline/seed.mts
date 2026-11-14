// Seeds the organization pipeline example (WP-101) on the shared tests/ui seed environment (tests/ui/seed-env.mts):
// Grace Austin, a sending church, with Owner Dana Brooks, Admin Luis Ortega and Members Ana Ruiz (directs the
// residency, responsible for Casey Lee) and Ben Carter (responsible for no one); and Hill Country Network, with Owner
// Ruth Calder and its own pipeline. Grace Austin's pipeline: Jordan Reyes, placed in Potential leader more than six
// months ago and never moved; Casey Lee, moved to Apprentice two weeks ago, with a note from Ana; Sam Patel, placed a
// month ago. Hill Country Network's: Morgan Diaz. Accounts sign up through the identity service; placements, the move,
// the note and the residency program go through the native pipeline and program writers, then each placement and move
// is dated relative to the database clock. Organizations and their seats are raw rows: no public write creates them.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/pipeline/seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/pipeline/seed.mts down
//
// `up` writes every seat's session cookie, the organization ids and the people's ids to $PIPELINE_UI_FIXTURE (default
// /tmp/everyfield-pipeline-ui.json). Every account's password is in PASSWORD below.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { pipelineWriter, readPipelineBoard } from "../../../packages/domain/src/organizations/pipeline.ts";
import { programWriter } from "../../../packages/domain/src/organizations/programs.ts";
import { RESIDENCY_TEMPLATE } from "../../../packages/contracts/src/organizations/programs.ts";
import { randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const PASSWORD = "Pipeline-preview-pass-1";
type OrgKind = "sending_church" | "sending_network";
type Account = { cookie: string; accountId: string; sessionId: string; email: string };
type Database = Awaited<ReturnType<typeof openSeedEnvironment>>["admin"];

function ok<T>(reply: { status: string; value?: T; refusal?: unknown }, what: string): T {
	if (reply.status !== "ok") throw Error(`${what}: ${JSON.stringify(reply.refusal)}`);
	return reply.value as T;
}

/** The example's accounts, organizations and pipelines in the schema `admin` and `runtime` are pinned to. */
export async function seedPipelineExample(env: {
	admin: Database;
	runtime: Database;
	authDb: Database;
	secret: string;
	origin: string;
	address: (n: number) => string;
}) {
	const { admin, runtime, authDb, secret, origin } = env;
	let ip = 1;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => env.address(ip),
		enqueueMail: async () => {},
		diagnostic: () => {},
	});
	const host = new URL(origin).host;
	const call = async (path: string, body?: unknown, cookie?: string) =>
		identity.handle(
			new Request(`${origin}/api/auth/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { host, origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	const tag = randomUUID().slice(0, 8);

	/** A signed-in active organization account. */
	async function account(name: string, kind: OrgKind, organizationName: string): Promise<Account> {
		ip++;
		const email = `${name.toLowerCase().replace(/\W+/g, ".")}.${tag}@pipeline-preview.example.test`;
		const r = await call("register", {
			kind,
			name,
			email,
			password: PASSWORD,
			requestKey: randomUUID(),
			organizationName,
		});
		if (!r.ok) throw Error(`register ${email}: ${r.status} ${await r.text()}`);
		await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
		await admin.execute(
			sql`UPDATE account SET registration_state='active' WHERE auth_user_id=(SELECT id FROM auth_user WHERE email=${email})`,
		);
		const signedIn = await call("sign-in/email", { email, password: PASSWORD });
		if (!signedIn.ok) throw Error(`sign in ${email}: ${signedIn.status}`);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; ");
		const session = (await (await call("get-session", undefined, cookie)).json()) as {
			status: string;
			accountId: string;
			sessionId: string;
		};
		if (session.status !== "active") throw Error(`session ${email}: ${session.status}`);
		return { cookie, accountId: session.accountId, sessionId: session.sessionId, email };
	}

	/** An organization row and its seats, raw: no public write creates either. Returns the seat ids by account. */
	async function organization(name: string, kind: OrgKind, seats: [Account, "owner" | "admin" | "member"][]) {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
			VALUES(${id},${kind},${name},'America/Chicago',1)`);
		const seatIds = new Map<string, string>();
		for (const [a, role] of seats) {
			const r = await admin.execute(sql`INSERT INTO seat(account_id,organization_id,role,accepted_at)
				VALUES(${a.accountId},${id},${role},clock_timestamp()) RETURNING id`);
			seatIds.set(a.accountId, String(r.rows[0]!.id));
		}
		return { id, seatIds };
	}

	const dana = await account("Dana Brooks", "sending_church", "Grace Austin");
	const luis = await account("Luis Ortega", "sending_church", "Grace Austin");
	const ana = await account("Ana Ruiz", "sending_church", "Grace Austin");
	const ben = await account("Ben Carter", "sending_church", "Grace Austin");
	const ruth = await account("Ruth Calder", "sending_network", "Hill Country Network");
	const grace = await organization("Grace Austin", "sending_church", [
		[dana, "owner"],
		[luis, "admin"],
		[ana, "member"],
		[ben, "member"],
	]);
	const hill = await organization("Hill Country Network", "sending_network", [[ruth, "owner"]]);

	const authority = (a: Account) => RequestActor.resolve(runtime, a.sessionId as never) as Promise<RequestActor>;
	const stages = async (a: Account) =>
		Object.fromEntries(
			ok(await readPipelineBoard(runtime, await authority(a), {}), "board").stages.map((s) => [s.label, s.id]),
		) as Record<string, string>;
	const add = async (a: Account, displayName: string, stageId: string, responsible: string | null) => {
		const personId = randomUUID();
		ok(
			await pipelineWriter.addPerson(runtime, await authority(a), {
				personId,
				displayName,
				email: null,
				responsibleSeatId: responsible,
				stageId,
			}),
			`add ${displayName}`,
		);
		return personId;
	};
	const g = await stages(dana);
	const jordan = await add(dana, "Jordan Reyes", g["Potential leader"]!, null);
	const casey = await add(dana, "Casey Lee", g["Potential leader"]!, grace.seatIds.get(ana.accountId)!);
	const sam = await add(dana, "Sam Patel", g["Potential leader"]!, null);
	ok(
		await pipelineWriter.movePerson(runtime, await authority(dana), {
			personId: casey,
			expectedRevision: "1",
			stageId: g.Apprentice!,
			reason: "Started the apprenticeship with Ana.",
		}),
		"move Casey",
	);
	ok(
		await pipelineWriter.addNote(runtime, await authority(ana), {
			personId: casey,
			noteId: randomUUID(),
			body: "Casey is steady with the youth group; we talked through the Austin plant timeline.",
		}),
		"note",
	);
	const morgan = await add(ruth, "Morgan Diaz", (await stages(ruth))["Potential leader"]!, null);
	// Ana directs the residency: an unpublished draft of the residency template.
	ok(
		await programWriter.createProgram(runtime, await authority(dana), {
			programId: randomUUID(),
			kind: "residency",
			name: "Church planting residency",
			directorSeatId: grace.seatIds.get(ana.accountId)!,
			plan: {
				rhythm: "weekly",
				expectedMonths: 18,
				stages: RESIDENCY_TEMPLATE.stages,
				milestones: RESIDENCY_TEMPLATE.milestones.map((title) => ({
					lineage: randomUUID(),
					title,
					description: null,
					handsOn: false,
				})),
				readings: [],
			},
		}),
		"residency",
	);
	// Each placement and move dated as the example has it, relative to the database clock.
	const age = (person: string, days: number, first: boolean) =>
		admin.execute(sql`UPDATE audit_event a SET occurred_at=clock_timestamp()-make_interval(days=>${days})
			FROM pipeline_stage_move m JOIN pipeline_person pp ON pp.id=m.pipeline_person_id
			WHERE a.id=m.id AND pp.person_id=${person} AND (m.from_stage_id IS NULL)=${first}`);
	await age(jordan, 190, true);
	await age(casey, 100, true);
	await age(casey, 14, false);
	await age(sam, 30, true);
	await age(morgan, 200, true);

	const seat = (a: Account) => ({ cookie: a.cookie, accountId: a.accountId, email: a.email });
	return {
		origin,
		password: PASSWORD,
		seats: { dana: seat(dana), luis: seat(luis), ana: seat(ana), ben: seat(ben), hill: seat(ruth) },
		organizations: { grace: grace.id, hill: hill.id },
		people: { jordan, casey, sam, morgan },
	};
}

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const data = await seedPipelineExample({ ...env, origin, address: (n) => env.loopback("pipeline", n) });
	const fixture = writeFixture("pipeline", env.schema, data);
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("pipeline")));
else if (action !== undefined) throw Error("Usage: seed.mts up <preview-url> | down");
