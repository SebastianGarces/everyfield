#!/usr/bin/env python3
"""Render the reviewed owner cleanup plan from the generated physical catalog.
Run from repository root. --check compares the custom migration's generated block.
Unknown references keep purge incomplete through PostgreSQL FK checks.
"""
import json
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[4]
catalog = json.loads((root / 'docs/schema/target.json').read_text())
tables = {t['name']: t for t in catalog['tables']}
# These are durable non-content identities or independent global resources.
keep = {'account', 'plant', 'tenant', 'record', 'lifecycle_witness', 'schema_migration', 'file_object', 'operation'}
account_owned = {'discovery': 'account_id', 'notification_preference': 'account_id',
                 'private_week_revision': 'author_id', 'private_week': 'author_id',
                 'private_calendar': 'account_id', 'identity_proof': 'account_id',
                 'settings_preview': 'account_id', 'feedback':'account_id', 'reading':'account_id',
                 'reader_feedback':'account_id','platform_grant':'account_id','conversation':'owner_id','notice':'recipient_id'}
# Snapshot/lineage bodies belong to their source operation. The creation operation
# can be account-scoped while its setup and phase evidence belong to the church.
extra = {'identity_operation_result': 'operation_id IN (SELECT id FROM operation WHERE tenant_id=s)',
         'organization_operation_result': 'operation_id IN (SELECT id FROM operation WHERE tenant_id=s)',
         'article_link':'revision_id IN (SELECT id FROM article_revision WHERE tenant_id=s)',
         'conversation_entry':"(w.kind='account' AND conversation_id IN (SELECT id FROM conversation WHERE owner_id=s))",
         'review':"(w.kind='account' AND conversation_id IN (SELECT id FROM conversation WHERE owner_id=s))",
         'effect':"(w.kind='account' AND review_id IN (SELECT id FROM review WHERE conversation_id IN (SELECT id FROM conversation WHERE owner_id=s)))",
         'relationship_history':"relationship_id IN (SELECT id FROM affiliation WHERE plant_id=s AND w.kind='plant')"}
plans = []
for name,t in sorted(tables.items()):
    if name in keep: continue
    cols={c['name']:c for c in t['columns']}
    common=[]
    if 'tenant_id' in cols: common.append('tenant_id=s')
    plant=[]
    if 'plant_id' in cols: plant.append('plant_id=s')
    if 'plant_context_id' in cols: plant.append('plant_context_id=s')
    acct=[]
    if name in account_owned: acct.append(account_owned[name]+'=s')
    parts=common+(["(w.kind='plant' AND ("+' OR '.join(plant)+'))'] if plant else [])+(["(w.kind='account' AND ("+' OR '.join(acct)+'))'] if acct else [])
    if name in extra: parts.append(extra[name])
    if 'assessment_id' in cols: parts.append("(w.kind='plant' AND assessment_id=ANY(copied))")
    if name=='assessment': parts.append("(w.kind='plant' AND id=ANY(copied))")
    if name=='onboarding_result':
        parts.append("operation_id IN (SELECT creation_operation_id FROM onboarding_setup WHERE plant_id=s)")
        # Shared church creation evidence is projected to minimal history below.
        parts=[f'({p}) AND operation_id NOT IN (SELECT creation_operation_id FROM onboarding_setup WHERE plant_id<>s)' for p in parts]
    if not parts: continue
    plans.append((name,' OR '.join(parts)))
# Explicitly remove source-containing organization intelligence, not another org.
# Source FK and contributor closure is handled before generic owned rows.
lines=[]
for name,cond in plans:
    lines.append(f'''  BEGIN
   DELETE FROM "{name}" WHERE {cond};
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;''')
checks='\n'.join(f' IF EXISTS(SELECT FROM "{name}" WHERE {cond}) THEN RAISE EXCEPTION \'incomplete_owned_cleanup:{name}\' USING ERRCODE=\'23514\'; END IF;' for name,cond in plans)
# All nullable attribution columns that refer to account have an explicit detach
# rule. Nonnullable church lineage retains only the opaque tombstone root.
scrub=[]
for name,t in sorted(tables.items()):
    if name in {'account','lifecycle_witness'}: continue
    cols={c['name']:c for c in t['columns']}
    for fk in t.get('foreign_keys',[]):
        if fk['references']['table']!='account' or len(fk['columns'])!=1: continue
        c=fk['columns'][0]
        if c not in {'actor_id','author_id','creator_id','requested_by','completed_by','confirmed_by','changed_by','card_author_id','staff_account_id','assignee_id','linked_account_id','adopted_by'} or not cols[c].get('nullable',False): continue
        if name=='reference_activation': scrub.append(f' UPDATE "{name}" SET "{c}"=NULL,actor_tombstone=\'removed_account\' WHERE "{c}"=s;')
        elif name=='event': scrub.append(f' UPDATE "{name}" SET "{c}"=NULL,system_cause=coalesce(system_cause,\'removed_account\') WHERE "{c}"=s;')
        else: scrub.append(f' UPDATE "{name}" SET "{c}"=NULL WHERE "{c}"=s;')
block='''-- BEGIN GENERATED OWNER CLEANUP
-- Generated by packages/domain/src/settings/generate-cleanup.py. Review the
-- predicates: tenant/plant/immutable author selects ownership, never creator.
CREATE FUNCTION settings_purge_content(witness uuid,request uuid,expected bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE w lifecycle_witness%ROWTYPE; s uuid; n bigint; removed bigint; pass integer; copied uuid[];
BEGIN
 SELECT * INTO w FROM lifecycle_witness WHERE id=witness AND request_id=request AND request_revision=expected AND state='purging' AND cancel_until<=clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 s=w.opaque_subject_id;
 UPDATE provider_event SET mail_id=NULL WHERE mail_id IN (SELECT id FROM mail WHERE tenant_id=s);
 DELETE FROM feedback_publication WHERE state IN ('pending','held','rejected') AND feedback_id IN (SELECT id FROM feedback WHERE (account_id=s AND w.kind='account') OR (plant_context_id=s AND w.kind='plant'));
 UPDATE feedback_publication SET feedback_id=NULL,account_id=NULL,category=NULL,public_area=NULL,sanitized_title=NULL,sanitized_body=NULL,state=CASE WHEN state='publishing' THEN 'unknown' ELSE state END WHERE feedback_id IN (SELECT id FROM feedback WHERE (account_id=s AND w.kind='account') OR (plant_context_id=s AND w.kind='plant'));
 UPDATE mail SET notice_id=NULL WHERE notice_id IN (SELECT id FROM notice WHERE tenant_id=s OR (recipient_id=s AND w.kind='account'));
 SELECT array_agg(assessment_id) INTO copied FROM assessment_contributor WHERE plant_id=s AND w.kind='plant';
 -- Detach mutable current pointers before deleting immutable revision bodies.
 UPDATE document SET current_revision_id=NULL WHERE tenant_id=s;
 IF w.kind='account' THEN
  UPDATE operation SET conversation_id=NULL,review_id=NULL WHERE conversation_id IN (SELECT id FROM conversation WHERE owner_id=s);
  UPDATE event SET effect_id=NULL WHERE effect_id IN (SELECT id FROM effect WHERE review_id IN (SELECT id FROM review WHERE conversation_id IN (SELECT id FROM conversation WHERE owner_id=s)));
  UPDATE mail SET notice_id=NULL WHERE recipient_account_id=s;
  UPDATE account SET avatar_object_id=NULL,personal_timezone=NULL,registration_digest=NULL WHERE id=s;
  UPDATE mail SET recipient_address_encrypted=NULL,frozen_payload=NULL,address_hash=NULL,recipient_account_id=NULL,state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END WHERE recipient_account_id=s;
  UPDATE seat SET ended_at=coalesce(ended_at,clock_timestamp()) WHERE account_id=s;
  UPDATE affiliation SET ended_at=coalesce(ended_at,clock_timestamp()) WHERE account_id=s;
  UPDATE residency_link SET ended_at=coalesce(ended_at,clock_timestamp()) WHERE account_id=s;
  PERFORM scrub_people_account_author(s);
'''+ '\n'.join(scrub)+'''
  -- Shared onboarding setup/phase facts survive. The original account-scoped
  -- result keeps only church creation evidence, without a login/seat snapshot.
  UPDATE onboarding_result r SET value=jsonb_build_object('plant',r.value->'plant','creation',r.value->'creation') WHERE r.operation_id IN (SELECT creation_operation_id FROM onboarding_setup WHERE account_id=s);
  UPDATE auth_user SET name='Removed account',email='removed-'||s::text||'@removed.invalid',image=NULL,email_verified=false WHERE id=(SELECT auth_user_id FROM account WHERE id=s);
  DELETE FROM auth_session WHERE user_id=(SELECT auth_user_id FROM account WHERE id=s);
  DELETE FROM auth_account WHERE user_id=(SELECT auth_user_id FROM account WHERE id=s);
  DELETE FROM auth_verification WHERE value=(SELECT auth_user_id::text FROM account WHERE id=s);
 END IF;
 -- Required FK dependencies determine which deletion can make progress. A
 -- surviving reference refuses completion, instead of cascading another owner.
 FOR pass IN 1..'''+str(len(plans)+1)+''' LOOP
  removed=0;
'''+ '\n'.join(lines)+'''
  EXIT WHEN removed=0;
 END LOOP;
'''+checks+'''
 IF w.kind='plant' THEN
  UPDATE plant SET name='Removed workspace',street=NULL,description=NULL,city=NULL,state_province=NULL,country=NULL WHERE id=s;
 END IF;
 UPDATE mail SET recipient_address_encrypted=NULL,frozen_payload=NULL,address_hash=NULL,recipient_account_id=NULL,state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END WHERE recipient_account_id=s AND w.kind='account';
END $$;
REVOKE ALL ON FUNCTION settings_purge_content(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settings_purge_content(uuid,uuid,bigint) TO everyfield_cleanup;
-- END GENERATED OWNER CLEANUP'''
p=root/'packages/db/migrations/0011_settings_privileges.sql'
s=p.read_text();begin=s.find('-- BEGIN GENERATED OWNER CLEANUP');end=s.find('-- END GENERATED OWNER CLEANUP')
result=s[:begin]+block+s[end+len('-- END GENERATED OWNER CLEANUP'):] if begin>=0 else s+'\n'+block+'\n'
if '--check' in sys.argv:
    if result!=s: raise SystemExit('Generated owner cleanup differs; rerun generate-cleanup.py')
    print(f'Owner cleanup: {len(plans)} table rules, {len(scrub)} account attribution detach rules checked.')
else: p.write_text(result)

# Data-only conversion sits between Kit's generated DROP/ADD constraints. Kit
# still generates every structural statement; this reviewed block preserves each
# formerly grouped preference for every now-independent category/channel pair.
conversion=["-- BEGIN NOTIFICATION PREFERENCE DATA", "DELETE FROM notification_preference WHERE category='insight';"]
for old,targets in [('task',['task_due','task_overdue']),('meeting',['meeting_announcement','meeting_reminder']),('relationship',['relationship_milestone','sharing_milestone']),('phase',['phase_milestone','launch_milestone']),('reference_update',['wiki_upstream_review'])]:
    for target in targets[1:]:
        conversion.append(f"INSERT INTO notification_preference(id,account_id,category,channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision) SELECT gen_random_uuid(),account_id,'{target}',channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision FROM notification_preference WHERE category='{old}';")
    conversion.append(f"UPDATE notification_preference SET category='{targets[0]}' WHERE category='{old}';")
conversion.append('SET CONSTRAINTS ALL IMMEDIATE;')
conversion.append('-- END NOTIFICATION PREFERENCE DATA')
block='\n'.join(conversion)
p=root/'packages/db/migrations/0010_settings.sql';s=p.read_text();begin=s.find('-- BEGIN NOTIFICATION PREFERENCE DATA');end=s.find('-- END NOTIFICATION PREFERENCE DATA')
if begin>=0: result=s[:begin]+block+s[end+len('-- END NOTIFICATION PREFERENCE DATA'):]
else:
    anchor='ALTER TABLE "notification_preference" DROP CONSTRAINT "notification_preference_ck_6";'
    if anchor not in s: raise SystemExit('Missing Kit category migration anchor')
    result=s.replace(anchor,anchor+'\n'+block+'\n',1)
if '--check' in sys.argv:
    if result!=s: raise SystemExit('Notification preference conversion differs')
else: p.write_text(result)

# Derive supplemental expectations from the reviewed custom SQL, never from a
# live database. Preserve all unrelated expectations and PostgreSQL catalog order.
import re
import subprocess
meta_path=root/'packages/db/src/schema/supplemental.json'
meta=json.loads(meta_path.read_text())
custom=(root/'packages/db/migrations/0011_settings_privileges.sql').read_text()
functions=[]
for name,args,body in re.findall(r'CREATE FUNCTION (settings_\w+)\((.*?)\) RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS \$\$(.*?)\$\$;',custom,re.S):
    args=', '.join(a.strip() for a in args.split(','))
    functions.append({'arguments':args,'definition':f"CREATE OR REPLACE FUNCTION <schema>.{name}({args})\n RETURNS void\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO '<schema>', 'pg_catalog', 'pg_temp'\nAS $function${body}$function$\n",'name':name})
if {f['name'] for f in functions}!={'settings_update_name','settings_suspend_subject','settings_purge_subject','settings_purge_content'}:
    raise SystemExit('Review the custom settings function inventory before changing expectations')
meta['functions']=[f for f in meta['functions'] if not f['name'].startswith('settings_')]+functions
meta['acl']=[a for a in meta['acl'] if not a['object'].startswith('settings_')]
for f in functions:
    role='everyfield_cleanup' if f['name'] in ['settings_purge_content','settings_purge_subject'] else 'everyfield_runtime'
    # Existing catalog-state.ts projects UNION object names through pg name(63).
    obj=(f['name']+'('+f['arguments']+')')[:63]
    meta['acl'].append({'grantee':role,'is_grantable':False,'kind':'function','object':obj,'privilege_type':'EXECUTE'})
for table in ['settings_result','settings_preview']:
    for role,grants in [('everyfield_runtime',['SELECT','INSERT']+(['UPDATE','DELETE'] if table=='settings_preview' else [])),('everyfield_cleanup',['SELECT','UPDATE','DELETE'])]:
        for privilege in grants:
            meta['acl'].append({'grantee':role,'is_grantable':False,'kind':'table','object':table,'privilege_type':privilege})
node="""let s='';for await(const b of process.stdin)s+=b;const x=JSON.parse(s);const n=v=>Array.isArray(v)?v.map(n):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,n(v)])):v;for(const k of Object.keys(x))x[k]=x[k].map(n).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));process.stdout.write(JSON.stringify(x,null,'\\t')+'\\n');"""
expected=subprocess.run(['node','--input-type=module','-e',node],input=json.dumps(meta),text=True,stdout=subprocess.PIPE,check=True).stdout
if '--check' in sys.argv:
    if expected!=meta_path.read_text():raise SystemExit('Reviewed settings supplemental expectations differ; rerun generator')
else:meta_path.write_text(expected)
