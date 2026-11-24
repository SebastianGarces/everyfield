import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { teamsWriter } from "../../../packages/domain/src/teams/index.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const NAMES = [
	"Leadership",
	...Array.from({ length: 8 }, (_, i) => `Neighborhood welcome, hospitality and newcomer follow-up ministry ${i + 1}`),
	"Counterintergenerationaldiscipleshipmultiplicationministry",
];

async function up() {
	const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
	const env = await openSeedEnvironment(people.origin);
	const { admin, runtime } = env;
	const session = await admin.execute(sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id = s.user_id
		WHERE u.email = 'owner@people-preview.example.test' ORDER BY s.created_at DESC LIMIT 1`);
	const ctx = { session: session.rows[0]!.id, selected: { kind: "plant", id: people.plant } } as never;
	for (const name of NAMES) {
		const r = await gatedTransaction(runtime, (tx) =>
			teamsWriter.create(tx as never, ctx, { requestKey: randomUUID(), input: { name } }),
		);
		if (r.status !== "ok") throw Error(`create ${name}: ` + JSON.stringify(r));
	}
	await admin.execute(sql`UPDATE team SET template_key = 'leadership'
		WHERE plant_id = ${people.plant}::uuid AND name = 'Leadership'`);
	const fixture = writeFixture("teams", env.schema, { names: NAMES });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("teams")));
else throw Error("Usage: seed.mts up | down");
