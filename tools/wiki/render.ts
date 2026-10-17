import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createElement as h, Children, isValidElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compiledComponent } from './mdx.ts';
import type { ObjectRow } from './rows.ts';

const notice = 'Scripture quotations taken from the (LSB®) Legacy Standard Bible®, Copyright © 2021 by The Lockman Foundation. Used by permission. All rights reserved. Managed in partnership with Three Sixteen Publishing Inc. LSBible.org and 316publishing.com.';
const tones: Record<string, string> = { tip: 'green', insight: 'blue', warning: 'amber', important: 'violet' };
function Callout({ type, children }: { type: string; children: ReactNode }) {
  if (type === 'scripture') {
    // The restricted MDX shape is one paragraph, emphasis quote, then its attribution.
    const paragraph = Children.toArray(children).find(isValidElement<{ children: ReactNode }>);
    const parts = paragraph ? Children.toArray(paragraph.props.children) : [];
    const attribution = parts.find(p => typeof p === 'string' && p.includes('—'));
    return h('blockquote', {}, parts.filter(p => p !== attribution), h('cite', {}, typeof attribution === 'string' ? attribution.replace(/^\s*—\s*/, '') : ''));
  }
  return h('aside', { className: 'card', 'data-variant': 'callout', 'data-tone': tones[type] }, h('div', { className: 'callout-label' }, h('span', { className: 'ci', 'aria-hidden': true }, type.slice(0, 1).toUpperCase()), type[0].toUpperCase() + type.slice(1)), h('div', { className: 'callout-text' }, children));
}
function slice(css: string, start: string, end: string) {
  const a = css.indexOf(start), b = css.indexOf(end, a);
  if (a === -1 || b === -1) throw new Error(`Design CSS changed; cannot find ${start}`);
  return css.slice(a, b);
}
export async function render(row: ObjectRow, code: string, section: string, root: string, out: string) {
  const [tokens, design] = await Promise.all([readFile(resolve(root, 'design/handoff/tokens.css'), 'utf8'), readFile(resolve(root, 'design/everyfield-ui.html'), 'utf8')]);
  const css = tokens.replace(/^@import[^;]+;/gm, '') + slice(design, '.prose {', '.toc {') + slice(design, '.card[data-variant="callout"] {', '.card[data-size="sm"]');
  const Component = await compiledComponent(code);
  const markup = renderToStaticMarkup(h('html', { lang: 'en' }, h('head', {}, h('meta', { charSet: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }), h('title', {}, String(row.title)), h('style', {}, css + `
*{box-sizing:border-box}body{margin:0;background:var(--ef-surface);font-family:var(--ef-font-body);color:var(--ef-ink)}
main{max-width:796px;margin:0 auto;padding:56px 48px}h1,h2,h3{font-family:var(--ef-font-display);font-weight:500;letter-spacing:-.02em}h1{font-size:42px;line-height:1.12;margin:16px 0}header{margin-bottom:32px}.meta,footer{color:var(--ef-text-3);font-size:13px}.excerpt{font-size:18px;line-height:1.6;color:var(--ef-ink-2)}.badge{display:inline-block;background:var(--ef-amber-100);color:var(--ef-amber-600);padding:4px 8px;border-radius:6px;font-size:12px;font-weight:600}.card{margin:22px 0}.prose hr{border:0;border-top:1px solid var(--ef-line-2);margin:28px 0}.prose table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.5;margin:20px 0;overflow-wrap:anywhere}.prose th,.prose td{border:1px solid var(--ef-line-2);padding:10px 12px;text-align:left;vertical-align:top}.prose th{background:var(--ef-surface-2);color:var(--ef-ink);font-weight:600}.prose .contains-task-list{list-style:none;padding-left:0}.prose .task-list-item{position:relative;padding:4px 0;padding-inline-start:24px}.prose input[type=checkbox]{position:absolute;inset-inline-start:0;top:9px;width:16px;height:16px;margin:0;accent-color:var(--ef-green-700)}.prose pre{max-width:100%;overflow-x:auto}.prose p,.prose li{overflow-wrap:anywhere}.prose .callout-text p:last-child{margin-bottom:0}footer{line-height:1.5}footer small{font-size:11px}@media(max-width:600px){main{padding:28px 20px}h1{font-size:34px}.prose{font-size:16px}.prose h2{font-size:24px}.prose th,.prose td{padding:7px 8px;font-size:12px}}`)), h('body', {}, h('main', {}, h('header', {}, row.status === 'draft' ? h('span', { className: 'badge' }, 'DRAFT') : null, h('p', { className: 'meta' }, `${section} · Phase ${row.phase} · ${row.read_time_minutes} min read`), h('h1', {}, String(row.title)), h('p', { className: 'excerpt' }, String(row.excerpt))), h('article', { className: 'prose' }, h(Component, { components: { Callout } })), h('footer', { className: 'prose-foot' }, h('small', {}, notice))))));
  await mkdir(out, { recursive: true });
  const file = resolve(out, String(row.slug).replaceAll('/', '--') + '.html');
  await writeFile(file, '<!doctype html>\n' + markup + '\n');
  return file;
}
