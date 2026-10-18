import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hash } from './hash.ts';

const source = z.strictObject({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),body:z.string()});
// Literal catalog extraction is frozen with its source bytes. Feature consumers refine their own fields.
const literal = z.record(z.string(),z.unknown());
const artifact = z.strictObject({sources:z.array(source),catalogs:z.strictObject({
  tasks:z.array(literal),teams:z.array(literal),documents:z.array(literal),launch:z.array(literal),
  phases:z.array(z.strictObject({phase:z.number().int().min(0).max(6),name:z.string()})).length(7),
  criteria:z.array(z.strictObject({phase:z.number().int().min(0).max(5),key:z.string()})),
})});
export type Starter = z.infer<typeof artifact>;
export async function loadStarter(): Promise<Starter> {
  const freeze = JSON.parse(await readFile(new URL('freeze.json',import.meta.url),'utf8'));
  const bytes=await readFile(new URL('artifacts.json',import.meta.url));
  if (hash(bytes)!==freeze.artifactSha256) throw Error('reference_artifact_mismatch');
  const result=artifact.parse(JSON.parse(bytes.toString('utf8')));
  for(const s of result.sources) if(hash(s.body)!==s.sha256) throw Error('reference_source_mismatch');
  return result;
}
export async function verifyCheckout(root: URL, expectedCatalogSha256?: string): Promise<{ok:boolean;issues:{code:string;path:string}[]}> {
  // WP-001 deliberately reports catalog identity; consumers must compare their reviewed expectation.
  const {verifySources}=await import('../verify.mjs');
  const report=await verifySources(fileURLToPath(root));
  const freeze=JSON.parse(await readFile(new URL('freeze.json',import.meta.url),'utf8'));
  const issues=[...report.issues];
  if(report.catalog?.sha256!==(expectedCatalogSha256??freeze.catalogSha256)) issues.push({code:'catalog_digest_mismatch',path:'docs/catalog/index.json'});
  if(report.manifestSha256!==freeze.sourceManifestSha256) issues.push({code:'source_manifest_mismatch',path:'docs/reference/manifest.json'});
  return {ok:issues.length===0,issues};
}
