import { spawnSync } from 'node:child_process';
import { fail, loadConfig, run } from './lib.ts';

/**
 * Human-approved merge for PRs that never merge automatically (Wiki articles, prototypes,
 * feedback classes outside mergePolicy.feedbackVerifierMerge). It runs only in an interactive
 * terminal and asks Sebastian to type the PR number, so an agent shell cannot use it.
 * The evf/verify status it posts names the exact head commit he approved.
 */

type Pr = { number: number; title: string; url: string; state: string; isDraft: boolean; baseRefName: string; headRefOid: string; mergeStateStatus: string; files: Array<{ path: string }> };

function gh(args: string[]): string {
  const r = run('gh', args);
  if (r.code !== 0) fail(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

const readPr = (n: number): Pr => JSON.parse(gh(['pr', 'view', String(n), '--json', 'number,title,url,state,isDraft,baseRefName,headRefOid,mergeStateStatus,files'])) as Pr;

function askLine(prompt: string): string {
  process.stdout.write(prompt);
  const r = spawnSync('/bin/sh', ['-c', 'IFS= read -r line < /dev/tty && printf %s "$line"'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

export function approve(root: string, n: number, io: { interactive: boolean } = { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) }): number {
  if (!io.interactive) fail("evf approve runs only in Sebastian's own terminal. Agents: report the PR and ask Sebastian to run `bin/evf approve <PR>`.");
  const cfg = loadConfig(root);
  let pr = readPr(n);
  if (pr.state !== 'OPEN') fail(`PR #${n} is ${pr.state.toLowerCase()}.`);
  if (pr.baseRefName !== cfg.baseBranch) fail(`PR #${n} targets ${pr.baseRefName}, not ${cfg.baseBranch}.`);
  if (pr.mergeStateStatus === 'BEHIND') {
    console.log(`PR #${n} is behind ${cfg.baseBranch}. Updating the branch (this merges ${cfg.baseBranch} in; the PR's own changes stay the same).`);
    gh(['pr', 'update-branch', String(n)]);
    pr = readPr(n);
  }

  console.log(`\nPR #${pr.number}: ${pr.title}\n${pr.url}\nHead commit: ${pr.headRefOid}${pr.isDraft ? '\nThis PR is a draft. Approving marks it ready and merges it.' : ''}`);
  console.log(`Files (${pr.files.length}):`);
  for (const f of pr.files.slice(0, 20)) console.log(`  ${f.path}`);
  if (pr.files.length > 20) console.log(`  ... and ${pr.files.length - 20} more`);
  const answer = askLine(`\nYou approve this exact commit. Type ${n} to approve and merge, anything else to stop: `);
  if (answer !== String(n)) {
    console.log('Stopped. Nothing changed.');
    return 1;
  }

  const head = readPr(n).headRefOid;
  if (head !== pr.headRefOid) fail(`The PR changed while you were reading (now ${head.slice(0, 10)}). Run evf approve again.`);
  const login = gh(['api', 'user', '-q', '.login']);
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (pr.isDraft) gh(['pr', 'ready', String(n)]);
  gh(['api', '-X', 'POST', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', `context=${cfg.statusContext}`, '-f', `description=Approved by ${login} after review at ${head.slice(0, 10)}`]);
  gh(['pr', 'merge', String(n), '--squash', '--match-head-commit', head]);
  console.log(`Merged PR #${n} at ${head.slice(0, 10)}, approved by ${login}.`);
  return 0;
}
