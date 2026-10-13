#!/usr/bin/env python3
"""Compile the offline documentation explorer from explicit current inputs only."""
import argparse,fcntl,hashlib,json,os,re,tempfile
from pathlib import Path
DATA_RE=re.compile(r'(<script type="application/json" id="canonical-data">)(.*?)(</script>)',re.S)
NAMESPACE='4fde2956bd434920c54545c516f43134d62ade411b8aa0d1b9eac05eef4162b8'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(root,p):return json.loads((root/p).read_text())
def compile_current(root):
    paths=load(root,'docs/plan/current-inputs.json')['paths']
    if len(paths)!=len(set(paths)):raise ValueError('Duplicate current input')
    hashes={p:digest(root/p) for p in paths}
    dag=load(root,'docs/plan/dag.json');features=load(root,'docs/catalog/features.json');acceptance=load(root,'docs/catalog/acceptance.json');schema=load(root,'docs/schema/target.json');gates=load(root,'docs/plan/release-gates.json')
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
    byf={f['id']:f for f in features}
    for f in features:
        f['tables']=[t['id'] for t in tables if f['id'] in t['featureIds']];f['v3_operations']=f['operations'];f['decision']='Current clauses: '+', '.join(f['requirement_ids'])+'; specification: '+f['spec_file'];f['source_refs']=[f['spec_file']];f['tests']=f['case_ids'];f['permissions']=[];f['validation']=[];f['states']=[];f['failures']=[]
    for a in acceptance:
        a['positive_obligation']='Current clause IDs: '+', '.join(a['requirement_ids']);a['validation_obligations']=[];a['permission_denial_obligations']=[];a['state_history_obligations']=[];a['failure_recovery_obligations']=['Named future fixtures: '+', '.join(a['case_ids'])];a['status']='future-not-run'
    decisions=[]
    for g in gates['gates']:
        decisions.append(dict(id=g['id'],title=g['title'],proposal=g.get('closure',g.get('required_evidence',g.get('description',''))),owner=g.get('owner','Named package owner'),workPackages=g.get('work_packages',[]),source='docs/plan/release-gates.json',status=g['status']))
    return dict(meta=dict(capturedAt='2026-10-13',fingerprint=NAMESPACE,planFingerprint=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest(),sourceHashes=hashes,packageEdges=dag['edge_count'],initialCompletionBasis='Current documentation-only target: '+str(len(features))+' active capabilities, '+str(len(acceptance))+' acceptance bundles, '+str(len(tables))+' proposed target tables and '+str(len(edges))+' proposed FKs; all86canonicalpackagesnot_started/revision0. No implementation test passed.',fingerprintPolicy='Stable browser progress namespace; current planFingerprint identifies the new explicit current projection. Package IDs/progress records stay compatible; current dependencies and readiness are enforced.'),packages=dag['packages'],dag={k:dag[k] for k in ['version','as_of','vertical_slices','critical_path','critical_path_unconstrained_days','total_engineer_days','contract_milestones']},features=features,tables=tables,tableEdges=edges,applicationEdges=[],historicalEdges=[],acceptance=acceptance,decisions=decisions,acceptedRulings=[])
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent);mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--check',action='store_true');mode.add_argument('--apply',action='store_true');a=parser.parse_args();root=a.root.resolve(strict=True)
    paths=load(root,'docs/plan/current-inputs.json')['paths']
    for rel in paths+['docs/.build-progress.lock','everyfield-build-explorer.html']:
        p=root/rel
        if p.is_symlink() or not p.resolve().is_relative_to(root):raise ValueError('Unsafe input path '+rel)
    lock=open(root/'docs/.build-progress.lock','a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    path=root/'everyfield-build-explorer.html';html=path.read_text();match=DATA_RE.search(html)
    if not match:raise ValueError('Missing canonical-data')
    old=json.loads(match.group(2));fresh=compile_current(root)
    if old['meta']['fingerprint']!=NAMESPACE:raise ValueError('Unexpected progress namespace')
    if {p['id'] for p in old['packages']}!={p['id'] for p in fresh['packages']}:raise ValueError('Package IDs changed: explicit progress reconciliation needed')
    progress=load(root,'docs/build-progress.json')
    if set(progress['packages'])!={p['id'] for p in fresh['packages']}:raise ValueError('Progress package mismatch')
    if a.check:
        if fresh!=old:raise ValueError('Explorer current projection is stale; review and use --apply')
        print('Current projection matches explicit inputs; stable86-package progress namespace.');return
    encoded=json.dumps(fresh,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    output=html[:match.start(2)]+encoded+html[match.end(2):]
    fd,tmp=tempfile.mkstemp(prefix='.explorer-plan-',dir=root)
    try:
        with os.fdopen(fd,'w') as handle:handle.write(output);handle.flush();os.fsync(handle.fileno())
        os.chmod(tmp,path.stat().st_mode&0o777);os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
    print('Compiled current plan only; canonical and embedded local progress unchanged.')
if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError) as error:raise SystemExit('ERROR: '+str(error))
