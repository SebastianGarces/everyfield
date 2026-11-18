const { test } = require('node:test');
const assert = require('node:assert/strict');
const promote = require('./promote.cjs');

const GREEN = 'a'.repeat(40);
const PROD = 'f'.repeat(40);
const VERCEL = 35613825;
const ON = { TRUNK_PROMOTE: 'true', VERCEL_TOKEN: 'token-value', VERCEL_SCOPE: 'everyfield-team', VERCEL_PRODUCTION_DOMAIN: 'everyfield.app' };

function deployment(id, sha, overrides = {}) {
  return { id, sha, environment: 'Production', creator: { id: VERCEL }, created_at: `2026-11-18T10:0${id % 10}:00Z`, ...overrides };
}
function built(host) {
  return [{ state: 'success', environment_url: `https://${host}`, creator: { id: VERCEL } }];
}

function harness({ deployments = [], statuses = {}, production = PROD, compare = 'behind', vercelDeployments = {}, env = ON } = {}) {
  const calls = { vercel: [], exec: [], compare: [], listDeployments: [] };
  const summary = [];
  const failed = [];
  const github = {
    rest: { repos: {
      listDeployments: () => {},
      listDeploymentStatuses: async ({ deployment_id }) => ({ data: (typeof statuses === 'function' ? statuses() : statuses)[deployment_id] || [] }),
      compareCommitsWithBasehead: async ({ basehead }) => { calls.compare.push(basehead); return { data: { status: compare } }; },
    } },
    paginate: async (endpoint, input) => {
      assert.equal(endpoint, github.rest.repos.listDeployments);
      calls.listDeployments.push(input);
      return typeof deployments === 'function' ? deployments() : deployments;
    },
  };
  const fetch = async (url, init) => {
    calls.vercel.push({ url: String(url), auth: init.headers.Authorization });
    const host = decodeURIComponent(url.pathname.split('/').pop());
    const body = host === env.VERCEL_PRODUCTION_DOMAIN
      ? { id: 'dpl_current', meta: { githubCommitSha: production } }
      : vercelDeployments[host];
    return body ? { ok: true, json: async () => body } : { ok: false, status: 404 };
  };
  const core = {
    info() {},
    setFailed: line => failed.push(line),
    summary: { addRaw(text) { summary.push(text); return this; }, write: async () => {} },
  };
  const exec = { exec: async (command, args, options) => { calls.exec.push({ command, args, token: options.env.VERCEL_TOKEN }); return 0; } };
  let clock = 0;
  const options = { env, fetch, sleep: async ms => { clock += ms; }, now: () => clock, waitMs: 120000, pollMs: 30000 };
  const go = context => promote({ github, context, core, exec }, options);
  return { go, calls, summary, failed };
}
function ci(overrides = {}) {
  return { repo: { owner: 'SebastianGarces', repo: 'everyfield' }, eventName: 'workflow_run', payload: { workflow_run: {
    id: 3, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main',
    head_repository: { full_name: 'SebastianGarces/everyfield' }, conclusion: 'success', head_sha: GREEN, ...overrides,
  } } };
}
function ready(host, sha = GREEN, id = 'dpl_green') {
  return { [host]: { id, meta: { githubCommitSha: sha }, target: 'production', readyState: 'READY' } };
}

test('INV-promote: missing TRUNK_PROMOTE or VERCEL_TOKEN promotes nothing, calls no Vercel API and says which is missing', async () => {
  const cases = [
    [{ ...ON, TRUNK_PROMOTE: undefined }, /TRUNK_PROMOTE is not "true"/],
    [{ ...ON, TRUNK_PROMOTE: 'false' }, /TRUNK_PROMOTE is not "true"/],
    [{ ...ON, TRUNK_PROMOTE: 'TRUE' }, /TRUNK_PROMOTE is not "true"/],
    [{ ...ON, VERCEL_TOKEN: undefined }, /VERCEL_TOKEN secret is not set/],
    [{ ...ON, VERCEL_TOKEN: '' }, /VERCEL_TOKEN secret is not set/],
  ];
  for (const [env, reason] of cases) {
    const h = harness({ env, deployments: [deployment(1, GREEN)], statuses: { 1: built('green.vercel.app') }, vercelDeployments: ready('green.vercel.app') });
    const result = await h.go(ci());
    assert.equal(result.outcome, 'off', JSON.stringify(env));
    assert.deepEqual(h.calls.vercel, []);
    assert.deepEqual(h.calls.exec, []);
    assert.deepEqual(h.calls.listDeployments, []);
    assert.deepEqual(h.failed, []);
    assert.match(h.summary.join(''), reason);
    assert.match(h.summary.join(''), /Nothing was promoted\./);
  }
  const both = harness({ env: {} });
  await both.go(ci());
  assert.match(both.summary.join(''), /TRUNK_PROMOTE is not "true" and the VERCEL_TOKEN secret is not set\. Nothing was promoted\./);
});

test('INV-promote: only a successful push CI run on main of this repository promotes', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'startup_failure', 'action_required', 'neutral', 'stale', null]) {
    const h = harness();
    const result = await h.go(ci({ conclusion }));
    assert.equal(result.outcome, 'not-green', String(conclusion));
    assert.match(h.summary.join(''), new RegExp(`CI on main concluded ${conclusion} at ${GREEN}\\. Nothing was promoted\\.`));
    assert.deepEqual(h.calls.exec, []);
    assert.deepEqual(h.calls.vercel, []);
  }
  for (const change of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/everyfield' } }, { path: '.github/workflows/nightly.yml' }, { head_sha: 'abc' }]) {
    const h = harness();
    assert.equal((await h.go(ci(change))).outcome, 'ignored', JSON.stringify(change));
    assert.match(h.summary.join(''), /not a push CI run on main of this repository\. Nothing was promoted\./);
    assert.deepEqual(h.calls.exec, []);
  }
  const other = harness();
  assert.equal((await other.go({ ...ci(), eventName: 'push' })).outcome, 'ignored');
  await assert.rejects(harness().go({ ...ci(), repo: { owner: 'fork', repo: 'everyfield' } }), /Unexpected promote repository/);
});

test('INV-promote: promotes the Vercel production deployment for the exact green sha and no other', async () => {
  const deployments = [
    deployment(1, 'b'.repeat(40)),
    deployment(2, 'c'.repeat(40)),
    deployment(3, GREEN.slice(0, 39) + 'b'),
    deployment(4, GREEN.slice(0, 7)),
    deployment(5, GREEN, { environment: 'Preview' }),
    deployment(6, GREEN, { creator: { id: 1 } }),
    deployment(7, GREEN),
    deployment(8, GREEN, { created_at: '2026-11-18T09:00:00Z' }),
  ];
  const statuses = Object.fromEntries(deployments.map(d => [d.id, built(`d${d.id}.vercel.app`)]));
  statuses[7] = [{ state: 'failure', creator: { id: VERCEL } }];
  const h = harness({ deployments, statuses, vercelDeployments: ready('d8.vercel.app', GREEN, 'dpl_eight') });
  const result = await h.go(ci());
  assert.equal(result.outcome, 'promoted');
  assert.equal(result.deployment, 'dpl_eight');
  assert.deepEqual(h.calls.exec, [{
    command: 'npx',
    args: ['--yes', 'vercel@65.11.0', 'promote', 'dpl_eight', '--yes', '--scope', 'everyfield-team'],
    token: 'token-value',
  }]);
  assert.ok(!h.calls.exec[0].args.includes('token-value'), 'the token is never a command argument');
  assert.deepEqual(h.calls.compare, [`${GREEN}...${PROD}`]);
  assert.deepEqual(h.calls.vercel.map(c => c.url), [
    'https://api.vercel.com/v13/deployments/everyfield.app?slug=everyfield-team',
    'https://api.vercel.com/v13/deployments/d8.vercel.app?slug=everyfield-team',
  ]);
  assert.ok(h.calls.vercel.every(c => c.auth === 'Bearer token-value'));
  assert.equal(h.calls.listDeployments[0].sha, GREEN);
  assert.match(h.summary.join(''), new RegExp(`Promoted deployment dpl_eight \\(d8\\.vercel\\.app\\) at ${GREEN} to production\\. It replaced ${PROD}\\.`));
  assert.deepEqual(h.failed, []);
});

test('INV-promote: the command omits --scope when no Vercel scope is configured', () => {
  assert.deepEqual(promote.promoteCommand('dpl_x', ''), ['npx', ['--yes', 'vercel@65.11.0', 'promote', 'dpl_x', '--yes']]);
  assert.match(promote.VERCEL_CLI, /^vercel@\d+\.\d+\.\d+$/);
});

test('INV-promote: without an exact built deployment nothing is promoted and the job fails naming the sha', async () => {
  const others = [deployment(1, 'b'.repeat(40)), deployment(2, GREEN.slice(0, 39) + 'c'), deployment(3, GREEN, { environment: 'Preview' })];
  const statuses = { 1: built('d1.vercel.app'), 2: built('d2.vercel.app'), 3: built('d3.vercel.app') };
  const none = harness({ deployments: others, statuses });
  assert.equal((await none.go(ci())).outcome, 'failed');
  assert.deepEqual(none.calls.exec, []);
  assert.equal(none.calls.listDeployments.length, 5, 'polls until the bounded wait ends');
  assert.match(none.failed[0], new RegExp(`no built Vercel production deployment exists for ${GREEN} after waiting 2 minutes`));
  assert.match(none.summary.join(''), new RegExp(GREEN));

  const broken = harness({ deployments: [deployment(1, GREEN)], statuses: { 1: [{ state: 'error', creator: { id: VERCEL } }] } });
  assert.equal((await broken.go(ci())).outcome, 'failed');
  assert.equal(broken.calls.listDeployments.length, 1, 'a failed build is final');
  assert.match(broken.failed[0], new RegExp(`every Vercel production deployment for ${GREEN} failed to build`));
  assert.deepEqual(broken.calls.exec, []);

  const building = harness({ deployments: [deployment(1, GREEN)], statuses: { 1: [{ state: 'in_progress', creator: { id: VERCEL } }] } });
  assert.equal((await building.go(ci())).outcome, 'failed');
  assert.match(building.failed[0], /after waiting 2 minutes/);
  assert.deepEqual(building.calls.exec, []);

  const mismatched = harness({ deployments: [deployment(1, GREEN)], statuses: { 1: built('d1.vercel.app') }, vercelDeployments: ready('d1.vercel.app', 'b'.repeat(40)) });
  assert.equal((await mismatched.go(ci())).outcome, 'failed');
  assert.match(mismatched.failed[0], new RegExp(`not a ready production build of ${GREEN}`));
  assert.deepEqual(mismatched.calls.exec, []);
});

test('INV-promote: a deployment that finishes building inside the wait is promoted', async () => {
  let polls = 0;
  const h = harness({
    deployments: () => (++polls < 3 ? [] : [deployment(1, GREEN)]),
    statuses: () => ({ 1: polls < 4 ? [{ state: 'in_progress', creator: { id: VERCEL } }] : built('d1.vercel.app') }),
    vercelDeployments: ready('d1.vercel.app', GREEN, 'dpl_one'),
  });
  assert.equal((await h.go(ci())).outcome, 'promoted');
  assert.equal(h.calls.exec[0].args[3], 'dpl_one');
});

test('INV-promote: a green run that finishes after a newer one never moves production backwards', async () => {
  const older = GREEN;
  const newer = 'c'.repeat(40);
  const statuses = { 1: built('old.vercel.app'), 2: built('new.vercel.app') };
  const deployments = [deployment(1, older), deployment(2, newer)];
  for (const status of ['ahead', 'identical']) {
    const h = harness({ deployments, statuses, production: newer, compare: status, vercelDeployments: ready('old.vercel.app') });
    const result = await h.go(ci({ head_sha: older }));
    assert.equal(result.outcome, 'current', status);
    assert.deepEqual(h.calls.compare, [`${older}...${newer}`]);
    assert.deepEqual(h.calls.exec, []);
    assert.match(h.summary.join(''), new RegExp(`Production already runs ${newer}, which contains ${older}\\. Nothing was promoted\\.`));
  }
});

test('INV-promote: without a production domain or a production commit nothing is promoted', async () => {
  const unset = harness({ env: { ...ON, VERCEL_PRODUCTION_DOMAIN: '' } });
  assert.equal((await unset.go(ci())).outcome, 'failed');
  assert.match(unset.failed[0], /VERCEL_PRODUCTION_DOMAIN is not set/);
  assert.deepEqual(unset.calls.vercel, []);
  const unknown = harness({ production: null });
  assert.equal((await unknown.go(ci())).outcome, 'failed');
  assert.match(unknown.failed[0], /names no Git commit/);
  assert.deepEqual(unknown.calls.exec, []);
});
