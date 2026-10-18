import { fail, loadConfig, run, type Config } from './lib.ts';
import { cachedTriage } from './feedback.ts';
import { checkPr } from './ship.ts';

/**
 * Human-approved merge for the PRs that never merge automatically: Wiki articles, prototypes,
 * and P2/P3 feedback fixes the verifier passed (mergePolicy.feedbackOwnerAfterVerifier). Every
 * other PR refuses before any write. Sebastian approves in chat;
 * the agent runs this with his words. Agents never run it without that approval for this PR.
 * It records the approval on the PR, binds it to the exact head commit, and squash-merges.
 * When main is protected, it also posts the evf/verify status for that head.
 */

type Pr = { number: number; title: string; url: string; state: string; isDraft: boolean; baseRefName: string; headRefName: string; headRefOid: string; mergeStateStatus: string; files: Array<{ path: string }> };
type Route = { kind: 'wiki' | 'prototype' } | { kind: 'verified-feedback'; id: string };

function gh(args: string[]): string {
  const r = run('gh', args);
  if (r.code !== 0) fail(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

const readPr = (n: number): Pr => JSON.parse(gh(['pr', 'view', String(n), '--json', 'number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,files'])) as Pr;

/** Only the PR classes the owner policy names may merge on his approval; everything else refuses before any write. */
function routeOf(root: string, cfg: Config, pr: Pr): Route {
  const fb = /^task\/fb-(\d+)$/.exec(pr.headRefName);
  if (/^wiki\/[\w.-]+$/.test(pr.headRefName)) {
    const other = pr.files.map((f) => f.path).filter((path) => !path.startsWith('docs/reference/wiki/'));
    if (other.length) fail(`PR #${pr.number} is on a Wiki branch but changes files outside docs/reference/wiki/ (${other.slice(0, 3).join(', ')}). evf approve merges only Wiki article changes.`);
    return { kind: 'wiki' };
  }
  if (!fb) fail(`PR #${pr.number} (${pr.headRefName}) is not a Wiki article, prototype or P2/P3 feedback fix, so evf approve cannot merge it. Ordinary builds and OPS tasks merge through the verifier: bin/evf ship <task>.`);
  const id = `FB-${fb[1]}`;
  const cls = cachedTriage(root, Number(fb[1]))?.class;
  if (!cls) fail(`${id} has no local triage record, so its merge route is unknown. Triage it again on this machine (bin/evf feedback triage ${fb[1]} ...), then retry. evf approve does not guess.`);
  if (cls === 'feature-small') return { kind: 'prototype' };
  if ((cfg.mergePolicy.feedbackOwnerAfterVerifier as string[]).includes(cls)) return { kind: 'verified-feedback', id };
  if ((cfg.mergePolicy.feedbackVerifierMerge as string[]).includes(cls)) fail(`${id} is ${cls}. It merges through the verifier, not evf approve: bin/evf ship ${id}`);
  fail(`${id} is triaged ${cls}, which has no merge route through evf approve.`);
}

export function approve(root: string, n: number, opts: { ownerApproval?: string; head?: string }): number {
  const words = opts.ownerApproval?.trim() ?? '';
  if (words.split(/\s+/).filter(Boolean).length < 2) fail('Quote Sebastian\'s approval for this PR: evf approve <PR> --owner-approval "<his words>". Never run this without his approval in chat.');
  if (opts.head !== undefined && !/^[0-9a-f]{7,40}$/.test(opts.head)) fail('--head must be the approved commit SHA (at least 7 hex characters).');
  const cfg = loadConfig(root);
  const pr = readPr(n);
  if (pr.state !== 'OPEN') fail(`PR #${n} is ${pr.state.toLowerCase()}.`);
  if (pr.baseRefName !== cfg.baseBranch) fail(`PR #${n} targets ${pr.baseRefName}, not ${cfg.baseBranch}.`);
  const route = routeOf(root, cfg, pr);
  const head = pr.headRefOid;
  const again = route.kind === 'verified-feedback' ? `have the verifier pass the new head (bin/evf ship ${route.id}), then ask Sebastian to approve it` : 'ask Sebastian to approve the new head';
  if (opts.head && !head.startsWith(opts.head)) fail(`PR #${n} head is ${head.slice(0, 10)}, not the ${opts.head} Sebastian approved. His approval does not carry over: ${again}.`);
  // Updating the branch would create a head Sebastian never saw, so approve never updates it.
  if (pr.mergeStateStatus === 'BEHIND') fail(`PR #${n} is behind ${cfg.baseBranch}. Update it (gh pr update-branch ${n}), then ${again}. evf approve merges only the exact head he approved.`);

  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (route.kind === 'verified-feedback') {
    checkPr(root,n,head);
    const status = JSON.parse(gh(['api', `repos/${repo}/commits/${head}/status`])) as { statuses: Array<{ context: string; state: string; description: string | null }> };
    const verified = status.statuses.find((s) => s.context === cfg.statusContext);
    if (verified?.state !== 'success' || !verified.description?.startsWith('Verified')) fail(`PR #${n} is a P2/P3 feedback fix. The verifier must pass it first (bin/evf ship ${route.id}) at ${head.slice(0, 10)}; a branch update needs a fresh verification.`);
  }
  gh(['pr', 'comment', String(n), '--body', `Approved by Sebastian at \`${head.slice(0, 10)}\`:\n\n> ${words.replace(/\n/g, '\n> ')}`]);
  if (pr.isDraft) gh(['pr', 'ready', String(n)]);
  const protectedMain = run('gh', ['api', `repos/${repo}/branches/${cfg.baseBranch}/protection`]).code === 0;
  if (protectedMain) gh(['api', '-X', 'POST', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', `context=${cfg.statusContext}`, '-f', `description=Approved by Sebastian at ${head.slice(0, 10)}`]);
  gh(['pr', 'merge', String(n), '--squash', '--match-head-commit', head]);
  console.log(`Merged PR #${n} (${pr.title}) at ${head.slice(0, 10)} with Sebastian's approval.`);
  return 0;
}
