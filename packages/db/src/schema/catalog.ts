import assert from 'node:assert/strict';
import type { PoolClient, Pool } from 'pg';
import { z } from 'zod';

const table = z.object({ name: z.string(), columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean() })),
  primary_key: z.array(z.string()), foreign_keys: z.array(z.object({ columns: z.array(z.string()), references: z.object({ table: z.string(), columns: z.array(z.string()) }), on_delete: z.string() })) });
const catalog = z.object({ tables: z.array(table) });
const sort = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
const typeNames: Record<string, string> = { int8: 'bigint', int4: 'integer', bool: 'boolean' };
const deletionCodes: Record<string, string> = { restrict: 'r', no_action: 'a', cascade: 'c', set_null: 'n', set_default: 'd' };

// Inspect the fully migrated schema, never regenerated historical SQL. The same
// comparison serves the CLI and the real database baseline regression.
export async function assertCurrentCatalog(db: Pool | PoolClient, schema: string, raw: unknown): Promise<void> {
  const expected = catalog.parse(raw);
  const columns = await db.query<{ table_name: string; column_name: string; udt_name: string; is_nullable: string }>(
    `SELECT c.table_name,c.column_name,c.udt_name,c.is_nullable FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema=$1 AND t.table_type='BASE TABLE'`, [schema]);
  assert.deepEqual(sort(columns.rows.map(c => [c.table_name, c.column_name, typeNames[c.udt_name] ?? c.udt_name, c.is_nullable === 'YES'])),
    sort(expected.tables.flatMap(t => t.columns.map(c => [t.name, c.name, c.type, c.nullable]))), 'Migrated columns/types/nullability differ from target.json');
  const keys = await db.query<{ table_name: string; columns: string[] }>(`SELECT c.relname AS table_name,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY v(attnum,position)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=v.attnum ORDER BY v.position) AS columns
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND k.contype='p'`, [schema]);
  assert.deepEqual(sort(keys.rows), sort(expected.tables.filter(t => t.primary_key.length).map(t => ({ table_name: t.name, columns: t.primary_key }))), 'Migrated primary keys differ from target.json');
  const fks = await db.query(`SELECT c.relname AS table_name,r.relname AS referenced_table,
    ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(attnum,position) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.attnum ORDER BY k.position) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(attnum,position) JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.attnum ORDER BY k.position) AS referenced_columns,
    f.confdeltype AS deletion FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class r ON r.oid=f.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND f.contype='f'`, [schema]);
  assert.deepEqual(sort(fks.rows), sort(expected.tables.flatMap(t => t.foreign_keys.map(f => ({ table_name: t.name, referenced_table: f.references.table,
    columns: f.columns, referenced_columns: f.references.columns, deletion: deletionCodes[f.on_delete.toLowerCase()] })))), 'Migrated foreign keys/deletion actions differ from target.json');
}
