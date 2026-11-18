const REPOSITORY = 'SebastianGarces/everyfield';
const VERCEL_APP = 35613825;
const VERCEL_CLI = 'vercel@65.11.0';
const SHA = /^[0-9a-f]{40}$/;
const WAIT_MS = 20 * 60 * 1000;
const POLL_MS = 30 * 1000;

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
  return async function vercel(path) {
    const url = new URL(path, 'https://api.vercel.com');
    if (scope) url.searchParams.set('slug', scope);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Vercel API ${url.pathname} returned HTTP ${response.status}`);
    return response.json();
  };
}

async function findDeployment(github, repo, sha) {
  const deployments = await github.paginate(github.rest.repos.listDeployments, {
    ...repo, sha, environment: 'Production', per_page: 100,
  });
  const exact = deployments
    .filter(d => d.sha === sha && d.environment?.toLowerCase() === 'production' && d.creator?.id === VERCEL_APP)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  let pending = false;
  let failed = 0;
  for (const deployment of exact) {
    const statuses = (await github.rest.repos.listDeploymentStatuses({ ...repo, deployment_id: deployment.id, per_page: 100 }))
      .data.filter(status => status.creator?.id === VERCEL_APP);
    const latest = statuses[0]?.state;
    const built = statuses.find(status => status.state === 'success' && status.environment_url);
    if (built && ['success', 'inactive'].includes(latest)) return { deployment, url: built.environment_url };
    if (['failure', 'error'].includes(latest)) failed++;
    else pending = true;
  }
  return { pending: pending || exact.length === 0, failed };
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
  const scope = env.VERCEL_SCOPE || '';
  const vercel = vercelClient(env.VERCEL_TOKEN, scope, options.fetch || fetch);

  const current = (await vercel(`/v13/deployments/${encodeURIComponent(domain)}`)).meta?.githubCommitSha;
  if (!SHA.test(current || '')) return fail(core, `Production at ${domain} names no Git commit, so it cannot be compared with ${sha}. Nothing was promoted.`);
  const comparison = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${sha}...${current}` });
  if (['ahead', 'identical'].includes(comparison.data.status)) {
    await say(core, `Production already runs ${current}, which contains ${sha}. Nothing was promoted.`);
    return { outcome: 'current', sha, current };
  }

  const deadline = now() + waitMs;
  let found;
  for (;;) {
    found = await findDeployment(github, repo, sha);
    if (found.url || !found.pending || now() >= deadline) break;
    await sleep(pollMs);
  }
  if (!found.url) {
    const why = found.pending
      ? `no built Vercel production deployment exists for ${sha} after waiting ${Math.round(waitMs / 60000)} minutes`
      : `every Vercel production deployment for ${sha} failed to build (${found.failed})`;
    return fail(core, `Promote failed: ${why}. Nothing was promoted.`);
  }

  let host;
  try { host = new URL(found.url).host; } catch { host = ''; }
  if (!host || host === domain) return fail(core, `The deployment URL for ${sha} is not a unique deployment URL. Nothing was promoted.`);
  const target = await vercel(`/v13/deployments/${encodeURIComponent(host)}`);
  if (target.meta?.githubCommitSha !== sha || target.target !== 'production' || target.readyState !== 'READY' || !target.id) {
    return fail(core, `Vercel reports ${host} is not a ready production build of ${sha}. Nothing was promoted.`);
  }

  const [command, args] = promoteCommand(target.id, scope);
  try {
    await exec.exec(command, args, { env: { ...env, VERCEL_TOKEN: env.VERCEL_TOKEN } });
  } catch (error) {
    return fail(core, `vercel promote failed for deployment ${target.id} (${host}) at ${sha}: ${error.message}`);
  }
  await say(core, `Promoted deployment ${target.id} (${host}) at ${sha} to production. It replaced ${current}.`);
  return { outcome: 'promoted', sha, deployment: target.id, previous: current };
};
module.exports.promoteCommand = promoteCommand;
module.exports.VERCEL_CLI = VERCEL_CLI;
