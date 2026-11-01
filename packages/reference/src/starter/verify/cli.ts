// Installs and activates the pinned Wiki (approved.ts) on one database. Rerunning it is a no-op once that version is active.
//   development: corepack pnpm --filter @everyfield/reference wiki:install [--schema <ui_schema>]
//   production (operator only): corepack pnpm --filter @everyfield/reference wiki:install --production --operator <account-id>
// Development targets only the shared development database and provisions a synthetic publisher. Production requires
// both flags and an operator account that already holds the reference_publish grant.
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createDatabase, closeDatabase } from "@everyfield/db/client";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { approvedSource, approvedWiki } from "../manifest/approved.ts";
import { referenceService } from "./service.ts";

const DEVELOPMENT_HOSTS = [
	"ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech",
	"ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech",
];
const PUBLISHER_EMAIL = "wiki-publisher@example.test";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const { values } = parseArgs({
	options: { production: { type: "boolean" }, operator: { type: "string" }, schema: { type: "string" } },
});
let target: URL;
try {
	target = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "");
} catch {
	fail("Set DATABASE_URL. No setting values are printed.");
}
const development = DEVELOPMENT_HOSTS.includes(target.hostname);
if (values.production) {
	if (development) fail("--production names the production database, but DATABASE_URL is the development one.");
	if (!values.operator) fail("--production requires --operator <account-id> with the reference_publish grant.");
	if (values.schema) fail("--schema is for development seed schemas only.");
} else if (!development || process.env.NODE_ENV === "production")
	fail("Refused: without --production this command writes only the shared development database.");
else target.searchParams.set("sslmode", "verify-full");
if (values.schema && !/^ui_[a-f0-9]{16}$/.test(values.schema))
	fail("--schema takes a tests/ui seed schema (ui_<hex>).");
if (values.operator && !/^[0-9a-f-]{36}$/i.test(values.operator)) fail("--operator takes an account id.");

/** The publisher account: the named operator, or in development one synthetic account that holds the grant. */
async function publisher(db: Database): Promise<{ actorId: string; userId: string }> {
	if (values.operator) {
		const selected = await db.execute(sql`SELECT id, auth_user_id FROM account WHERE id = ${values.operator}::uuid`);
		const row = selected.rows[0] as { id: string; auth_user_id: string } | undefined;
		if (!row) fail("No account has that id.");
		return { actorId: row.id, userId: row.auth_user_id };
	}
	const existing = await db.execute(sql`
		SELECT a.id, a.auth_user_id FROM account a JOIN auth_user u ON u.id = a.auth_user_id WHERE u.email = ${PUBLISHER_EMAIL}`);
	const row = existing.rows[0] as { id: string; auth_user_id: string } | undefined;
	if (row) return { actorId: row.id, userId: row.auth_user_id };
	const ids = { actorId: randomUUID(), userId: randomUUID() };
	await db.transaction(async (tx) => {
		await tx.execute(sql`INSERT INTO auth_user(id, email, email_verified, name)
			VALUES (${ids.userId}::uuid, ${PUBLISHER_EMAIL}, true, 'Wiki publisher')`);
		await tx.execute(sql`INSERT INTO account(id, auth_user_id, registration_state, registration_kind)
			VALUES (${ids.actorId}::uuid, ${ids.userId}::uuid, 'active', 'discovery')`);
		await tx.execute(
			sql`INSERT INTO platform_grant(account_id, capability) VALUES (${ids.actorId}::uuid, 'reference_publish')`,
		);
	});
	return ids;
}

const options = values.schema ? `-c search_path=${values.schema},pg_catalog,pg_temp` : undefined;
const db = createDatabase({ connectionString: target.href, max: 4, ...(options ? { options } : {}) });
let sessionId: string | null = null;
try {
	const current = (
		await db.execute(sql`
			SELECT a.activation_number::text AS number, r.release_key FROM reference_activation a
			JOIN reference_release r ON r.id = a.release_id ORDER BY a.activation_number DESC LIMIT 1`)
	).rows[0] as { number: string; release_key: string } | undefined;
	if (current?.release_key === approvedSource.version) {
		console.log(
			JSON.stringify({ activeRelease: current.release_key, activationNumber: current.number, changed: false }),
		);
	} else {
		const operator = await publisher(db);
		// A ten-minute session for this run only, so the service's live-session check holds. Deleted below.
		sessionId = randomUUID();
		await db.execute(sql`INSERT INTO auth_session(id, user_id, token, expires_at)
			VALUES (${sessionId}::uuid, ${operator.userId}::uuid, ${randomBytes(32).toString("hex")}, now() + interval '10 minutes')`);
		const expected = current?.number ?? "0";
		const receipt = await referenceService(db).installApprovedWiki(
			{ ...operator, sessionId },
			{
				release: approvedSource.version,
				manifestSha256: approvedSource.manifestSha256,
				payloadSha256: approvedSource.payloadSha256,
				requestKey: `wiki-install:${approvedSource.version}:${expected}`,
				expectedActivation: expected,
				target: approvedWiki.target,
				kind: "install",
			},
		);
		console.log(JSON.stringify({ ...receipt, previousRelease: current?.release_key ?? null, changed: true }));
	}
} catch (error) {
	const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
	console.error(
		`Wiki install failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}${cause}`,
	);
	process.exitCode = 1;
} finally {
	if (sessionId) await db.execute(sql`DELETE FROM auth_session WHERE id = ${sessionId}::uuid`);
	await closeDatabase(db);
}
