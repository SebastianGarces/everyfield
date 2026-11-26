import { testDatabase, type TestDatabase } from "../../support/test-database.mts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomUUID } from "node:crypto";
import { referenceService } from "../../../packages/reference/src/server.ts";
import type { ReferenceAuthority, ReferenceDependencies } from "../../../packages/reference/src/server.ts";
import { promotion } from "../../../packages/contracts/src/reference/release.ts";
import type { Promotion } from "../../../packages/contracts/src/reference/release.ts";
import { hash, canonical } from "../../../packages/reference/src/hash.ts";
import type { fixture } from "./fixtures.mts";

export type Reviewer = { id: string; user: string; session: string };

export async function promotions(
	from: string | Pick<TestDatabase<never>, "admin" | "close">,
	fixtureOf: (key: string) => ReturnType<typeof fixture>,
) {
	const database = typeof from === "string" ? await testDatabase({ prefix: from, roles: {}, max: 6 }) : from;
	const { admin: db } = database;
	const actor = randomUUID(),
		user = randomUUID(),
		session = randomUUID();
	const artifacts = new Map<string, unknown>();
	const reviews = new Map<string, { actorId: string; by: Reviewer; review: ReferenceAuthority["review"] }>();
	const authorize: ReferenceDependencies["authorize"] = (command) => {
		const saved = reviews.get(command.requestKey);
		return saved
			? {
					...saved,
					session: querySql`EXISTS(SELECT FROM auth_session WHERE id=${querySql.param(saved.by.session)} AND user_id=${querySql.param(saved.by.user)} AND expires_at>clock_timestamp() FOR SHARE)`,
				}
			: null;
	};
	const service = referenceService(db, {
		authorize,
		loadArtifact: async (locator) => artifacts.get(locator),
		policyFor: (key) => fixtureOf(key).policy,
	});
	const publisher: Reviewer = { id: actor, user, session };
	function command(
		key: string,
		expected: string,
		kind: "activate" | "rollback" = "activate",
		{
			requestKey = randomUUID(),
			by = publisher,
			reason = "Synthetic reviewed reference proof",
		}: {
			requestKey?: string;
			by?: Reviewer;
			reason?: string;
		} = {},
	): Promotion {
		const f = fixtureOf(key);
		artifacts.set(key, f.bundle);
		const cmd = promotion.parse({
			kind,
			generationKey: key,
			manifestHash: f.manifestHash,
			expectedActivation: expected,
			requestKey,
			reason,
		});
		reviews.set(cmd.requestKey, {
			actorId: by.id,
			by,
			review: {
				commandDigest: hash(canonical(cmd)),
				approvalHash: hash("synthetic-reviewed:" + f.manifestHash),
				approvalLocator: "synthetic-review:" + cmd.requestKey,
			},
		});
		return cmd;
	}
	async function seed() {
		await db.execute(
			querySql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${querySql.param(user)},${querySql.param(user + "@example.test")},true,'Synthetic')`,
		);
		await db.execute(
			querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${querySql.param(actor)},${querySql.param(user)},'active','discovery')`,
		);
		await db.execute(
			querySql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${querySql.param(session)},${querySql.param(user)},${querySql.param(randomUUID())},now()+interval '1 hour')`,
		);
		await db.execute(
			querySql`INSERT INTO platform_grant(account_id,capability) VALUES(${querySql.param(actor)},'reference_publish')`,
		);
	}
	return {
		database,
		db,
		actor,
		publisher,
		session,
		artifacts,
		reviews,
		authorize,
		service,
		command,
		seed,
	};
}
