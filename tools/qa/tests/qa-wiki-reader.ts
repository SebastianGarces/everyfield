// OPS-127 test helper: opens Wiki articles as the QA owner through the Wiki domain reader, the code the Wiki screen
// calls, and prints what it returns as JSON. The test runs it in its own process because the domain needs the
// react-server condition:
//
//   DATABASE_URL=<admin URL> QA_ROLE_PASSWORD=<seed password> \
//     node --conditions=react-server --import tsx tools/qa/tests/qa-wiki-reader.ts '<requests JSON>'
//
// Each request is { articleId, source? }. The helper opens a session for the owner, reads as the seed's runtime login
// and removes the session again. It never prints a connection string.
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { QA_LOGINS, QA_ROLES, roleUrl } from "../qa-guard.ts";

const source = process.env.DATABASE_URL!;
const admin = createDatabase({ connectionString: source, max: 1 });
const runtime = createDatabase({
	connectionString: roleUrl(source, QA_ROLES.runtime, process.env.QA_ROLE_PASSWORD!),
	max: 1,
});
const session = randomUUID();
try {
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		SELECT ${session}::uuid, id, ${randomUUID()}, clock_timestamp()+interval '1 hour' FROM auth_user WHERE email=${QA_LOGINS.owner}`);
	const actor = await RequestActor.resolve(runtime, session as never);
	if (!(actor instanceof RequestActor)) throw Error(`owner actor: ${JSON.stringify(actor)}`);
	const wiki = createWikiProducer();
	const out = [];
	for (const request of JSON.parse(process.argv[2]!) as unknown[])
		out.push(await wiki.getArticle(runtime, actor, request));
	console.log(JSON.stringify(out));
} finally {
	await admin.execute(sql`DELETE FROM auth_session WHERE id=${session}::uuid`);
	await closeDatabase(runtime);
	await closeDatabase(admin);
}
