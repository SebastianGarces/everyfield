import { z } from 'zod';
import type { Starter } from './starter.ts';
import { safeMdx } from './content.ts';

function source(starter:Starter,path:string) {
  const row=starter.sources.find(s=>s.path==='docs/reference/'+path);
  if(!row)throw Error('source_unavailable');
  return {...row};
}
export function readRubricManifest(starter:Starter,input:unknown) {
  const kind=z.enum(['plant','network']).parse(input);
  if(kind==='plant')return {kind,original:source(starter,'rubric-v1.md'),adapter:source(starter,'plant-operational-adapter-v1.json')};
  return {kind,original:source(starter,'network-rubric-v1.json'),adapter:null};
}
export function auditLanguage(starter:Starter) {
  const manifest=z.object({derived_copy_drift:z.array(z.object({id:z.string(),source:z.string(),current_rule:z.string(),disposition:z.string()})),
    known_source_limits:z.array(z.string())}).parse(JSON.parse(source(starter,'manifest.json').body));
  const payload=z.object({articles:z.array(z.object({id:z.uuid(),slug:z.string(),content:z.string()}))})
    .parse(JSON.parse(source(starter,'bootstrap/global-seed-payload.json').body));
  const slugs=new Set(payload.articles.map(a=>a.slug));
  return {unsafeArticleIds:payload.articles.filter(a=>!safeMdx(a.content,slugs)).map(a=>a.id),
    knownDrift:manifest.derived_copy_drift,sourceLimits:manifest.known_source_limits,
    semanticEvaluation:'not_run',activationApproved:false} as const;
}
