import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
export const source=resolve(import.meta.dirname,'../../..');
export function fixture() {
 const root=mkdtempSync(join(tmpdir(),'evf-regression-'));
 cpSync(join(source,'docs'),join(root,'docs'),{recursive:true});
 cpSync(join(source,'design/handoff'),join(root,'design/handoff'),{recursive:true});
 cpSync(join(source,'AGENTS.md'),join(root,'AGENTS.md'));cpSync(join(source,'README.md'),join(root,'README.md'));
 cpSync(join(source,'.agents/skills/everyfield-pr'),join(root,'.agents/skills/everyfield-pr'),{recursive:true});
 cpSync(join(source,'tools/evf/templates'),join(root,'tools/evf/templates'),{recursive:true});
 const dag=JSON.parse(readFileSync(join(root,'docs/plan/dag.json'),'utf8'));
 const progressPath=join(root,'docs/build-progress.json');
 const progress={schema_version:1,project_id:'everyfield-v3',revision:0,updated_at:null,packages:Object.fromEntries(dag.packages.map(p=>[p.id,{status:'not_started',revision:0,updated_at:null,evidence:[],notes:'Disposable active-package fixture.'}]))};
 writeFileSync(progressPath,JSON.stringify(progress));
 const cfg=JSON.parse(readFileSync(join(source,'evf.config.json'),'utf8'));
 cfg.stack=null; // Tests that need a stack declare their own; never run the live stack command.
 cfg.checks=[{name:'fixture-check',run:[process.execPath,'-e','process.stdout.write("checked disposable fixture")']}];
 cfg.feedback={...cfg.feedback,repo:'test/feedback',botAuthor:'app-bot',botAuthorId:101,triageActorIds:[202],publicAreas:['Documents'],publicTemplates:[{category:'bug',title:'Bug report — {area}',body:'A product bug report was submitted for {area}. Private details are retained for authorized triage. Reference: {marker}.'}]};
 writeFileSync(join(root,'evf.config.json'),JSON.stringify(cfg,null,2));
 const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.hooksPath','/dev/null');
 const bins=join(root,'fake-bin');mkdirSync(bins);const statePath=join(root,'gh-state.json');
 const state={repo:{id:301,node_id:'R_feedback',full_name:'test/feedback'},user:{id:202},issues:Array.from({length:5},(_,i)=>({number:i+1,node_id:`I_${i+1}`,title:'Bug report — Documents',body:'A product bug report was submitted for Documents. Private details are retained for authorized triage. Reference: 11111111-1111-4111-8111-111111111111.',html_url:`https://github.com/test/feedback/issues/${i+1}`,state:'open',created_at:'2026-10-01T00:00:00Z',user:{id:101,login:'app-bot'},labels:[{name:'needs-triage'}]})),comments:{} as Record<string,unknown[]>,calls:[] as unknown[]};
 writeFileSync(statePath,JSON.stringify(state));
 const fake=join(bins,'gh');writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs');const a=process.argv.slice(2),p=process.env.EVF_FAKE_GH_STATE;
if(!p)throw Error('No disposable fake-provider state');
const s=JSON.parse(fs.readFileSync(p,'utf8'));const opt=k=>a[a.indexOf(k)+1];
let body=a.includes('--body-file')?fs.readFileSync(opt('--body-file'),'utf8'):opt('--body');
s.calls.push({args:a,...(body?{body}: {})});
let result;
if(a[0]==='api') {
 const path=a.find(x=>x==='user'||x.startsWith('repos/')||x.startsWith('gists/'));
 if(s.api&&path in s.api)result=s.api[path];
 else if(path==='user')result=s.user;
 else if(path==='gists/a1b2c3')result='fixture-owner';
 else if(path==='repos/test/feedback')result=s.repo;
 else if(path==='repos/test/private')result=s.internalRepo||{id:401,node_id:'R_private'};
 else if(/issues\?/.test(path))result=[s.issues.filter(i=>path.includes('state=all')||i.state==='open')];
 else if(/issues\/\d+\/comments$/.test(path))result=[s.comments[path.split('/')[4]]||[]];
 else if(/issues\/\d+$/.test(path))result=s.issues.find(i=>i.number===Number(path.split('/').pop()));
 else if(/pulls\/\d+\/reviews/.test(path))result=[s.reviews||[]];
 else if(/commits\/.*\/status$/.test(path))result=s.commitStatus||{statuses:[]};
 else if(/statuses\//.test(path)&&a.includes('POST'))result={};
 else if(/branches\/main\/protection/.test(path))result=s.protection||{required_status_checks:{strict:true,contexts:['evf/verify']},enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true}};
}
else if(a[0]==='repo'&&a[1]==='view')result=a.includes('-q')||a.includes('--jq')?'test/private':{nameWithOwner:'test/private',isPrivate:true};
else if(a[0]==='pr'&&a[1]==='view')result=a.includes('mergeCommit')?s.mergeCommit:opt('--json')==='body'&&a.includes('--jq')?s.pr.body:s.pr||{number:77,url:'https://github.com/test/private/pull/77',state:'OPEN'};
else if(a[0]==='pr'&&a[1]==='checks'){result=s.requiredChecks??[];if(s.checksError){fs.writeFileSync(p,JSON.stringify(s));process.stdout.write(JSON.stringify(result));process.exit(s.checksError);}}
else if(a[0]==='pr'&&a[1]==='edit'){if(body&&s.pr)s.pr.body=body;result='';}
else if(a[0]==='pr'&&a[1]==='create')result='https://github.com/test/private/pull/78';
else if(a[0]==='gist'&&a[1]==='create')result='https://gist.github.com/fixture-owner/a1b2c3';
else if(a[0]==='pr'&&a[1]==='comment')result='https://github.com/test/private/pull/'+a[2]+'#comment';
else if(a[0]==='pr'&&a[1]==='merge'){
 if(!s.allowMerge){fs.writeFileSync(p,JSON.stringify(s));process.stderr.write('fixture merge barrier');process.exit(1);}
 const cp=require('node:child_process'),cwd=fs.realpathSync(process.cwd()+'/../..');
 cp.execFileSync('git',['-C',cwd,'merge','--no-ff','-m','Fixture reviewed merge',s.mergeBranch]);
 s.mergeCommit=cp.execFileSync('git',['-C',cwd,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 cp.execFileSync('git',['-C',cwd,'push','-q','origin','main']);result='';
}
else if(a[0]==='issue') {
 const n=Number(a[2]);
 if(a[1]==='comment'){(s.comments[n]??=[]).push({body,user:s.user});result='https://github.com/test/feedback/issues/'+n+'#comment';}
 if(a[1]==='edit'){const i=s.issues.find(i=>i.number===n);if(a.includes('--add-label'))i.labels.push(...opt('--add-label').split(',').map(name=>({name})));if(a.includes('--remove-label'))i.labels=i.labels.filter(l=>!opt('--remove-label').split(',').includes(l.name));result='';}
 if(a[1]==='close'){if(s.failClose){fs.writeFileSync(p,JSON.stringify(s));process.stderr.write('fixture close failure');process.exit(1);}s.issues.find(i=>i.number===n).state='closed';result='';}
 if(a[1]==='list')result=s.internalIssues||[];
 if(a[1]==='create'){if(s.failCreate){fs.writeFileSync(p,JSON.stringify(s));process.exit(1);}result='https://github.com/test/private/issues/'+(800+s.calls.filter(c=>c.args[0]==='issue'&&c.args[1]==='create').length);}
}
else if(a[0]==='label')result='';
if(result===undefined){fs.writeFileSync(p,JSON.stringify(s));throw Error('Unexpected external call: '+a.join(' '));}
fs.writeFileSync(p,JSON.stringify(s));process.stdout.write(typeof result==='string'?result:JSON.stringify(result));
`);chmodSync(fake,0o755);
 writeFileSync(join(root,'.gitignore'),'fake-bin/\ngh-state.json\n');git('add','docs','design/handoff','AGENTS.md','README.md','evf.config.json','.gitignore','.agents/skills/everyfield-pr','tools/evf/templates');git('commit','-qm','Disposable context');
 const oldPath=process.env.PATH,oldState=process.env.EVF_FAKE_GH_STATE;
 process.env.PATH=bins+':'+oldPath;process.env.EVF_FAKE_GH_STATE=statePath;
 return {root,cfg,git,
  getState:()=>JSON.parse(readFileSync(statePath,'utf8')),
  setState:(s:unknown)=>writeFileSync(statePath,JSON.stringify(s)),
  authorize:(wp='WP-001')=>{const progress=JSON.parse(readFileSync(progressPath,'utf8'));
   const prerequisites=new Set<string>();
   const visit=(id:string)=>{const pkg=dag.packages.find(p=>p.id===id)!;
    for(const dep of [...pkg.depends_on,...(pkg.ui_depends_on??[])])if(!prerequisites.has(dep)){prerequisites.add(dep);visit(dep);}
   };
   visit(wp);
   for(const id of prerequisites)progress.packages[id].status='done';
   writeFileSync(progressPath,JSON.stringify(progress));const p=join(root,'docs/plan/release-gates.json');const d=JSON.parse(readFileSync(p,'utf8'));for(const g of d.gates)g.status=g.id==='G-AUTH'?'authorized':g.id==='G-WORKFLOW'?'reconciled-independent-review':'approved';writeFileSync(p,JSON.stringify(d));writeFileSync(join(root,'evf.config.json'),JSON.stringify(cfg));},
  task:(slug='wp-001')=>{mkdirSync(join(root,'.worktrees'),{recursive:true});git('worktree','add','-b','task/'+slug,join(root,'.worktrees',slug),'main');return join(root,'.worktrees',slug);},
  commit:()=>{git('add','docs','evf.config.json');git('commit','-qm','Reviewed fixture policy');},
  close:()=>{process.env.PATH=oldPath;if(oldState===undefined)delete process.env.EVF_FAKE_GH_STATE;else process.env.EVF_FAKE_GH_STATE=oldState;rmSync(root,{recursive:true,force:true});}
 };
}
