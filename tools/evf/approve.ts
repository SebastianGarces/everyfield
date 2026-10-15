import { fail, loadConfig, run } from './lib.ts';

/**
 * Human-approved merge for PRs that never merge automatically (Wiki articles, prototypes,
 * feedback classes outside mergePolicy.feedbackVerifierMerge). Sebastian approves in chat;
 * the agent runs this with his words. Agents never run it without that approval for this PR.
 * It records the approval on the PR, binds it to the exact head commit, and squash-merges.
 * When main is protected, it also posts the evf/verify status for that head.
 */

type Pr = { number: number; title: string; url: string; state: string; isDraft: boolean; baseRefName: string; headRefOid: string; mergeStateStatus: string };

function gh(args: string[]): string {
  const r = run('gh', args);
  if (r.code !== 0) fail(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

const readPr = (n: number): Pr => JSON.parse(gh(['pr', 'view', String(n), '--json', 'number,title,url,state,isDraft,baseRefName,headRefOid,mergeStateStatus'])) as Pr;

export function approve(root: string, n: number, opts: { ownerApproval?: string; head?: string }): number {
  const words = opts.ownerApproval?.trim() ?? '';
  if (words.split(/\s+/).filter(Boolean).length < 2) fail('Quote Sebastian\'s approval for this PR: evf approve <PR> --owner-approval "<his words>". Never run this without his approval in chat.');
  const cfg = loadConfig(root);
  let pr = readPr(n);
  if (pr.state !== 'OPEN') fail(`PR #${n} is ${pr.state.toLowerCase()}.`);
  if (pr.baseRefName !== cfg.baseBranch) fail(`PR #${n} targets ${pr.baseRefName}, not ${cfg.baseBranch}.`);
  if (opts.head && !pr.headRefOid.startsWith(opts.head)) fail(`PR #${n} head is ${pr.headRefOid.slice(0, 10)}, not the ${opts.head} Sebastian approved. Ask him again.`);
  if (pr.mergeStateStatus === 'BEHIND') {
    gh(['pr', 'update-branch', String(n)]);
    pr = readPr(n);
    console.log(`Updated PR #${n} from ${cfg.baseBranch}; its own changes are unchanged.`);
  }

  const head = pr.headRefOid;
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  gh(['pr', 'comment', String(n), '--body', `Approved by Sebastian at \`${head.slice(0, 10)}\`:\n\n> ${words.replace(/\n/g, '\n> ')}`]);
  if (pr.isDraft) gh(['pr', 'ready', String(n)]);
  const protectedMain = run('gh', ['api', `repos/${repo}/branches/${cfg.baseBranch}/protection`]).code === 0;
  if (protectedMain) gh(['api', '-X', 'POST', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', `context=${cfg.statusContext}`, '-f', `description=Approved by Sebastian at ${head.slice(0, 10)}`]);
  gh(['pr', 'merge', String(n), '--squash', '--match-head-commit', head]);
  console.log(`Merged PR #${n} (${pr.title}) at ${head.slice(0, 10)} with Sebastian's approval.`);
  return 0;
}
