const REPOSITORY = 'SebastianGarces/everyfield';
const DEPLOY_WORKFLOW = 'deploy-production.yml';
const VERCEL_CLI = 'vercel@65.11.0';
const SHA = /^[0-9a-f]{40}$/;
// deploy-production's job has a 30-minute timeout and starts at push time, before CI ends, so 40 minutes from
// here always outlasts it.
const WAIT_MS = 40 * 60 * 1000;
const POLL_MS = 30 * 1000;
// Vercel may stamp a deployment a little before GitHub records the run that made it.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const BUILDING = new Set(['QUEUED', 'INITIALIZING', 'BUILDING']);
const ANCESTOR_RUNS = 100;

function promoteCommand(deploymentId, scope) {
  return ['npx', ['--yes', VERCEL_CLI, 'promote', deploymentId, '--yes', ...(scope ? ['--scope', scope] : [])]];
}

async function say(core, line) {
  core.info(line);
  await core.summary.addRaw(`${line}\n`).write();
}

async function fail(core, line) {
  await say(core, line);
  core.setFailed(line);
  return { outcome: 'failed', reason: line };
}

function vercelClient(token, scope, fetchImpl) {
  return async function vercel(path, query = {}) {
    const url = new URL(path, 'https://api.vercel.com');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    if (scope) url.searchParams.set('slug', scope);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Vercel API ${url.pathname} returned HTTP ${response.status}`);
    return response.json();
  };
}

// True when `newer` contains `older` (the same commit or a descendant of it).
async function contains(github, repo, newer, older) {
  const comparison = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${older}...${newer}` });
  return ['ahead', 'identical'].includes(comparison.data.status);
}

async function pushRuns(github, repo, query) {
  const response = await github.rest.actions.listWorkflowRuns({
    ...repo, workflow_id: DEPLOY_WORKFLOW, event: 'push', branch: 'main', ...query,
  });
  return response.data.workflow_runs
    .filter(run => run.event === 'push' && run.head_branch === 'main' && SHA.test(run.head_sha || ''))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

// The newest deploy-production push run of a commit that `sha` contains, other than `sha` itself.
async function deployingAncestor(github, repo, sha) {
  for (const run of await pushRuns(github, repo, { per_page: ANCESTOR_RUNS })) {
    if (run.head_sha !== sha && await contains(github, repo, sha, run.head_sha)) return run;
  }
  return undefined;
}

// Production deployments of the project that the Vercel CLI stamped with this commit, newest first.
async function deploymentsOf(vercel, projectId, sha, since) {
  const found = [];
  let until;
  for (let page = 0; page < 10; page++) {
    const body = await vercel('/v7/deployments', {
      projectId, target: 'production', since, limit: 100, ...(until ? { until } : {}),
    });
    for (const d of body.deployments || []) {
      if (d.meta?.githubCommitSha === sha && d.target === 'production' && d.projectId === projectId) found.push(d);
    }
    until = body.pagination?.next;
    if (!until) break;
  }
  return found.sort((a, b) => b.created - a.created);
}

async function waitForBuild({ github, repo, vercel, projectId, sha, run, sleep, now, waitMs, pollMs }) {
  const deadline = now() + waitMs;
  const since = Date.parse(run.created_at) - CLOCK_SKEW_MS;
  for (;;) {
    const deployments = await deploymentsOf(vercel, projectId, sha, since);
    const ready = deployments.find(d => d.readyState === 'READY');
    if (ready) return { ready };
    const latest = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })).data;
    const building = deployments.some(d => BUILDING.has(d.readyState));
    if (latest.status === 'completed' && !building) {
      const ended = deployments[0]?.readyState;
      return {
        why: ended
          ? `the Vercel production build of ${sha} ended in ${ended} (deploy-production run ${run.id} concluded ${latest.conclusion})`
          : `deploy-production run ${run.id} for ${sha} concluded ${latest.conclusion} without a Vercel production deployment`,
      };
    }
    if (now() >= deadline) {
      return { why: `no READY Vercel production deployment exists for ${sha} after waiting ${Math.round(waitMs / 60000)} minutes` };
    }
    await sleep(pollMs);
  }
}

module.exports = async function promote({ github, context, core, exec }, options = {}) {
  const repo = context.repo;
  if (`${repo.owner}/${repo.repo}` !== REPOSITORY) throw new Error('Unexpected promote repository');
  const env = options.env || process.env;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const waitMs = options.waitMs ?? WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;

  const missing = [];
  if (env.TRUNK_PROMOTE !== 'true') missing.push('the repo variable TRUNK_PROMOTE is not "true"');
  if (!env.VERCEL_TOKEN) missing.push('the VERCEL_TOKEN secret is not set');
  if (missing.length) {
    await say(core, `Promote is off: ${missing.join(' and ')}. Nothing was promoted.`);
    return { outcome: 'off', missing };
  }

  const run = context.eventName === 'workflow_run' ? context.payload.workflow_run : undefined;
  if (!run || run.path !== '.github/workflows/ci.yml' || run.event !== 'push' || run.head_branch !== 'main' ||
      run.head_repository?.full_name !== REPOSITORY || !SHA.test(run.head_sha || '')) {
    await say(core, 'This run is not a push CI run on main of this repository. Nothing was promoted.');
    return { outcome: 'ignored' };
  }
  const sha = run.head_sha;
  if (run.conclusion !== 'success') {
    await say(core, `CI on main concluded ${run.conclusion} at ${sha}. Nothing was promoted.`);
    return { outcome: 'not-green', sha };
  }

  const domain = env.VERCEL_PRODUCTION_DOMAIN;
  if (!domain) return fail(core, `The repo variable VERCEL_PRODUCTION_DOMAIN is not set, so production cannot be compared with ${sha}. Nothing was promoted.`);
  const projectId = env.VERCEL_PROJECT_ID;
  if (!projectId) return fail(core, `The repo variable VERCEL_PROJECT_ID is not set, so the Vercel deployment of ${sha} cannot be found. Nothing was promoted.`);
  const scope = env.VERCEL_SCOPE || '';
  const vercel = vercelClient(env.VERCEL_TOKEN, scope, options.fetch || fetch);

  const current = (await vercel(`/v13/deployments/${encodeURIComponent(domain)}`)).meta?.githubCommitSha;
  if (!SHA.test(current || '')) return fail(core, `Production at ${domain} names no Git commit, so it cannot be compared with ${sha}. Nothing was promoted.`);
  if (await contains(github, repo, current, sha)) {
    await say(core, `Production already runs ${current}, which contains ${sha}. Nothing was promoted.`);
    return { outcome: 'current', sha, current };
  }

  // The commit whose build goes live: the green sha when deploy-production built it, else (a path-filtered
  // commit, such as docs only) the latest earlier commit in it that did.
  let built = sha;
  let deployRun = (await pushRuns(github, repo, { head_sha: sha, per_page: 10 })).find(r => r.head_sha === sha);
  if (!deployRun) {
    deployRun = await deployingAncestor(github, repo, sha);
    if (!deployRun) {
      await say(core, `No deploy-production push run built ${sha} or a commit before it. Nothing deployable changed, so production stays on ${current}. Nothing was promoted.`);
      return { outcome: 'unchanged', sha, current };
    }
    built = deployRun.head_sha;
    if (await contains(github, repo, current, built)) {
      await say(core, `No deploy-production push run built ${sha}; its latest deploying commit ${built} is already in production ${current}. Nothing deployable changed, so production stays. Nothing was promoted.`);
      return { outcome: 'unchanged', sha, built, current };
    }
  }
  const of = built === sha ? sha : `${built} (the latest deploying commit in ${sha})`;

  const result = await waitForBuild({ github, repo, vercel, projectId, sha: built, run: deployRun, sleep, now, waitMs, pollMs });
  if (!result.ready) return fail(core, `Promote failed for ${sha}: ${result.why}. Nothing was promoted.`);

  const target = await vercel(`/v13/deployments/${encodeURIComponent(result.ready.uid)}`);
  if (target.meta?.githubCommitSha !== built || target.target !== 'production' || target.readyState !== 'READY' || !target.id) {
    return fail(core, `Vercel reports ${result.ready.uid} is not a ready production build of ${built}. Nothing was promoted.`);
  }
  const host = target.url || result.ready.url || target.id;

  // The CLI refuses VERCEL_PROJECT_ID without VERCEL_ORG_ID; `promote <id>` needs neither.
  const { VERCEL_PROJECT_ID: _project, ...execEnv } = env;
  const [command, args] = promoteCommand(target.id, scope);
  try {
    await exec.exec(command, args, { env: execEnv });
  } catch (error) {
    return fail(core, `vercel promote failed for deployment ${target.id} (${host}) of ${of}: ${error.message}`);
  }
  await say(core, `Promoted deployment ${target.id} (${host}) of ${of} to production. It replaced ${current}.`);
  return { outcome: 'promoted', sha, built, deployment: target.id, previous: current };
};
module.exports.promoteCommand = promoteCommand;
