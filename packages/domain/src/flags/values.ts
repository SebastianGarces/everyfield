import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { z } from "zod";
import { liveAccess, liveRead, type RequestActor } from "../access/index.ts";
import { registry, type Registry } from "./registry.ts";

type Db = Pick<Transaction, "execute">;

export const GLOBAL_TENANT = "00000000-0000-0000-0000-000000000000";
const SCOPES = ["account", "workspace", "global"] as const;
type ScopeKind = (typeof SCOPES)[number];

const storedValue = z.object({ name: z.string(), scope: z.enum(SCOPES), value: z.boolean() });

class FlagValues<R extends Registry = typeof registry> {
	readonly #declared: R;
	readonly #stored: ReadonlyMap<string, boolean>;
	constructor(declared: R, stored: readonly z.infer<typeof storedValue>[]) {
		this.#declared = declared;
		this.#stored = new Map(stored.map((row) => [`${row.scope}:${row.name}`, row.value]));
	}

	value(name: keyof R & string): boolean {
		for (const scope of SCOPES) {
			const stored = this.#stored.get(`${scope}:${name}`);
			if (stored !== undefined) return stored;
		}
		const declared = this.#declared[name];
		if (!declared) throw Error(`flag_not_registered: ${name}`);
		return declared.default;
	}
}

export async function readFlags<R extends Registry = typeof registry>(
	db: Db,
	authority: RequestActor | null,
	declared: R = registry as unknown as R,
): Promise<FlagValues<R>> {
	const scopes: SQL[] = [sql`f.tenant_id=${GLOBAL_TENANT}::uuid`];
	let account: string | null = null;
	if (authority) {
		account = authority.actor.accountId;
		const access = liveAccess(authority);
		if (access.owner.kind !== "account")
			scopes.push(sql`(f.tenant_id=${access.owner.id}::uuid AND ${liveRead(access)})`);
		scopes.push(
			sql`(f.tenant_id=${account}::uuid AND ${liveRead({ session: authority.session, owner: { kind: "account", id: authority.actor.accountId } })})`,
		);
	}
	const { rows } = await db.execute(sql`SELECT f.name,
 CASE WHEN f.tenant_id=${GLOBAL_TENANT}::uuid THEN 'global' WHEN f.tenant_id=${account}::uuid THEN 'account' ELSE 'workspace' END AS scope,
 f.value FROM feature_flag f
 WHERE f.value IS NOT NULL AND f.name=ANY(${sql.param(Object.keys(declared))}::text[]) AND (${sql.join(scopes, sql` OR `)})`);
	return new FlagValues(declared, z.array(storedValue).parse(rows));
}

export type FlagScope = { kind: "global" } | { kind: "workspace"; id: string } | { kind: "account"; id: string };
export type FlagOperator = string | { cause: string };

const scopeTenants: Record<ScopeKind, readonly string[]> = {
	global: ["global"],
	workspace: ["plant", "organization"],
	account: ["account"],
};

export async function setFlag<R extends Registry = typeof registry>(
	db: Db,
	change: { flag: keyof R & string; scope: FlagScope; value: boolean | null; operator: FlagOperator },
	declared: R = registry as unknown as R,
) {
	const { flag, scope, value } = change;
	if (!Object.hasOwn(declared, flag)) throw Error(`flag_not_registered: ${flag}`);
	const account = typeof change.operator === "string" ? z.uuid().parse(change.operator) : null;
	const cause = typeof change.operator === "string" ? null : z.string().min(1).parse(change.operator.cause);
	const tenant = scope.kind === "global" ? GLOBAL_TENANT : z.uuid().parse(scope.id);
	const { rows } = await db.execute(sql`WITH scope AS (
  SELECT t.id FROM tenant t WHERE t.id=${tenant}::uuid AND t.kind=ANY(${sql.param(scopeTenants[scope.kind])}::text[])
), prior AS (
  SELECT f.id,f.value FROM feature_flag f JOIN scope s ON f.tenant_id=s.id WHERE f.name=${flag} FOR UPDATE OF f
), updated AS (
  UPDATE feature_flag f SET value=${value}::boolean FROM prior p
  WHERE f.id=p.id AND p.value IS DISTINCT FROM ${value}::boolean RETURNING f.id,p.value AS before,f.value AS after
), inserted AS (
  INSERT INTO feature_flag (name,tenant_id,value) SELECT ${flag},s.id,${value}::boolean FROM scope s
  WHERE ${value}::boolean IS NOT NULL AND NOT EXISTS(SELECT FROM prior)
  ON CONFLICT (tenant_id,name) DO NOTHING RETURNING id,NULL::boolean AS before,value AS after
), changed AS (SELECT * FROM updated UNION ALL SELECT * FROM inserted), audit AS (
  INSERT INTO audit_event (tenant_id,actor_id,system_cause,action,kind,subject_type,subject_id,before_value,after_value,metadata)
  SELECT ${tenant}::uuid,${account}::uuid,${cause}::text,'flags.changed','edit','feature_flag',c.id,
   jsonb_build_object('value',c.before),jsonb_build_object('value',c.after),
   jsonb_build_object('flag',${flag}::text,'scope',${scope.kind}::text) FROM changed c RETURNING 1
) SELECT EXISTS(SELECT FROM scope) AS found`);
	if (!z.object({ found: z.boolean() }).parse(rows[0]).found) throw Error(`flag_scope_unavailable: ${scope.kind}`);
}
