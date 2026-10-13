import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
export const source=resolve(import.meta.dirname,'../../..');
export function fixture() {
 const root=mkdtempSync(join(tmpdir(),'evf-regression-'));
 cpSync(join(source,'docs'),join(root,'docs'),{recursive:true});
 cpSync(join(source,'AGENTS.md'),join(root,'AGENTS.md'));
 const cfg=JSON.parse(readFileSync(join(source,'evf.config.json'),'utf8'));
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
 const path=a.find(x=>x==='user'||x.startsWith('repos/'));
 if(path==='user')result=s.user;
 else if(path==='repos/test/feedback')result=s.repo;
 else if(path==='repos/test/private')result=s.internalRepo||{id:401,node_id:'R_private'};
 else if(/issues\?/.test(path))result=[s.issues.filter(i=>path.includes('state=all')||i.state==='open')];
 else if(/issues\/\d+\/comments$/.test(path))result=[s.comments[path.split('/')[4]]||[]];
 else if(/issues\/\d+$/.test(path))result=s.issues.find(i=>i.number===Number(path.split('/').pop()));
 else if(/pulls\/\d+\/reviews/.test(path))result=[s.reviews||[]];
 else if(/statuses\//.test(path)&&a.includes('POST'))result={};
 else if(/branches\/main\/protection/.test(path))result=s.protection||{required_status_checks:{strict:true,contexts:['evf/verify']},enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true}};
}
else if(a[0]==='repo'&&a[1]==='view')result=a.includes('-q')?'test/private':{nameWithOwner:'test/private',isPrivate:true};
else if(a[0]==='pr'&&a[1]==='view')result=s.pr||{number:77,url:'https://github.com/test/private/pull/77',state:'OPEN'};
else if(a[0]==='pr'&&a[1]==='merge'){fs.writeFileSync(p,JSON.stringify(s));process.stderr.write('fixture merge barrier');process.exit(1);}
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
 writeFileSync(join(root,'.gitignore'),'fake-bin/\ngh-state.json\n');git('add','docs','AGENTS.md','evf.config.json','.gitignore');git('commit','-qm','Disposable context');
 const oldPath=process.env.PATH,oldState=process.env.EVF_FAKE_GH_STATE;
 process.env.PATH=bins+':'+oldPath;process.env.EVF_FAKE_GH_STATE=statePath;
 return {root,cfg,git,
  getState:()=>JSON.parse(readFileSync(statePath,'utf8')),
  setState:(s:unknown)=>writeFileSync(statePath,JSON.stringify(s)),
  authorize:()=>{const p=join(root,'docs/plan/release-gates.json');const d=JSON.parse(readFileSync(p,'utf8'));for(const g of d.gates)g.status=g.id==='G-AUTH'?'authorized':g.id==='G-WORKFLOW'?'reconciled-independent-review':'approved';writeFileSync(p,JSON.stringify(d));},
  task:(slug='wp-001')=>{mkdirSync(join(root,'.worktrees'),{recursive:true});git('worktree','add','-b','task/'+slug,join(root,'.worktrees',slug),'main');return join(root,'.worktrees',slug);},
  commit:()=>{git('add','docs','evf.config.json');git('commit','-qm','Reviewed fixture policy');},
  close:()=>{process.env.PATH=oldPath;if(oldState===undefined)delete process.env.EVF_FAKE_GH_STATE;else process.env.EVF_FAKE_GH_STATE=oldState;rmSync(root,{recursive:true,force:true});}
 };
}
