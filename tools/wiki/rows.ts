import { readFile } from 'node:fs/promises';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectRow = { [key: string]: Json };
export function object(value: Json): value is ObjectRow { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export async function readJson(path: string): Promise<Json> { return JSON.parse(await readFile(path, 'utf8')); }
export function rows(value: Json, key: string): ObjectRow[] {
  if (!object(value) || !Array.isArray(value[key]) || !value[key].every(object)) throw new Error(`Expected ${key} rows`);
  return value[key];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const articleKeys = ['church_id','content','content_type','created_at','excerpt','id','phase','published_at','read_time_minutes','related_article_slugs','section_id','slug','sort_order','status','title','updated_at'];
export function shape(row: ObjectRow, articles: ObjectRow[], sections: ObjectRow[], seed: boolean): string[] {
  const errors: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) errors.push(message); };
  const keys = seed ? articleKeys : [...articleKeys, 'draft'];
  check(Object.keys(row).sort().join() === keys.sort().join(), 'Row must have exactly the seed article fields plus draft metadata on drafts');
  for (const key of ['content','title','excerpt','slug','id','section_id']) check(typeof row[key] === 'string' && row[key].trim().length > 0, `${key} must be a nonempty string`);
  for (const key of ['created_at','updated_at', ...(seed ? ['published_at'] : [])]) check(typeof row[key] === 'string' && /^\d{4}-\d\d-\d\dT/.test(row[key]) && Number.isFinite(Date.parse(row[key])), `${key} must be an ISO timestamp`);
  check(row.church_id === null, 'church_id must be null');
  check(row.status === (seed ? 'published' : 'draft'), `status must be ${seed ? 'published' : 'draft'}`);
  if (!seed) check(row.published_at === null, 'published_at must be null on drafts');
  check(typeof row.content_type === 'string' && ['guide','reference','overview','tutorial','how_to'].includes(row.content_type), 'Unknown content_type');
  check(Number.isInteger(row.phase) && Number(row.phase) >= 0 && Number(row.phase) <= 6, 'phase must be an integer 0–6');
  check(Number.isInteger(row.sort_order) && Number(row.sort_order) >= 0, 'sort_order must be a nonnegative integer');
  check(Number.isInteger(row.read_time_minutes) && Number(row.read_time_minutes) > 0, 'read_time_minutes must be a positive integer');
  check(typeof row.id === 'string' && uuid.test(row.id), 'id must be a UUID');
  check(typeof row.slug === 'string' && /^[a-z0-9-]+(?:\/[a-z0-9-]+)+$/.test(row.slug), 'slug must be a lowercase section/article path');
  const section = sections.find(s => s.id === row.section_id);
  check(Boolean(section) && typeof row.slug === 'string' && row.slug.startsWith(`${section?.slug}/`), 'section_id must exist and slug must begin with its section path');
  const related = row.related_article_slugs;
  check(Array.isArray(related) && related.every(s => typeof s === 'string' && articles.some(a => a.slug === s)), 'related_article_slugs must name known articles');
  if (seed) return errors;
  const draft = row.draft;
  if (!object(draft)) return [...errors, 'draft must be an object'];
  check(Object.keys(draft).sort().join() === ['backlog_id','tier','closes','approver','replaces_id','sources','claim_check','rulings'].sort().join(), 'draft metadata has missing or unknown fields');
  check(typeof draft.backlog_id === 'string' && draft.backlog_id.length > 0, 'draft.backlog_id is required');
  check(typeof draft.tier === 'string' && ['A','B','C','F'].includes(draft.tier), 'draft.tier must be A, B, C or F');
  check(draft.approver === 'Sebastian' || (draft.tier === 'B' && draft.approver === 'Bryan'), 'approver must be Sebastian, or Bryan for tier B');
  for (const key of ['closes','rulings']) check(Array.isArray(draft[key]) && draft[key].every(x => typeof x === 'string'), `draft.${key} must be a string list`);
  const existing = articles.find(a => a.id === row.id);
  check(draft.replaces_id === null ? !existing && typeof row.id === 'string' && uuid4.test(row.id) : draft.replaces_id === row.id && Boolean(existing), 'New articles need a new UUID v4; edits must retain the existing id in replaces_id');
  check(!articles.some(a => a.slug === row.slug && a.id !== row.id), 'slug already belongs to another article');
  check(Array.isArray(draft.sources) && draft.sources.every(s => object(s) && Object.keys(s).sort().join() === ['claim','url','publisher','quote','accessed','kind'].sort().join() && ['claim','url','publisher','quote','accessed','kind'].every(k => typeof s[k] === 'string' && s[k].length > 0) && typeof s.url === 'string' && /^https?:\/\//.test(s.url) && typeof s.accessed === 'string' && Number.isFinite(Date.parse(s.accessed)) && ['primary','secondary','vendor'].includes(String(s.kind))), 'sources must contain claim, url, publisher, quote, accessed and kind (primary|secondary|vendor)');
  const cc = draft.claim_check;
  check(object(cc) && Object.keys(cc).sort().join() === ['status','reviewer','notes'].sort().join() && ['status','reviewer','notes'].every(k => typeof cc[k] === 'string'), 'claim_check must contain string status, reviewer and notes');
  return errors;
}
