#!/usr/bin/env python3
"""Compile the offline documentation explorer from explicit current inputs only."""
import argparse,hashlib,importlib.util,json,sys
sys.dont_write_bytecode=True
from pathlib import Path
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(root,p):return json.loads((root/p).read_text())
def compile_current(root):
    paths=load(root,'docs/plan/current-inputs.json')['paths']
    if len(paths)!=len(set(paths)):raise ValueError('Duplicate current input')
    hashes={p:digest(root/p) for p in paths}
    fingerprint=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
    spec=importlib.util.spec_from_file_location('package_context',root/'docs/package-context.py');context=importlib.util.module_from_spec(spec);spec.loader.exec_module(context)
    dag=load(root,'docs/plan/dag.json');features=load(root,'docs/catalog/features.json');acceptance=context.load_acceptance(root);schema=load(root,'docs/schema/target.json');gates=load(root,'docs/plan/release-gates.json')
    valid_f={f['id'] for f in features};tables=[];edges=[]
    for t in schema['tables']:
        name=t['name'];cols=[]
        for c in t['columns']:
            cols.append(dict(id=name+'::'+c['name'],name=c['name'],sqlName=c['name'],label=c['name'].replace('_',' ').title(),description=c.get('meaning',c.get('description','Proposed '+c['type']+' field. Current keys/checks/ownership and deletion policy appear in this table’s contract.')),sqlType=c['type'],nullable=c['nullable'],defaultKnown=True,default=c.get('default'),primaryKey=c['name'] in t['primary_key'],unique=any(k['columns']==[c['name']] and not k.get('where') for k in t['unique_keys']),source='docs/schema/target.json#'+name,sourceQualification='proposed target contract; SQL not yet verified'))
        constraints=dict(primaryKeys=[dict(id=name+'::pk',columns=t['primary_key'],source='docs/schema/target.json#'+name)],indexes=[],uniqueConstraints=[dict(id=name+'::unique::'+str(i),columns=k['columns'],where=k.get('where'),source='docs/schema/target.json#'+name) for i,k in enumerate(t['unique_keys'])],checks=[dict(id=name+'::check::'+str(i),expression=k,source='docs/schema/target.json#'+name) for i,k in enumerate(t['checks'])],declaredOnly=[])
        fs=sorted(set(t['feature_ids'])&valid_f)
        tables.append(dict(id=name,name=name,label=name.replace('_',' ').title(),module=t['scope'],purpose=t['purpose'],status='specified; future-not-run',disposition='current proposed table',targetModel=name,targetOwnerPath='packages/db/src/schema/',integrityGates=t['invariants']+t['checks']+[t['revision'],t['idempotency'],'Deletion: '+t['deletion']],acceptanceGate=', '.join(t['future_case_ids']),featureIds=fs,featurePrefixes=sorted({f.split('-')[0] for f in fs}),workPackageIds=t['producer_work_packages'],columns=cols,constraints=constraints,sourceRefs=['docs/schema/target.json#'+name],sourceQualifications=['Current design only; real DDL/security/race proof future-not-run'],featureRationale=[]))
        for i,k in enumerate(t['foreign_keys']):
            edges.append(dict(id=name+'::target-fk::'+str(i),kind='proposed_target_foreign_key',name=k.get('name'),from_=name,to=k['references']['table'],columnsFrom=k['columns'],columnsTo=k['references']['columns'],onDelete=k['on_delete'],onUpdate='immutable identity',source='docs/schema/target.json#'+name,sourceQualification='proposed target FK; physical enforcement future-not-run',description='Per-reference deletion: '+json.dumps(k['deletion'],sort_keys=True),columnIdsFrom=[name+'::'+c for c in k['columns']]))
    for e in edges:e['from']=e.pop('from_')
    for pkg in dag['packages']:
        def ui(path):
            return path.startswith(('apps/web/src/features/', 'apps/web/src/components/', 'tests/browser/', 'packages/ui/', 'tests/ui/')) or path.startswith('apps/web/src/app/') and not path.startswith('apps/web/src/app/api/')
        paths=pkg['owning_paths'];web=any(ui(p) for p in paths);nonweb=any(not ui(p) for p in paths)
        pkg['producer_task']=pkg['id']+'/api' if web and nonweb else pkg['id']
    byf={f['id']:f for f in features}
    for f in features:
        f['tables']=[t['id'] for t in tables if f['id'] in t['featureIds']];f['v3_operations']=f['operations'];f['decision']='Current clauses: '+', '.join(f['requirement_ids'])+'; specification: '+f['spec_file'];f['source_refs']=[f['spec_file']];f['tests']=f['case_ids'];f['permissions']=[];f['validation']=[];f['states']=[];f['failures']=[]
    for a in acceptance:
        a['positive_obligation']='Current clause IDs: '+', '.join(a['requirement_ids']);a['validation_obligations']=[];a['permission_denial_obligations']=[];a['state_history_obligations']=[];a['failure_recovery_obligations']=['Named future fixtures: '+', '.join(a['case_ids'])];a['status']='future-not-run'
    decisions=[]
    for g in gates['gates']:
        decisions.append(dict(id=g['id'],title=g['title'],proposal=g.get('closure',g.get('required_evidence',g.get('description',''))),owner=g.get('owner','Named package owner'),workPackages=g.get('work_packages',[]),source='docs/plan/release-gates.json',status=g['status']))
    for q in gates['owner_product_questions']:
        decisions.append(dict(id=q['id'],title=q['title'],proposal=q['question'],owner=q['owner'],workPackages=q['work_packages'],source='docs/plan/release-gates.json',status=q['status']))
    return dict(meta=dict(capturedAt='2026-10-14',fingerprint=fingerprint,planFingerprint=fingerprint,sourceHashes=hashes,packageEdges=dag['edge_count'],initialCompletionBasis='Current documentation-only target: '+str(len(features))+' active capabilities, '+str(len(acceptance))+' acceptance bundles, '+str(len(tables))+' proposed target tables and '+str(len(edges))+' proposed FKs. Documentation counts do not establish implementation acceptance. Progress comes only from docs/build-progress.json.',fingerprintPolicy='Current planFingerprint binds explicit source inputs. Canonical progress is a read-only snapshot of the evf record; regenerating the view never changes it.'),packages=dag['packages'],dag={k:dag[k] for k in ['version','as_of','vertical_slices','critical_path','critical_path_unconstrained_days','total_engineer_days','contract_milestones']},features=features,tables=tables,tableEdges=edges,applicationEdges=[],historicalEdges=[],acceptance=acceptance,decisions=decisions,acceptedRulings=[])
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--check',action='store_true',required=True)
    args=parser.parse_args()
    data=compile_current(args.root.resolve(strict=True))
    print(f"PASS: compiled current explorer inputs, {len(data['packages'])} active packages, expanded acceptance defaults")

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError) as error:raise SystemExit('ERROR: '+str(error))
