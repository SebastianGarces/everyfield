const { test } = require('node:test');
const assert = require('node:assert/strict');
const promote = require('./promote.cjs');

const GREEN = 'a'.repeat(40);
const PROD = 'f'.repeat(40);
const EARLIER = 'e'.repeat(40);
const PROJECT = 'prj_everyfield';
const ON = {
  TRUNK_PROMOTE: 'true', VERCEL_TOKEN: 'token-value', VERCEL_SCOPE: 'everyfield-team',
  VERCEL_PRODUCTION_DOMAIN: 'everyfield.app', VERCEL_PROJECT_ID: PROJECT,
};
const PUSHED = '2026-11-25T10:00:00Z';

function cliProductionDeployment(uid, sha, readyState = 'READY', overrides = {}) {
  return { uid, url: `${uid}.vercel.app`, projectId: PROJECT, target: 'production', readyState, created: Date.parse(PUSHED) + 60000, meta: { githubCommitSha: sha }, ...overrides };
}
function deployRun(id, sha, status = 'completed', conclusion = 'success', created_at = PUSHED) {
  return { id, head_sha: sha, event: 'push', head_branch: 'main', status, conclusion: status === 'completed' ? conclusion : null, created_at };
}
const value = v => (typeof v === 'function' ? v() : v);

function harness({ deployments = [], runs = [], production = PROD, ancestors = {}, env = ON, defaults = false, promoteStatus = 201, servedAfterReads = 0 } = {}) {
  const calls = { vercel: [], promotes: [], compare: [], runs: [], getRun: [], lists: 0 };
  let promotedTo;
  let readsSincePromote = 0;
  const summary = [];
  const failed = [];
  const history = { ...ancestors };
  const github = {
    rest: {
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          calls.compare.push(basehead);
          const [base, head] = basehead.split('...');
          const status = base === head ? 'identical' : (history[head] || []).includes(base) ? 'ahead' : 'behind';
          return { data: { status } };
        },
      },
      actions: {
        listWorkflowRuns: async input => {
          calls.runs.push(input);
          assert.equal(input.workflow_id, 'deploy-production.yml');
          const all = value(runs);
          return { data: { workflow_runs: input.head_sha ? all.filter(r => r.head_sha === input.head_sha) : all } };
        },
        getWorkflowRun: async ({ run_id }) => {
          calls.getRun.push(run_id);
          return { data: value(runs).find(r => r.id === run_id) };
        },
      },
    },
  };
  const fetch = async (url, init) => {
    const method = init.method || 'GET';
    calls.vercel.push({ method, url: String(url), auth: init.headers.Authorization });
    const promoted = url.pathname.match(/^\/v10\/projects\/([^/]+)\/promote\/([^/]+)$/);
    if (promoted) {
      assert.equal(method, 'POST');
      calls.promotes.push({ url: String(url), auth: init.headers.Authorization, contentType: init.headers['Content-Type'], body: init.body });
      if (promoteStatus >= 200 && promoteStatus < 300) promotedTo = decodeURIComponent(promoted[2]);
      return { ok: promoteStatus >= 200 && promoteStatus < 300, status: promoteStatus };
    }
    assert.equal(method, 'GET');
    if (url.pathname === '/v7/deployments') {
      assert.equal(url.searchParams.get('projectId'), PROJECT);
      assert.equal(url.searchParams.get('target'), 'production');
      calls.lists++;
      return { ok: true, json: async () => ({ deployments: value(deployments), pagination: { next: null } }) };
    }
    const key = decodeURIComponent(url.pathname.split('/').pop());
    if (key === env.VERCEL_PRODUCTION_DOMAIN) {
      const id = promotedTo && readsSincePromote++ >= servedAfterReads ? promotedTo : 'dpl_current';
      return { ok: true, json: async () => ({ id, meta: { githubCommitSha: production } }) };
    }
    return { ok: false, status: 404 };
  };
  const core = {
    info() {},
    setFailed: line => failed.push(line),
    summary: { addRaw(text) { summary.push(text); return this; }, write: async () => {} },
  };
  let clock = 0;
  const options = { env, fetch, sleep: async ms => { clock += ms; }, now: () => clock, ...(defaults ? {} : { waitMs: 120000, pollMs: 30000 }) };
  const go = context => promote({ github, context, core }, options);
  return { go, calls, summary, failed, waited: () => clock };
}
function ci(overrides = {}) {
  return { repo: { owner: 'SebastianGarces', repo: 'everyfield' }, eventName: 'workflow_run', payload: { workflow_run: {
    id: 3, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main',
    head_repository: { full_name: 'SebastianGarces/everyfield' }, conclusion: 'success', head_sha: GREEN, ...overrides,
  } } };
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
    const h = harness({ env, runs: [deployRun(1, GREEN)], deployments: [cliProductionDeployment('dpl_green', GREEN)] });
    const result = await h.go(ci());
    assert.equal(result.outcome, 'off', JSON.stringify(env));
    assert.deepEqual(h.calls.vercel, []);
    assert.deepEqual(h.calls.promotes, []);
    assert.deepEqual(h.calls.runs, []);
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
    assert.deepEqual(h.calls.promotes, []);
    assert.deepEqual(h.calls.vercel, []);
  }
  for (const change of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/everyfield' } }, { path: '.github/workflows/nightly.yml' }, { head_sha: 'abc' }]) {
    const h = harness();
    assert.equal((await h.go(ci(change))).outcome, 'ignored', JSON.stringify(change));
    assert.match(h.summary.join(''), /not a push CI run on main of this repository\. Nothing was promoted\./);
    assert.deepEqual(h.calls.promotes, []);
  }
  const other = harness();
  assert.equal((await other.go({ ...ci(), eventName: 'push' })).outcome, 'ignored');
  await assert.rejects(harness().go({ ...ci(), repo: { owner: 'fork', repo: 'everyfield' } }), /Unexpected promote repository/);
});

test('INV-promote: promotes the CLI production deployment stamped with the exact green sha and no other', async () => {
  const deployments = [
    cliProductionDeployment('dpl_other', 'b'.repeat(40)),
    cliProductionDeployment('dpl_near', GREEN.slice(0, 39) + 'b'),
    cliProductionDeployment('dpl_short', GREEN.slice(0, 7)),
    cliProductionDeployment('dpl_preview', GREEN, 'READY', { target: null }),
    cliProductionDeployment('dpl_foreign', GREEN, 'READY', { projectId: 'prj_other' }),
    cliProductionDeployment('dpl_failed', GREEN, 'ERROR', { created: Date.parse(PUSHED) + 90000 }),
    cliProductionDeployment('dpl_green', GREEN),
  ];
  const h = harness({ runs: [deployRun(7, GREEN)], deployments });
  const result = await h.go(ci());
  assert.equal(result.outcome, 'promoted');
  assert.equal(result.deployment, 'dpl_green');
  assert.deepEqual(h.calls.promotes, [{
    url: 'https://api.vercel.com/v10/projects/prj_everyfield/promote/dpl_green?slug=everyfield-team',
    auth: 'Bearer token-value', contentType: 'application/json', body: '{}',
  }]);
  assert.deepEqual(h.calls.compare, [`${GREEN}...${PROD}`]);
  const urls = h.calls.vercel.map(c => new URL(c.url));
  assert.deepEqual(h.calls.vercel.map(c => `${c.method} ${new URL(c.url).pathname}`), [
    'GET /v13/deployments/everyfield.app', 'GET /v7/deployments',
    'POST /v10/projects/prj_everyfield/promote/dpl_green', 'GET /v13/deployments/everyfield.app',
  ]);
  assert.ok(urls.every(u => u.searchParams.get('slug') === 'everyfield-team'), 'every call uses the team the listing uses');
  assert.equal(Number(urls[1].searchParams.get('since')), Date.parse(PUSHED) - 5 * 60 * 1000);
  assert.ok(h.calls.vercel.every(c => c.auth === 'Bearer token-value'));
  assert.deepEqual(h.calls.runs[0], { owner: 'SebastianGarces', repo: 'everyfield', workflow_id: 'deploy-production.yml', event: 'push', branch: 'main', head_sha: GREEN, per_page: 10 });
  assert.match(h.summary.join(''), new RegExp(`Promoted deployment dpl_green \\(dpl_green\\.vercel\\.app\\) of ${GREEN} to production\\. everyfield\\.app serves it\\. It replaced ${PROD}\\.`));
  assert.deepEqual(h.failed, []);
});

test('INV-promote: the promote request names no team when no Vercel scope is configured', async () => {
  const h = harness({ env: { ...ON, VERCEL_SCOPE: '' }, runs: [deployRun(7, GREEN)], deployments: [cliProductionDeployment('dpl_green', GREEN)] });
  assert.equal((await h.go(ci())).outcome, 'promoted');
  assert.deepEqual(h.calls.promotes.map(p => p.url), ['https://api.vercel.com/v10/projects/prj_everyfield/promote/dpl_green']);
  assert.equal(h.calls.promotes[0].auth, 'Bearer token-value');
});

test('INV-promote: a refused promote request fails naming the deployment and the sha', async () => {
  for (const status of [401, 403, 404, 409, 500]) {
    const h = harness({ promoteStatus: status, runs: [deployRun(7, GREEN)], deployments: [cliProductionDeployment('dpl_green', GREEN)] });
    const result = await h.go(ci());
    assert.equal(result.outcome, 'failed', String(status));
    assert.equal(h.calls.promotes.length, 1);
    assert.deepEqual(h.failed, [`Promote failed for deployment dpl_green (dpl_green.vercel.app) of ${GREEN}: Vercel API POST /v10/projects/prj_everyfield/promote/dpl_green returned HTTP ${status}. Production stays on ${PROD}.`]);
    assert.doesNotMatch(h.summary.join(''), /Promoted deployment/);
  }
});

test('INV-promote: an accepted promote succeeds only once the production domain serves the deployment', async () => {
  const slow = harness({ servedAfterReads: 3, runs: [deployRun(7, GREEN)], deployments: [cliProductionDeployment('dpl_green', GREEN)] });
  assert.equal((await slow.go(ci())).outcome, 'promoted');
  assert.equal(slow.calls.vercel.filter(c => c.url.includes('/v13/deployments/everyfield.app')).length, 1 + 4);
  assert.deepEqual(slow.failed, []);

  const never = harness({ servedAfterReads: Infinity, runs: [deployRun(7, GREEN)], deployments: [cliProductionDeployment('dpl_green', GREEN)] });
  assert.equal((await never.go(ci())).outcome, 'failed');
  assert.deepEqual(never.failed, [`Vercel accepted the promote of deployment dpl_green (dpl_green.vercel.app) of ${GREEN}, but everyfield.app still serves dpl_current after 5 minutes.`]);
  assert.doesNotMatch(never.summary.join(''), /Promoted deployment/);
});

test('INV-promote: a build still queued or building is waited for and promoted once it is READY', async () => {
  let polls = 0;
  const h = harness({
    runs: () => [deployRun(7, GREEN, polls < 4 ? 'in_progress' : 'completed')],
    deployments: () => {
      polls++;
      if (polls < 2) return [];
      return [cliProductionDeployment('dpl_green', GREEN, polls < 3 ? 'QUEUED' : polls < 4 ? 'BUILDING' : 'READY')];
    },
  });
  const result = await h.go(ci());
  assert.equal(result.outcome, 'promoted');
  assert.equal(h.calls.lists, 4, 'not yet built, queued, building, then READY');
  assert.match(h.calls.promotes[0].url, /\/promote\/dpl_green\?/);
  assert.deepEqual(h.failed, []);
});

test('INV-promote: a failed, cancelled or never-ready build fails naming the sha and promotes nothing', async () => {
  for (const state of ['ERROR', 'CANCELED']) {
    const h = harness({ runs: [deployRun(7, GREEN, 'completed', 'failure')], deployments: [cliProductionDeployment('dpl_green', GREEN, state)] });
    assert.equal((await h.go(ci())).outcome, 'failed', state);
    assert.deepEqual(h.calls.promotes, []);
    assert.equal(h.failed.length, 1);
    assert.match(h.failed[0], new RegExp(`Promote failed for ${GREEN}: the Vercel production build of ${GREEN} ended in ${state} \\(deploy-production run 7 concluded failure\\)\\. Nothing was promoted\\.`));
    assert.match(h.summary.join(''), new RegExp(`ended in ${state}`));
  }

  const cancelledRun = harness({ runs: [deployRun(7, GREEN, 'completed', 'cancelled')], deployments: [] });
  assert.equal((await cancelledRun.go(ci())).outcome, 'failed');
  assert.match(cancelledRun.failed[0], new RegExp(`deploy-production run 7 for ${GREEN} concluded cancelled without a Vercel production deployment`));
  assert.deepEqual(cancelledRun.calls.promotes, []);

  const stuck = harness({ runs: [deployRun(7, GREEN, 'in_progress')], deployments: [cliProductionDeployment('dpl_green', GREEN, 'BUILDING')] });
  assert.equal((await stuck.go(ci())).outcome, 'failed');
  assert.match(stuck.failed[0], new RegExp(`Promote failed for ${GREEN}: no READY Vercel production deployment exists for ${GREEN} after waiting 2 minutes\\. Nothing was promoted\\.`));
  assert.equal(stuck.calls.getRun.length, 5, 'polls until the bounded wait ends');
  assert.deepEqual(stuck.calls.promotes, []);
});

test('INV-promote: the default wait outlasts deploy-production\'s 30-minute job timeout', async () => {
  const h = harness({ runs: [deployRun(7, GREEN, 'queued')], deployments: [], defaults: true });
  const result = await h.go(ci());
  assert.equal(result.outcome, 'failed');
  assert.ok(h.waited() > 30 * 60 * 1000, `waited ${h.waited()} ms`);
  assert.match(h.failed[0], /after waiting 40 minutes/);
  assert.deepEqual(h.calls.promotes, []);
});

test('INV-promote: a path-filtered green sha promotes the latest earlier deploying commit it contains', async () => {
  const OLDER = 'd'.repeat(40);
  const LATER = 'c'.repeat(40);
  const runs = [
    deployRun(9, LATER, 'completed', 'success', '2026-11-25T11:00:00Z'),
    deployRun(8, EARLIER, 'completed', 'success', '2026-11-25T10:00:00Z'),
    deployRun(5, OLDER, 'completed', 'success', '2026-11-25T09:00:00Z'),
  ];
  const ancestors = { [GREEN]: [EARLIER, OLDER, PROD], [EARLIER]: [OLDER, PROD], [LATER]: [GREEN, EARLIER, OLDER, PROD] };
  const h = harness({ runs, ancestors, production: PROD, deployments: [cliProductionDeployment('dpl_earlier', EARLIER), cliProductionDeployment('dpl_older', OLDER)] });
  const result = await h.go(ci());
  assert.equal(result.outcome, 'promoted');
  assert.equal(result.built, EARLIER);
  assert.match(h.calls.promotes[0].url, /\/promote\/dpl_earlier\?/);
  assert.deepEqual(h.calls.runs.map(r => r.head_sha), [GREEN, undefined]);
  assert.match(h.summary.join(''), new RegExp(`Promoted deployment dpl_earlier \\(dpl_earlier\\.vercel\\.app\\) of ${EARLIER} \\(the latest deploying commit in ${GREEN}\\) to production\\. everyfield\\.app serves it\\. It replaced ${PROD}\\.`));
  assert.deepEqual(h.failed, []);
});

test('INV-promote: a path-filtered green sha whose deploying commit is already live ends green and promotes nothing', async () => {
  const runs = [deployRun(8, EARLIER)];
  const live = harness({ runs, production: PROD, ancestors: { [GREEN]: [EARLIER, PROD], [PROD]: [EARLIER] }, deployments: [cliProductionDeployment('dpl_earlier', EARLIER)] });
  const result = await live.go(ci());
  assert.equal(result.outcome, 'unchanged');
  assert.deepEqual(live.calls.promotes, []);
  assert.deepEqual(live.failed, []);
  assert.match(live.summary.join(''), new RegExp(`No deploy-production push run built ${GREEN}; its latest deploying commit ${EARLIER} is already in production ${PROD}\\. Nothing deployable changed, so production stays\\. Nothing was promoted\\.`));

  const none = harness({ runs: [], deployments: [] });
  assert.equal((await none.go(ci())).outcome, 'unchanged');
  assert.deepEqual(none.failed, []);
  assert.deepEqual(none.calls.promotes, []);
  assert.match(none.summary.join(''), /Nothing deployable changed, so production stays on/);
});

test('INV-promote: a green run that finishes after a newer one never moves production backwards', async () => {
  const older = GREEN;
  const newer = 'c'.repeat(40);
  const runs = [deployRun(1, older), deployRun(2, newer)];
  const deployments = [cliProductionDeployment('dpl_old', older), cliProductionDeployment('dpl_new', newer)];
  for (const ancestors of [{ [newer]: [older] }, {}]) {
    const production = ancestors[newer] ? newer : older;
    const h = harness({ runs, deployments, production, ancestors });
    const result = await h.go(ci({ head_sha: older }));
    assert.equal(result.outcome, 'current');
    assert.deepEqual(h.calls.compare, [`${older}...${production}`]);
    assert.deepEqual(h.calls.promotes, []);
    assert.match(h.summary.join(''), new RegExp(`Production already runs ${production}, which contains ${older}\\. Nothing was promoted\\.`));
  }
});

test('INV-promote: without a production domain, project id or production commit nothing is promoted', async () => {
  const unset = harness({ env: { ...ON, VERCEL_PRODUCTION_DOMAIN: '' } });
  assert.equal((await unset.go(ci())).outcome, 'failed');
  assert.match(unset.failed[0], /VERCEL_PRODUCTION_DOMAIN is not set/);
  assert.deepEqual(unset.calls.vercel, []);
  const noProject = harness({ env: { ...ON, VERCEL_PROJECT_ID: '' } });
  assert.equal((await noProject.go(ci())).outcome, 'failed');
  assert.match(noProject.failed[0], new RegExp(`VERCEL_PROJECT_ID is not set, so the Vercel deployment of ${GREEN} cannot be found`));
  assert.deepEqual(noProject.calls.vercel, []);
  const unknown = harness({ production: null });
  assert.equal((await unknown.go(ci())).outcome, 'failed');
  assert.match(unknown.failed[0], /names no Git commit/);
  assert.deepEqual(unknown.calls.promotes, []);
});
