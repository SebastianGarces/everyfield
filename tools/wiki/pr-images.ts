import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export async function prImages(pr: number, files: string[], update: boolean, root: string) {
  const names = files.map(file => basename(file));
  if (new Set(names).size !== names.length) throw new Error('PNG basenames must be unique');
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/.test(basename(file))) throw new Error(`Use a simple .png filename: ${file}`);
    const bytes = await readFile(file);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Not a PNG: ${file}`);
  }
  const temp = await mkdtemp(join(tmpdir(), 'wiki-gist-'));
  try {
    const repo = execFileSync('gh', ['repo','view','--json','nameWithOwner','--jq','.nameWithOwner'], { cwd: root, encoding: 'utf8' }).trim();
    let body = gh('pr','view',String(pr),'--repo',repo,'--json','body','--jq','.body');
    let id = /<!-- wiki-screenshots-gist: ([a-f0-9]+) -->/.exec(body)?.[1];
    const bodyPath = join(temp, 'body.txt');
    const saveBody = () => { return writeFile(bodyPath, body).then(() => gh('pr','edit',String(pr),'--repo',repo,'--body-file',bodyPath)); };
    if (!id) {
      const intro = join(temp, 'wiki-screenshots.txt');
      await writeFile(intro, `EveryField Wiki review screenshots for ${repo} PR #${pr}.\n`);
      const url = gh('gist','create',intro,'--desc',`${repo} PR #${pr}: Wiki screenshots`);
      id = /\/([a-f0-9]+)$/.exec(url)?.[1];
      if (!id) throw new Error('Could not read the created gist id');
      body += `\n\n<!-- wiki-screenshots-gist: ${id} -->`;
      await saveBody(); // Bind immediately, so retries reuse the gist even if upload fails.
    }
    const owner = gh('api',`gists/${id}`,'--jq','.owner.login');
    const checkout = join(temp, 'gist');
    git(temp, 'clone', `https://gist.github.com/${id}.git`, checkout);
    for (const name of git(checkout, 'ls-files', '*.png').split('\n').filter(Boolean)) if (!names.includes(name)) await unlink(join(checkout, name));
    for (const file of files) await copyFile(file, join(checkout, basename(file)));
    git(checkout, 'add', '--all');
    if (git(checkout, 'diff', '--cached', '--name-only')) {
      git(checkout, '-c','user.name=Wiki screenshots','-c',`user.email=${owner}@users.noreply.github.com`, 'commit','-m',`Update Wiki screenshots for PR #${pr}`);
      // This host rejects chunked uploads once full-page PNG packs exceed Git's 1 MiB buffer.
      git(checkout, '-c', 'http.postBuffer=52428800', 'push', 'origin', 'HEAD');
    }
    const lines = names.map(name => `![${name.replace(/\.png$/, '')}](https://gist.githubusercontent.com/${owner}/${id}/raw/${name})`).join('\n\n');
    if (update) {
      const block = `<!-- wiki-screenshots -->\n${lines}\n<!-- /wiki-screenshots -->`;
      const pattern = /<!-- wiki-screenshots -->[\s\S]*?<!-- \/wiki-screenshots -->/;
      body = pattern.test(body) ? body.replace(pattern, block) : `${body}\n\n${block}`;
      await saveBody();
    }
    console.log(lines);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
