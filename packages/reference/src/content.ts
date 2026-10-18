import { createProcessor } from '@mdx-js/mdx';
import { safeHref } from '@everyfield/contracts/reference';
const processor = createProcessor();
function object(value: unknown): value is Record<string, unknown> {return typeof value==='object'&&value!==null&&!Array.isArray(value);}

// Parse without compilation/evaluation. The grammar is closed to one reviewed inert component.
export function safeMdx(body: string, slugs: ReadonlySet<string>): boolean {
  if (Buffer.byteLength(body)>1_000_000) return false;
  try {
    const tree=processor.parse(body);
    function visit(node: unknown): boolean {
      if(!object(node)||typeof node.type!=='string') return false;
      if(['mdxjsEsm','mdxFlowExpression','mdxTextExpression','html'].includes(node.type)) return false;
      if(node.type==='mdxJsxFlowElement'||node.type==='mdxJsxTextElement') {
        if(node.name!=='Callout'||!Array.isArray(node.attributes)||node.attributes.length!==1) return false;
        const a:unknown=node.attributes[0];
        if(!object(a)||a.type!=='mdxJsxAttribute'||a.name!=='type'||typeof a.value!=='string'
          ||!['tip','scripture','insight','warning','important'].includes(a.value)) return false;
      }
      if(node.type==='link'||node.type==='definition'||node.type==='image') {
        if(!safeHref.safeParse(node.url).success||typeof node.url!=='string') return false;
        if(node.url.startsWith('/wiki/')&&!slugs.has(node.url.slice(6).split('#')[0]!)) return false;
        // Remote media is not an approved native or global component.
        if(node.type==='image') return false;
      }
      return !Array.isArray(node.children)||node.children.every(visit);
    }
    return visit(tree);
  }catch{return false;}
}
