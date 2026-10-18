import { lstat, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../packages/domain/package.json',import.meta.url));
const {z}=require('zod');
const operations=z.enum(['migration-inspect','migration-apply','migration-adopt','backup-check']);
const control=z.strictObject({version:z.literal(1),host:z.string(),uid:z.number().int(),environment:z.literal('development'),
  context:z.enum(['migration-operator','restricted-backup']),expiresAt:z.iso.datetime(),
  operations:z.array(operations).min(1),database:z.strictObject({host:z.string(),name:z.string(),role:z.string(),schema:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)}).optional()});
export async function readPrivateJson(path) {
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)!==0||info.size>1024*1024)throw Error('unsafe_control_file');
  return JSON.parse(await readFile(path,'utf8'));
}
export async function loadControl(path,operation) {
  const c=control.parse(await readPrivateJson(path));
  if(c.host!==hostname()||c.uid!==process.getuid()||Date.parse(c.expiresAt)<=Date.now()||!c.operations.includes(operation)||process.env.NODE_ENV==='production')throw Error('operator_unavailable');
  if((operation==='backup-check')!==(c.context==='restricted-backup'))throw Error('operator_context_mismatch');
  return c;
}
export function developmentConnection(c,raw) {
  const u=new URL(raw);
  if(!c.database||u.hostname!=='ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech'||u.hostname!==c.database.host||decodeURIComponent(u.username)!==c.database.role||decodeURIComponent(u.pathname.slice(1))!==c.database.name)throw Error('target_mismatch');
  u.searchParams.set('sslmode','verify-full');return u.href;
}
