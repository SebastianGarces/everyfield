// OPS-125 test probe: one private-care call as the QA owner on a seeded quiet database, through the same writer the
// check-in screen calls. It opens a session row for the owner, runs the call, prints the reply as JSON and removes the
// session. Run with tsx and --conditions=react-server; DATABASE_URL names the quiet database.
//   probe.ts '{"op":"history","page":1}'
//   probe.ts '{"op":"correct","request":{...}}'
import { randomBytes } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { QA_LOGINS } from "../qa-guard.ts";

const call = JSON.parse(process.argv[2]!) as { op: "history"; page: number } | { op: "correct"; request: unknown };
const db = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 1 });
try {
	const made = await db.execute(sql`INSERT INTO auth_session(user_id,token,expires_at)
		SELECT id,${randomBytes(16).toString("hex")},now()+interval '1 hour' FROM auth_user WHERE email=${QA_LOGINS.owner}
		RETURNING id`);
	const session = made.rows[0]!.id as string;
	try {
		const actor = await RequestActor.resolve(db, session as never);
		if (!(actor instanceof RequestActor)) throw Error(`owner actor: ${JSON.stringify(actor)}`);
		const care = createPrivateCare();
		const reply =
			call.op === "history"
				? await care.readHistory(db, actor, { page: call.page })
				: await care.correct(db, actor, call.request);
		console.log(JSON.stringify(reply));
	} finally {
		await db.execute(sql`DELETE FROM auth_session WHERE id=${session}`);
	}
} finally {
	await closeDatabase(db);
}
