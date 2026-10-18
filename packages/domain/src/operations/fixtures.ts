import * as tables from "@everyfield/db/tables";
import { and, eq, sql } from "@everyfield/db/query";
import { alias } from "@everyfield/db/query";
import type { Database } from "@everyfield/db/client";
import { z } from "zod";
const account_a = alias(tables.account, "a");

const auth_user_u = alias(tables.auth_user, "u");
const fixture = z.strictObject({
	account: z.uuid(),
	user: z.uuid(),
	email: z.email().regex(/@example\.test$/),
	password: z.string().min(16).max(128),
});
const config = z.strictObject({
	enabled: z.boolean(),
	environment: z.enum(["development", "preview"]),
	target: z.strictObject({
		database: z.string().min(1),
		role: z.string().min(1),
		schema: z.string().regex(/^(wp050_|evf_fixture_)[a-f0-9]{32}$/),
	}),
	fixtures: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/), fixture),
});
export type FixtureConfig = z.infer<typeof config>;
// Local/managed-development transport only. A trusted host adapter supplies this
// allowlist from its fresh synthetic seed. No client role/environment is accepted.
// This module is absent from the production HTTP import graph.
export function createFixtureSwitcher(
	db: Database,
	input: FixtureConfig,
	signIn: (credentials: { email: string; password: string }) => Promise<Response>,
) {
	const c = config.parse(input);
	return async (command: unknown): Promise<Response> => {
		const denied = () =>
			Response.json({ code: "unavailable" }, { status: 404, headers: { "cache-control": "private, no-store" } });
		if (
			!c.enabled ||
			process.env.EVERYFIELD_FIXTURES_ENABLED !== "1" ||
			process.env.EVERYFIELD_ENVIRONMENT !== c.environment ||
			process.env.NODE_ENV === "production" ||
			process.env.VERCEL_ENV === "production"
		)
			return denied();
		const parsed = z.strictObject({ fixture: z.string() }).safeParse(command);
		if (!parsed.success) return denied();
		const selected = c.fixtures[parsed.data.fixture];
		if (!selected) return denied();
		const identity = await db.execute<{ database: string; role: string; schema: string }>(
			sql`SELECT current_database() AS database,current_user AS role,current_schema() AS schema`,
		);
		const actual = identity.rows[0];
		if (actual?.database !== c.target.database || actual?.role !== c.target.role || actual?.schema !== c.target.schema)
			return denied();
		const current = await db
			.select({ id: account_a.id })
			.from(account_a)
			.innerJoin(auth_user_u, eq(auth_user_u.id, account_a.auth_user_id))
			.where(
				and(
					and(
						and(
							and(eq(account_a.id, selected.account), eq(auth_user_u.id, selected.user)),
							eq(auth_user_u.email, selected.email),
						),
						eq(account_a.registration_state, "active"),
					),
					sql<unknown>`(NOT EXISTS (SELECT (1)  FROM lifecycle_witness  AS w  WHERE (((w .kind = ('account')) AND (w .opaque_subject_id = a .id)) AND (w .state IN (('pending_deletion'), ('purging'), ('purged'))))))`,
				),
			);
		if (current.length !== 1) return denied();
		const result = await signIn({ email: selected.email, password: selected.password });
		if (!result.ok) return denied();
		const headers = new Headers({ "cache-control": "private, no-store" });
		for (const cookie of result.headers.getSetCookie()) headers.append("set-cookie", cookie);
		// Never forward the auth provider's token/user body through the fixture action.
		return Response.json({ switched: true }, { headers });
	};
}
