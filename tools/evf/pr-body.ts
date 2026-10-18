import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './lib.ts';

const TEMPLATES={ordinary:'.agents/skills/everyfield-pr/template.md',wiki:'tools/evf/templates/wiki-pr.md',prototype:'tools/evf/templates/prototype-pr.md'};
export type PrBodyClass=keyof typeof TEMPLATES;
const withoutComments=(text:string)=>text.replace(/<!--[^]*?(?:-->|$)/g,'').replace(/\r\n/g,'\n');

/** Metadata chooses a body format only. Merge authority stays with ship and approve. */
export function prBodyClass(pr:unknown):PrBodyClass {
 if(!pr||typeof pr!=='object'||!('headRefName' in pr)||typeof pr.headRefName!=='string')return 'ordinary';
 if(/^wiki\/[\w.-]+$/.test(pr.headRefName)) {
  if(!('files' in pr)||!Array.isArray(pr.files)||!pr.files.length||!pr.files.every(file=>file&&typeof file.path==='string'&&file.path.startsWith('docs/reference/wiki/')))fail('Wiki PR body format requires every changed file to stay in docs/reference/wiki/.');
  return 'wiki';
 }
 if(/^task\/fb-\d+$/.test(pr.headRefName)&&'labels' in pr&&Array.isArray(pr.labels)&&pr.labels.some(label=>label?.name==='prototype'))return 'prototype';
 return 'ordinary';
}

/** Ignore headings and machine lines inside examples, while retaining their content for evidence. */
function plainLines(lines:string[]):Array<{text:string;index:number}> {
 const plain:Array<{text:string;index:number}>=[];
 let fence:{marker:string;length:number}|null=null;
 for(const [index,text] of lines.entries()) {
  const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if(fence) {
   if(match&&match[1][0]===fence.marker&&match[1].length>=fence.length&&!match[2].trim())fence=null;
  } else if(match)fence={marker:match[1][0],length:match[1].length};
  else plain.push({text,index});
 }
 return plain;
}

/** Each class template owns its required sections. This check has no CI or review dependency. */
export function checkPrBody(root:string,body:string,kind:PrBodyClass='ordinary'):{kind:PrBodyClass;sections:string[];authorFamily:'openai'|'anthropic'} {
 const template=TEMPLATES[kind],path=join(root,template);
 if(!existsSync(path))fail(`PR body template is missing: ${template}.`);
 const sections=plainLines(withoutComments(readFileSync(path,'utf8')).split('\n')).filter(l=>l.text.startsWith('## ')).map(l=>l.text);
 if(!sections.length||new Set(sections).size!==sections.length)fail('PR body template must define distinct required sections.');
 const lines=withoutComments(body).split('\n'),plain=plainLines(lines);
 const headings=plain.filter(l=>l.text.startsWith('## '));
 const found=headings.filter(l=>sections.includes(l.text));
 if(JSON.stringify(found.map(l=>l.text))!==JSON.stringify(sections)) {
  const missing=sections.filter(section=>!found.some(l=>l.text===section));
  fail(missing.length?`PR body is missing required sections: ${missing.join(', ')}.`:'PR body required sections must appear exactly once, in template order.');
 }
 const authors=plain.filter(l=>l.text.startsWith('EVF-Author:'));
 if(authors.length!==1)fail('PR body needs exactly one EVF-Author model-family line.');
 const author=authors[0],family=author.text.slice('EVF-Author: '.length);
 if(family!=='openai'&&family!=='anthropic')fail('EVF-Author must be openai or anthropic.');
 if(headings.some(heading=>heading.index>=author.index))fail('EVF-Author must follow the last PR body section.');
 for(const heading of found) {
  const end=headings.find(l=>l.index>heading.index)?.index??author.index;
  const content=lines.slice(heading.index+1,Math.min(end,author.index)).filter(line=>!/^\s*(?:#{1,6}\s|`{3,}|~{3,})/.test(line)).join('\n').trim();
  if(!content)fail(`PR body section has no content: ${heading.text}.`);
 }
 const footer=lines.slice(author.index+1).filter(line=>line.trim());
 if(footer.length!==1||!/^🤖 Generated with \[[^\]]+\]\(https:\/\/[^)]+\)$/.test(footer[0]))fail('End the PR body with its attribution line after EVF-Author.');
 return {kind,sections,authorFamily:family};
}
