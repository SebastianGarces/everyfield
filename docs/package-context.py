#!/usr/bin/env python3
"""Generate current package overview or deterministic bounded detail pages; documentation only."""
import argparse,hashlib,json,math,sys
from pathlib import Path
def read(root,path):return json.loads((root/path).read_text())
def load_schema(root):
    schema=read(root,'docs/schema/target.json')['tables']
    packages={p['id'] for p in read(root,'docs/plan/dag.json')['packages']}
    for table in schema:
        producers=set(table['producer_work_packages'])
        if not producers or not producers<=packages:
            raise ValueError('Schema table '+table['name']+' must name actual producer packages')
    return schema
def compile_manifest(root):
    dag=read(root,'docs/plan/dag.json');catalog=read(root,'docs/catalog/index.json');features=read(root,catalog['feature_source']);acceptance=read(root,catalog['acceptance_source']);operations=read(root,catalog['operation_source'])['operations'];schema=load_schema(root);reqs={};cases={}
    for path in catalog['requirement_files']:
        for x in read(root,path)['requirements']:reqs[x['id']]={'path':path,'record':x}
    for path in catalog['case_files']:
        for x in read(root,path)['cases']:cases[x['id']]={'path':path,'record':x}
    alias_source=catalog['current_alias_source'];aliases={a['alias']:a for a in read(root,alias_source)['aliases']}
    result=[];by={p['id']:p for p in dag['packages']}
    for p in dag['packages']:
        pid=p['id'];fs={f['id'] for f in features if pid in f['work_packages']}
        if pid in ['WP-002','WP-056','WP-057']:fs={f['id'] for f in features}
        if pid=='WP-001':
            fs={f['id'] for f in features if f['id'].startswith('REF-')}
        rs={k for k,v in reqs.items() if pid in v['record'].get('work_packages',[]) or fs&set(v['record']['feature_ids'])}
        acs={a['id'] for a in acceptance if pid in a['work_packages'] or a['feature_id'] in fs}
        cs={k for k,v in cases.items() if pid in v['record'].get('work_packages',[]) or fs&set(v['record']['feature_ids'])}
        ops={o['id'] for o in operations if pid in o['ownership'].get('domain_work_packages',[]) or pid in o['ownership'].get('evry_work_packages',[]) or fs&set(o['feature_ids'])}
        tables={t['name'] for t in schema if pid in t['producer_work_packages']}
        if pid=='WP-004':
            tables={t['name'] for t in schema}
        # Direct shared clauses and acceptance/operation fixtures close without recursively loading upstream packages.
        own_rs=set(rs);own_ops=set(ops)
        consumed_ac_rs={rid for a in acceptance if a['id']in acs for rid in a['requirement_ids']} - own_rs
        consumed_ac_ops={oid for a in acceptance if a['id']in acs for oid in a['operations']} - own_ops
        rs|=consumed_ac_rs;ops|=consumed_ac_ops
        queue=list(rs)
        while queue:
            rid=queue.pop()
            for shared in reqs[rid]['record'].get('shared_contract_ids',[]):
                if shared in reqs and shared not in rs:
                    rs.add(shared);queue.append(shared)
        shared_symbols={shared for rid in rs for shared in reqs[rid]['record'].get('shared_contract_ids',[]) if shared not in reqs}
        shared_registry=read(root,'docs/catalog/shared-contracts.json')['contracts']
        if not shared_symbols<=set(shared_registry):raise ValueError('Unresolved shared contract '+str(shared_symbols-set(shared_registry)))
        # Whole-feature bundles come only from actual owning feature/package metadata, not a shared clause's broad applicability map.
        cs|={cid for rid in rs for cid in reqs[rid]['record'].get('case_ids',[]) if cid in cases}
        cs|={cid for a in acceptance if a['id']in acs for cid in a['case_ids']}
        cs|={cid for o in operations if o['id']in own_ops for cid in o['case_ids'] if cid in cases}
        shared_ops=set(consumed_ac_ops);unresolved=[]
        for rid in rs:
            for operation in reqs[rid]['record'].get('operations',[]):
                canonical=operation if operation in {o['id']for o in operations}else aliases.get(operation,{}).get('canonical_operation')
                if canonical is None:unresolved.append({'requirement':rid,'operation':operation});continue
                if rid not in own_rs:shared_ops.add(canonical)
                ops.add(canonical)
        cs|={cid for o in operations if o['id']in ops-shared_ops for cid in o['case_ids'] if cid in cases}
        alias_ids=sorted({name for rid in rs for name in reqs[rid]['record'].get('operations',[]) if name in aliases})
        result.append(dict(id=pid,consumed_acceptance_requirement_ids=sorted(consumed_ac_rs),consumed_acceptance_operation_ids=sorted(consumed_ac_ops),contract_consumption_rule='Selected native-only/internal contracts prove current exclusion or producer parity; selectors never grant model/HTTP exposure or change producer ownership.',current_alias_ids=alias_ids,own_requirement_ids=sorted(own_rs),shared_requirement_ids=sorted(rs-own_rs),shared_operation_ids=sorted(shared_ops),unresolved_current_operation_references=unresolved,shared_contract_ids=sorted(shared_symbols),direct_prerequisites=p['depends_on'],feature_ids=sorted(fs),requirement_ids=sorted(rs),acceptance_ids=sorted(acs),case_ids=sorted(cs),operation_ids=sorted(ops),producer_table_names=sorted(tables),consumer_table_names=sorted(t['name'] for t in schema if fs&set(t['feature_ids']) and t['name'] not in tables)))
    return dict(version=2,scope='Current standalone exact selectors; on-demand packets, no duplicated86packet files or prerequisite outputs.',catalog_source='docs/catalog/index.json',current_alias_source=alias_source,package_source='docs/plan/dag.json',requirement_locations={k:v['path']for k,v in sorted(reqs.items())},case_locations={k:v['path']for k,v in sorted(cases.items())},shared_read_paths=['AGENTS.md','docs/START-HERE.md','docs/architecture/core.md','docs/architecture/security.md','docs/architecture/audit.md','docs/build-agent-workflow.md'],detail_page_size=10,packages=result,shared_contract_source='docs/catalog/shared-contracts.json',package_count=len(result),max_detail_page_bytes=196608,omission_policy='Pagination exposes totalPages/selectedCount. Every selected page is part of the package gate. Larger individual records fail explicitly; no silent truncation. Broad contract/schema/integration owners have indexed whole-target scope; ordinary adapters consume selected producer interfaces.')

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('package',nargs='?');p.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent);p.add_argument('--part',choices=['overview','requirements','operations','aliases','cases','schema'],default='overview');p.add_argument('--page',type=int,default=1);p.add_argument('--output',type=Path);m=p.add_mutually_exclusive_group();m.add_argument('--refresh-manifest',action='store_true');m.add_argument('--check-manifest',action='store_true');a=p.parse_args();root=a.root.resolve();manifest=compile_manifest(root);path=root/'docs/plan/context-manifest.json'
    if a.refresh_manifest:path.write_text(json.dumps(manifest,indent=2)+'\n');print('Generated86current package selectors.');return
    if a.check_manifest:
        if read(root,'docs/plan/context-manifest.json')!=manifest:raise ValueError('Stale package context manifest')
        print('All86package contexts match current catalogs.');return
    if not a.package:raise ValueError('Choose WP-001..WP-086')
    package=next((x for x in manifest['packages'] if x['id']==a.package),None)
    if not package:raise ValueError('Unknown package '+a.package)
    if a.part=='overview':
        dag=read(root,'docs/plan/dag.json');by={p['id']:p for p in dag['packages']};own=by[a.package]
        out={**package,'proof_stage':('whole-target completed producer+native+assistant acceptance evidence'if a.package in ['WP-056','WP-057']else 'contract/schema producer then domain/native applicable portions; assistant portions close only after named later adapters and full target gate'),'shared_contract_locations':{k:read(root,manifest['shared_contract_source'])['contracts'][k]for k in package['shared_contract_ids']},'current_alias_source':manifest['current_alias_source'],'current_alias_selectors':[{'alias':k,'path':manifest['current_alias_source']}for k in package['current_alias_ids']],'title':own['title'],'owning_paths':own['owning_paths'],'spec_paths':own['spec_paths'],'shared_read_paths':manifest['shared_read_paths'],'direct_prerequisite_interfaces':[{'id':k,'outputs':by[k]['outputs'],'interfaces':by[k]['interfaces']}for k in package['direct_prerequisites']],'requirement_selectors':[{'id':k,'path':manifest['requirement_locations'][k]}for k in package['requirement_ids']],'case_selectors':[{'id':k,'path':manifest['case_locations'][k]}for k in package['case_ids']],'context_policy':'Read selected chapter and every selected detail page, including exact current alias parameter/result mappings. Consumer table rows and original SME passages on demand; no historical rule chain, source checkout or recursive prerequisite packet required. Context budgets do not drop requirements.'}
    else:
        records=[]
        if a.part in ['requirements','cases']:
            key='requirement_ids' if a.part=='requirements' else 'case_ids';field='requirements' if a.part=='requirements' else 'cases';locations=manifest['requirement_locations']if a.part=='requirements'else manifest['case_locations'];cache={}
            for record_id in package[key]:
                path=locations[record_id]
                if path not in cache:cache[path]={x['id']:x for x in read(root,path)[field]}
                records.append(cache[path][record_id])
        elif a.part=='operations':ids=set(package['operation_ids']);records=[x for x in read(root,'docs/catalog/operations.json')['operations'] if x['id'] in ids]
        elif a.part=='aliases':ids=set(package['current_alias_ids']);records=[x for x in read(root,manifest['current_alias_source'])['aliases'] if x['alias'] in ids]
        else:ids=set(package['producer_table_names']);records=[x for x in read(root,'docs/schema/target.json')['tables'] if x['name'] in ids]
        count=len(records);size=manifest['detail_page_size'];pages=max(1,math.ceil(count/size))
        if a.page<1 or a.page>pages:raise ValueError('Page out of range1..'+str(pages))
        out=dict(package=a.package,part=a.part,page=a.page,totalPages=pages,selectedCount=count,status='future-not-run',allPagesRequired=True,records=records[(a.page-1)*size:a.page*size])
    encoded=json.dumps(out,indent=2)+'\n'
    if a.part!='overview' and len(encoded.encode())>manifest['max_detail_page_bytes']:raise ValueError('Detail page exceeds explicit budget; contract owner must partition its records without dropping selected scope')
    if a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(encoded)
    else:sys.stdout.write(encoded)
if __name__=='__main__':
    try:main()
    except (ValueError,KeyError,OSError) as e:raise SystemExit('ERROR: '+str(e))
