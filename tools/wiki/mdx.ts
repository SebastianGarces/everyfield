import { compile, run } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import * as runtime from 'react/jsx-runtime';
import type { Root, RootContent } from 'mdast';

export const calloutTypes = ['tip', 'insight', 'warning', 'important', 'scripture'];
const tells = ['delve', 'tapestry', 'testament to', "in today's", 'fast-paced', 'navigate the complexities', 'unlock', 'game-changer', "it's important to note", 'it is important to note', 'embark', 'seamless', 'leverage', 'robust', 'elevate', 'realm', 'ever-evolving', 'furthermore', 'moreover', 'in conclusion', 'at the end of the day'];
const verse = /^(?:[1-3] )?[A-Z][a-z]+(?: [A-Z][a-z]+)? \d+:\d+[a-z]?(?:[-–]\d+[a-z]?)?(?: \((?:LSB|ESV|KJV|NLT)\))?$/;
export const scripture = /^\s*\*"([^"]+)"\*\s+—\s+([^\n]+?)\s*$/;

export async function inspect(content: string, known: Set<string>, seed = false) {
  const errors: string[] = [], warnings: string[] = [];
  let h2 = 0, callouts = 0, verses = 0;
  const links: string[] = [];
  const refs: string[] = [];
  const definitions = new Map<string, string>();
  function walk(node: Root | RootContent) {
    if (node.type === 'heading') {
      if (node.depth === 1) errors.push('H1 in body; the row supplies the title');
      if (node.depth === 2) h2++;
    }
    if (node.type === 'mdxjsEsm' || node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') errors.push('JS expression, import or export is forbidden');
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      const attrs = node.attributes;
      const type = attrs.length === 1 && attrs[0].type === 'mdxJsxAttribute' && attrs[0].name === 'type' ? attrs[0].value : null;
      if (node.name !== 'Callout' || typeof type !== 'string' || !calloutTypes.includes(type)) errors.push('Only <Callout type="tip|insight|warning|important|scripture"> is allowed');
      if (node.name === 'Callout') callouts++;
      if (node.name === 'Callout' && type === 'scripture') {
        verses++;
        const source = content.slice(node.position?.start.offset, node.position?.end.offset);
        const inside = source.replace(/^<Callout\b[^>]*>/, '').replace(/<\/Callout>$/, '');
        const match = scripture.exec(inside);
        if (!match || !verse.test(match[2]) || (!seed && !match[2].endsWith(' (LSB)'))) errors.push('Scripture must be *"verse text"* — Book 1:2 (LSB), with one quote per callout');
      }
    }
    if (node.type === 'link' || node.type === 'image') links.push(node.url);
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
    if (node.type === 'linkReference' || node.type === 'imageReference') refs.push(node.identifier);
    if ('children' in node) for (const child of node.children) walk(child);
  }
  let code: string | undefined;
  try {
    code = String(await compile(content, { outputFormat: 'function-body', remarkPlugins: [remarkGfm, () => (tree: Root) => { walk(tree); }] }));
  } catch (error) { errors.push(`MDX does not compile: ${error instanceof Error ? error.message : String(error)}`); }
  for (const ref of refs) { const url = definitions.get(ref); if (url) links.push(url); }
  for (const url of links) {
    if (url.startsWith('/wiki/')) {
      const slug = decodeURI(url.slice(6).split(/[?#]/)[0]).replace(/\/$/, '');
      if (!known.has(slug)) errors.push(`Internal link to unknown article: ${url}`);
    } else if (/^https?:\/\//i.test(url)) warnings.push(`External body link: ${url}; keep research in draft.sources`);
    else if (/^(?:javascript|data|vbscript):/i.test(url)) errors.push(`Unsafe link: ${url}`);
  }
  const plain = content.replace(/<[^>]+>/g, '');
  const words = (plain.match(/[\p{L}\p{N}_]+/gu) || []).length;
  if (words < 500 || words > 2500) errors.push(`${words} words; allowed 500–2,500`);
  if (words < 800 || words > 1600) warnings.push(`${words} words; aim for 800–1,600`);
  if (h2 < 3 || h2 > 14) errors.push(`${h2} H2 headings; allowed 3–14`);
  if (h2 > 11) warnings.push(`${h2} H2 headings; aim for 11 or fewer`);
  if (callouts < 1 || callouts > 9) errors.push(`${callouts} callouts; allowed 1–9`);
  if (callouts < 2 || callouts > 7) warnings.push(`${callouts} callouts; aim for 2–7`);
  if (!verses) errors.push('No scripture callout');
  if (/\bTODO\b|\bTBD\b|\[citation needed\]|lorem ipsum|\bXX+\b|\[insert|\{\{|\[\[RULING:/i.test(content)) errors.push('Placeholder text remains');
  const phrases = tells.filter(t => plain.toLowerCase().includes(t));
  if (phrases.length) warnings.push(`AI-tell phrases: ${phrases.join(', ')}`);
  return { code, words, errors, warnings };
}

export async function compiledComponent(code: string) {
  return (await run(code, { ...runtime, baseUrl: import.meta.url })).default;
}
