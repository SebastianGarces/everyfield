import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStarter, verifyCheckout } from '../../../packages/reference/src/starter.ts';

// Existing owned acceptance cases were checked before this cases-first commit.
test('AC:GAP-REF-001 AC:REF-CASE-001 exact original Playbook survives packaging', async () => {
  const starter = await loadStarter();
  const source = starter.sources.find(s => s.path === 'docs/reference/playbook.md');
  assert.equal(source?.sha256, 'd365dd4992156e674f8e67601239fbf97c173074a3ca7e0bc8010aa725205e7a');
  assert.equal(Buffer.byteLength(source!.body), 34025);
});

import { mkdtemp,cp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageCheckout,packageStarter,validateBundle } from '../../../packages/reference/src/bundle.ts';
import { editorDocument,importExtractedText } from '../../../packages/contracts/src/reference/editor.ts';
import { fixture,starter } from './fixtures.mts';

test('INV-reference-catalog: packaging refuses a changed catalog against its reviewed expectation', async()=>{
  const target=await mkdtemp(join(tmpdir(),'wp032-catalog-'));
  try {
    await cp(new URL('../../../docs',import.meta.url),join(target,'docs'),{recursive:true});
    const {verifySources}=await import('../../../packages/reference/verify.mjs');
    const expected=(await verifySources(target)).catalog!.sha256;
    assert.equal((await packageCheckout(pathToFileURL(target+'/'),expected)).filter(e=>e.kind==='article').length,96);
    const index=join(target,'docs/catalog/index.json');
    await writeFile(index,(await readFile(index,'utf8'))+'\n');
    assert.deepEqual(await verifyCheckout(pathToFileURL(target+'/'),expected),{ok:false,issues:[{code:'catalog_digest_mismatch',path:'docs/catalog/index.json'}]});
    await assert.rejects(packageCheckout(pathToFileURL(target+'/'),expected),{message:'catalog_digest_mismatch'});
    const playbook=join(target,'docs/reference/playbook.md');
    await writeFile(playbook,(await readFile(playbook,'utf8')).replace('Launch Playbook','Launch PlaybooK'));
    assert.equal((await verifyCheckout(pathToFileURL(target+'/'),expected)).issues.some(i=>i.code==='hash_mismatch'),true);
  }finally{await rm(target,{recursive:true,force:true});}
});

test('AC:CONTENT50-001 canonical catalogs retain topology, identity and distinct inventories',()=>{
  const entries=packageStarter(starter);
  const counts=Object.fromEntries(['article','section','mail_template','document_template','task_template','ministry_template','launch_inventory','phase','criterion']
    .map(kind=>[kind,entries.filter(e=>e.kind===kind).length]));
  assert.deepEqual(counts,{article:96,section:21,mail_template:7,document_template:11,task_template:20,ministry_template:10,launch_inventory:9,phase:7,criterion:19});
  assert.deepEqual(packageStarter(starter),entries);
  assert.deepEqual(starter.catalogs.launch.map(row=>Array.isArray(row.tasks)?row.tasks.length:0),[3,3,2,2,3,3,2,3,2]);
  const {bundle,policy}=fixture();
  assert.deepEqual(validateBundle(bundle,policy),{ok:true,hashIntegrity:true,editorialApproved:true,manifestHash:fixture().manifestHash,blockers:[]});
});

test('AC:GAP-REF-008 exact source integrity never supplies editorial approval',()=>{
  const {bundle,policy,manifestHash}=fixture();
  for(const approved of [true,false])assert.deepEqual(validateBundle(bundle,{...policy,editorial:{approved,originalAvailable:false,conflicts:['known-source-conflict']}}),{
    ok:false,hashIntegrity:true,editorialApproved:false,manifestHash,blockers:['editorial_conflict','original_unavailable']});
  assert.deepEqual(validateBundle(bundle,{...policy,editorial:{approved:false,originalAvailable:true,conflicts:[]}}),{
    ok:false,hashIntegrity:true,editorialApproved:false,manifestHash,blockers:['editorial_approval_required']});
});

test('AC:REFREL-003 AC:REFREL-007 incomplete, foreign, unsafe and changed derivatives never validate or echo secrets',()=>{
  const {bundle,policy}=fixture();
  const edits=[
    (c:typeof bundle)=>{c.passages.pop();},
    (c:typeof bundle)=>{c.passages.push(c.passages[0]!);},
    (c:typeof bundle)=>{c.passages[0]!.text='changed';},
    (c:typeof bundle)=>{c.passages[0]!.embedding=[1,2];},
    (c:typeof bundle)=>{c.passages[0]!.embeddingChecksum='0'.repeat(64);},
    (c:typeof bundle)=>{c.entries.find(e=>e.kind==='article')!.body='{"church_id":"SECRET-CANARY"}';},
    (c:typeof bundle)=>{c.entries.find(e=>e.kind==='article')!.body='not JSON SECRET-CANARY';},
    (c:typeof bundle)=>{c.entries[0]!.sourceHash='0'.repeat(64);},
    (c:typeof bundle)=>{c.discoveryIds[0]=c.discoveryIds[1]!;},
    (c:typeof bundle)=>{c.profile.model='obsolete';},
    (c:typeof bundle)=>{c.catalogSha256='0'.repeat(64);},
  ];
  for(const edit of edits) {
    const c=structuredClone(bundle);edit(c);const report=validateBundle(c,policy);
    assert.equal(report.ok,false);assert.equal(JSON.stringify(report).includes('SECRET-CANARY'),false);
  }
});

test('INV-editor: shared native content is inert and Word/text imports remain text',()=>{
  assert.deepEqual(importExtractedText('<script>alert(1)</script>\n\nSecond'),{format:'everyfield-editor-v1',blocks:[
    {type:'paragraph',children:[{type:'text',text:'<script>alert(1)</script>',marks:[]}]},
    {type:'paragraph',children:[{type:'text',text:'Second',marks:[]}]},
  ]});
  const valid={format:'everyfield-editor-v1',blocks:[{type:'paragraph',children:[{type:'link',href:'https://example.test/path',children:[{type:'text',text:'Read',marks:[]}]}]}]};
  assert.deepEqual(editorDocument.parse(valid),valid);
  for(const href of ['javascript:alert(1)','data:text/html,test','//evil.test','https://user:pass@example.test','/x\\evil']) {
    const bad=structuredClone(valid);bad.blocks[0]!.children[0]!.href=href;
    assert.equal(editorDocument.safeParse(bad).success,false);
  }
  assert.equal(editorDocument.safeParse({...valid,tenantId:'forged'}).success,false);
  assert.equal(editorDocument.safeParse({format:'everyfield-editor-v1',blocks:[{type:'html',html:'<script/>'}]}).success,false);
});

import { safeMdx } from '../../../packages/reference/src/content.ts';
import { methodologyResponsibilities,separatePrayerResponsibility } from '../../../packages/reference/src/responsibilities.ts';
test('INV-reference-grammar: reviewed Callout and links parse without executing imports, expressions or HTML',()=>{
  const slugs=new Set(['discovery/example']);
  assert.equal(safeMdx('<Callout type="tip">Read [this](/wiki/discovery/example).</Callout>',slugs),true);
  for(const body of ['import x from "evil";\n\n# Text','{globalThis.process.exit()}','<script>alert(1)</script>',
    '<Evil type="tip">x</Evil>','<Callout type={"tip"}>Text</Callout>','[bad](javascript:alert%281%29)','[missing](/wiki/missing)',
    '<Callout type="tip" onClick="evil">Text</Callout>'])assert.equal(safeMdx(body,slugs),false,body);
});

test('AC:GAP-REF-004 AC:GAP-REF-005 producer catalogs preserve optional imports and separate Prayer responsibility',()=>{
  assert.equal(starter.catalogs.tasks.length,20);assert.equal(starter.catalogs.teams.length,10);
  assert.deepEqual(methodologyResponsibilities.map(r=>r.key),['worship','children','assimilation','small_groups','administration_finance','facilities','promotion','technology']);
  assert.deepEqual(methodologyResponsibilities.find(r=>r.key==='administration_finance')?.templateRole,null);
  assert.deepEqual(separatePrayerResponsibility,{key:'prayer',templateRole:{team:'prayer',role:'prayer_director'}});
  for(const choice of [...methodologyResponsibilities,separatePrayerResponsibility])if(choice.templateRole) {
    const team=starter.catalogs.teams.find(t=>t.teamKey===choice.templateRole!.team)!;
    assert.equal(Array.isArray(team.roles)&&team.roles.some(r=>r.key===choice.templateRole!.role),true);
  }
});

import {readRubricManifest,auditLanguage} from '../../../packages/reference/src/catalog.ts';
test('INV-reference-rubrics: plant original and adapter stay distinct from Network Intelligence; language audit approves nothing',()=>{
  const plant=readRubricManifest(starter,'plant'),network=readRubricManifest(starter,'network');
  assert.equal(plant.original.sha256,'5575450dff37bb730361f71a8152257622c5f089c84e448648f1c8543b1704c7');
  assert.equal(plant.adapter?.path,'docs/reference/plant-operational-adapter-v1.json');
  assert.equal(network.original.path,'docs/reference/network-rubric-v1.json');assert.equal(network.adapter,null);
  assert.throws(()=>readRubricManifest(starter,'other'));
  const report=auditLanguage(starter);
  assert.deepEqual(report.unsafeArticleIds,[]);assert.equal(report.semanticEvaluation,'not_run');assert.equal(report.activationApproved,false);
  assert.deepEqual(report.knownDrift.map(d=>d.id),['REF-DRIFT-C12','REF-DRIFT-PRAYER','REF-DRIFT-EVIDENCE']);
});
