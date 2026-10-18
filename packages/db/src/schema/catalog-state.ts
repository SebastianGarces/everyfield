import { sql } from "drizzle-orm";
import type { Database, Transaction } from "../client.ts";

function normalize(value: unknown, schema: string): unknown {
	if (typeof value === "string") return value.replaceAll(schema, "<schema>");
	if (Array.isArray(value)) return value.map((item) => normalize(item, schema));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, normalize(item, schema)]),
		);
	return value;
}
const sorted = (rows: unknown[], schema: string) =>
	rows.map((row) => normalize(row, schema)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Read actual definitions, never application rows. Used against isolated migration/generation rehearsals. */
export async function modeledCatalog(db: Database | Transaction, schema: string) {
	const [columns, constraints, indexes, tables, policies] = [
		await db.execute(
			sql`SELECT c.relname AS table_name,a.attnum AS ordinal,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,pg_get_expr(d.adbin,d.adrelid) AS default,a.attidentity AS identity,a.attgenerated AS generated FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=${schema} AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`,
		),
		await db.execute(
			sql`SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,regexp_replace(pg_get_constraintdef(k.oid),' DEFERRABLE( INITIALLY DEFERRED)?$','') AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND k.contype IN ('p','u','f','c','x')`,
		),
		await db.execute(
			sql`SELECT c.relname AS table_name,i.relname AS name,pg_get_indexdef(i.oid) AS definition,x.indisvalid AS valid FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema}`,
		),
		await db.execute(
			sql`SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND c.relkind IN ('r','p')`,
		),
		await db.execute(
			sql`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname=${schema}`,
		),
	];
	return {
		columns: sorted(columns.rows, schema),
		constraints: sorted(constraints.rows, schema),
		indexes: sorted(indexes.rows, schema),
		tables: sorted(tables.rows, schema),
		policies: sorted(policies.rows, schema),
	};
}

/** Objects Kit cannot model have explicit, reviewed expectations beside the Drizzle declarations. */
export async function supplementalCatalog(db: Database | Transaction, schema: string) {
	const [deferred, triggers, functions, roles, acl, defaults, extensions] = [
		await db.execute(
			sql`SELECT c.relname AS table_name,k.conname AS name,k.condeferrable AS deferrable,k.condeferred AS initially_deferred FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND k.contype='f' AND k.condeferrable`,
		),
		await db.execute(
			sql`SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND NOT t.tgisinternal`,
		),
		await db.execute(
			sql`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${schema}`,
		),
		await db.execute(
			sql`SELECT rolname AS name,rolsuper AS superuser,rolinherit AS inherit,rolcreaterole AS create_role,rolcreatedb AS create_database,rolcanlogin AS login,rolbypassrls AS bypass_rls FROM pg_roles WHERE rolname IN ('everyfield_runtime','everyfield_auth','everyfield_cleanup')`,
		),
		await db.execute(sql`WITH permissions AS (
		 SELECT 'table' AS kind,c.relname AS object,coalesce(r.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname=${schema} AND c.relkind IN ('r','p','S')
		 UNION ALL SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',coalesce(r.rolname,'PUBLIC'),x.privilege_type,x.is_grantable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname=${schema}
		 UNION ALL SELECT 'schema','<schema>',coalesce(r.rolname,'PUBLIC'),x.privilege_type,x.is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname=${schema}
		) SELECT * FROM permissions WHERE grantee IN ('PUBLIC','everyfield_runtime','everyfield_auth','everyfield_cleanup')`),
		await db.execute(
			sql`SELECT d.defaclobjtype AS kind,coalesce(r.rolname,'PUBLIC') AS grantee,x.privilege_type,x.is_grantable FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) x LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname=${schema} AND (x.grantee=0 OR r.rolname IN ('everyfield_runtime','everyfield_auth','everyfield_cleanup'))`,
		),
		await db.execute(
			sql`SELECT e.extname AS name,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`,
		),
	];
	return {
		deferred: sorted(deferred.rows, schema),
		triggers: sorted(triggers.rows, schema),
		functions: sorted(functions.rows, schema),
		roles: sorted(roles.rows, schema),
		acl: sorted(acl.rows, schema),
		defaults: sorted(defaults.rows, schema),
		extensions: sorted(extensions.rows, schema),
	};
}
