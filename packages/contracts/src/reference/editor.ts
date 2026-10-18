import { z } from 'zod';

// Data only. Renderers must use text nodes and checked hrefs, never HTML/MDX evaluation.
export const safeHref = z.string().max(2048).refine(value => {
  if (/[\s\\\u0000-\u001f\u007f]/u.test(value) || value.startsWith('//')) return false;
  if (value.startsWith('#')) return /^#[\p{L}\p{N}_-]+$/u.test(value);
  if (value.startsWith('/')) return /^\/(?!\/)[A-Za-z0-9/_%.#?=&~-]*$/.test(value)
    && !/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value);
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, 'Unsafe link');
const text = z.strictObject({type:z.literal('text'), text:z.string().max(100_000),
  marks:z.array(z.enum(['bold','italic','code','strike'])).max(4).default([])});
const inline = z.discriminatedUnion('type', [text,
  z.strictObject({type:z.literal('link'),href:safeHref,children:z.array(text).max(200)})]);
const children = z.array(inline).max(2000);
const block = z.discriminatedUnion('type', [
  z.strictObject({type:z.literal('paragraph'),children}),
  z.strictObject({type:z.literal('heading'),level:z.number().int().min(1).max(4),children}),
  z.strictObject({type:z.literal('quote'),children}),
  z.strictObject({type:z.literal('list'),ordered:z.boolean(),items:z.array(children).max(1000)}),
  z.strictObject({type:z.literal('code'),language:z.enum(['text','json','csv']),text:z.string().max(100_000)}),
  z.strictObject({type:z.literal('table'),rows:z.array(z.array(children).min(1).max(30)).min(1).max(1000)}),
]);
export const editorDocument = z.strictObject({format:z.literal('everyfield-editor-v1'),blocks:z.array(block).max(5000)})
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 1_000_000, 'Document too large');
export type EditorDocument = z.infer<typeof editorDocument>;

// Word extraction belongs to the bounded server parser. This boundary accepts its plain text only.
export function importExtractedText(text: string): EditorDocument {
  return editorDocument.parse({format:'everyfield-editor-v1',blocks:text.replaceAll('\r\n','\n').split(/\n\n+/)
    .map(text => ({type:'paragraph',children:[{type:'text',text,marks:[]}]}))});
}
