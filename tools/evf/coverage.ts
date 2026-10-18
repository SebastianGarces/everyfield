import { fail } from './lib.ts';

export type TestResult = {name:string;status:'passed'|'failed'|'skipped';annotations?:string[]};
export type Coverage = {missing:string[];duplicates:Array<{caseId:string;tests:string[]}>};
const marker = /(?:^|[^A-Za-z0-9_-])AC:([A-Za-z0-9_-]+)(?=$|[^A-Za-z0-9_-])/g;
export function caseGrep(ids:string[]):string {
 return ids.length?`AC:(?:${ids.map(id=>id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})(?=$|[^A-Za-z0-9_-])`:'(?!)';
}
/** The tests array of one check's report; malformed reports fail. */
export function testsOf(raw:unknown):unknown[] {
 if(!raw||typeof raw!=='object'||!('tests' in raw)||!Array.isArray(raw.tests))fail('Test results must contain a tests array.');
 return raw.tests;
}
/** True when any test name or annotation in the report names a case with AC:<case-id>. */
export function hasCaseMarkers(raw:unknown):boolean {
 return testsOf(raw).some(t=>!!t&&typeof t==='object'&&[(t as TestResult).name,...((t as TestResult).annotations??[])].some(text=>typeof text==='string'&&[...text.matchAll(marker)].length>0));
}
/** A test can cover many case IDs. Failed/skipped tests never satisfy coverage. */
export function caseCoverage(expected:string[],raw:unknown):Coverage {
 if(!raw||typeof raw!=='object'||!('tests' in raw)||!Array.isArray(raw.tests))fail('Test results must contain a tests array.');
 const by=new Map<string,Set<string>>();
 for(const t of raw.tests){
  if(!t||typeof t.name!=='string'||!['passed','failed','skipped'].includes(t.status)||(t.annotations!==undefined&&(!Array.isArray(t.annotations)||t.annotations.some((a:unknown)=>typeof a!=='string'))))fail('Malformed test result. Expected name, status and optional string annotations.');
  if(t.status!=='passed')continue;
  for(const text of [t.name,...(t.annotations??[])])for(const match of text.matchAll(marker)){
   const tests=by.get(match[1])??new Set<string>();tests.add(t.name);by.set(match[1],tests);
  }
 }
 return {missing:expected.filter(id=>!by.has(id)),duplicates:expected.flatMap(caseId=>{const tests=[...(by.get(caseId)??[])];return tests.length>1?[{caseId,tests}]:[];})};
}
