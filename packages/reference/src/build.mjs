import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { verifySources } from '../verify.mjs';

const root = new URL('../../../', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const report = await verifySources(fileURLToPath(root));
if (!report.ok) throw Error('Source verification failed');
const sources = await Promise.all([...report.files, {path:'docs/reference/manifest.json',actual:{sha256:report.manifestSha256}}].map(async f => ({
  path: f.path, sha256: f.actual.sha256, body: await readFile(new URL(f.path, root), 'utf8'),
})));
// Extract only literals, never evaluate historical code or resolve its imports.
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => {
    if (!ts.isPropertyAssignment(p) || !p.name || !('text' in p.name)) throw Error('Nonliteral property');
    return [p.name.text, literal(p.initializer)];
  }));
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression);
  throw Error('Executable catalog initializer refused');
}
function catalog(path, name) {
  const source = sources.find(s => s.path === 'docs/reference/' + path);
  const ast = ts.createSourceFile(path, source.body, ts.ScriptTarget.Latest, true);
  let value;
  for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
    for (const d of statement.declarationList.declarations) if (d.name.getText(ast) === name) value = literal(d.initializer);
  }
  if (!value) throw Error('Missing literal catalog: ' + name);
  return value;
}
const criterionSource = sources.find(s => s.path === 'docs/reference/phase-exit-criteria.ts').body;
const criterionAst = ts.createSourceFile('criteria.ts', criterionSource, ts.ScriptTarget.Latest, true);
const criteria = [];
for (const statement of criterionAst.statements) if (ts.isVariableStatement(statement)) {
  for (const d of statement.declarationList.declarations) if (d.name.getText(criterionAst) === 'PHASE_EXIT_CRITERIA') {
    for (const phase of d.initializer.properties) for (const row of phase.initializer.elements) {
      const pick = key => literal(row.properties.find(p => p.name?.getText(criterionAst) === key).initializer);
      criteria.push({phase:Number(phase.name.getText(criterionAst)),key:pick('key')});
    }
  }
}
if (criteria.length !== 19) throw Error('Criterion identity inventory changed');
const data = {
  sources,
  catalogs: {
    tasks: catalog('task-templates.ts', 'TASK_TEMPLATES'),
    teams: catalog('ministry-role-templates.ts', 'TEAM_TEMPLATES'),
    documents: catalog('document-templates.ts', 'DOCUMENT_TEMPLATES'),
    launch: catalog('launch-milestone-templates.ts', 'LAUNCH_MILESTONE_TEMPLATES'),
    criteria,
    phases:[...sources.find(s => s.path === 'docs/reference/rubric-v1.md').body.matchAll(/^### Phase (\d) · (.+)$/gm)].map(m=>({phase:Number(m[1]),name:m[2]})),
  },
};
const artifact = JSON.stringify(data, null, 2) + '\n';
const freeze = JSON.stringify({version:1, sourceManifestSha256: report.manifestSha256,
  catalogSha256: report.catalog.sha256, artifactSha256: hash(artifact)}, null, 2) + '\n';
for (const [path, bytes] of [['artifacts.json', artifact], ['freeze.json', freeze]]) {
  const target = new URL(path, import.meta.url);
  if (process.argv.includes('--write')) await writeFile(target, bytes);
  else if (await readFile(target, 'utf8') !== bytes) throw Error('Frozen reference differs: ' + path);
}
console.log('Reference freeze: exact source bytes, literal catalogs and expected catalog digest agree.');
