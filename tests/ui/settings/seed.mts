// Seeds the Brand kit asset run (WP-104/ui slice 2) after the People seed: the church plant starts with no brand kit,
// so every slot is empty, and the church has its real name. The People seed's Owner and Member sign in.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/settings/seed.mts up
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/settings/seed.mts down
//
// `up` reads the People fixture and writes $SETTINGS_UI_FIXTURE (default /tmp/everyfield-settings-ui.json).
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

async function up() {
	const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
	const env = await openSeedEnvironment(people.origin);
	await env.admin.execute(sql`DELETE FROM church_brand_kit WHERE tenant_id = ${people.plant}::uuid`);
	const named = await env.admin.execute(sql`SELECT name FROM plant WHERE id = ${people.plant}::uuid`);
	const fixture = writeFixture("settings", env.schema, {
		origin: people.origin,
		plant: people.plant,
		churchName: named.rows[0]!.name,
		owner: people.owner,
		member: people.member,
	});
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("settings")));
else throw Error("Usage: seed.mts up | down");
