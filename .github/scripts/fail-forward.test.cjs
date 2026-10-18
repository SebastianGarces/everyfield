const { test } = require('node:test');
const assert = require('node:assert/strict');
const report = require('./fail-forward.cjs');

function provider() {
  const issues = [];
  const github = { rest: {
    issues: {
      getLabel: async () => ({}),
      listForRepo: () => {},
      create: async input => {
        const issue = { ...input, number: issues.length + 1, html_url: `https://github.com/SebastianGarces/everyfield/issues/${issues.length + 1}`, labels: input.labels.map(name => ({ name })) };
        issues.push(issue); return { data: issue };
      },
      update: async input => {
        const issue = issues.find(issue => issue.number === input.issue_number);
        Object.assign(issue, input, { labels: input.labels.map(name => ({ name })) });
        return { data: issue };
      },
    },
    actions: {
      listJobsForWorkflowRun: () => {},
      downloadJobLogsForWorkflowRun: async () => ({ url: 'data:text/plain,compile%20failed%3A%20fixture%20failure' }),
    },
    repos: { compareCommitsWithBasehead: async () => ({ data: { status: 'ahead' } }) },
  }, paginate: async endpoint => endpoint === github.rest.issues.listForRepo ? issues : [{
    id: 7, name: 'app', conclusion: 'failure', html_url: 'https://github.com/job/7',
    steps: [{ name: 'Build', conclusion: 'failure' }],
  }] };
  return { github, issues, core: { info() {}, setOutput() {} } };
}
function ci(overrides = {}) {
  return { repo: { owner: 'SebastianGarces', repo: 'everyfield' }, runId: 100,
    eventName: 'workflow_run', payload: { workflow_run: {
      id: 3, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main',
      head_repository: { full_name: 'SebastianGarces/everyfield' }, conclusion: 'failure',
      head_sha: 'a'.repeat(40), html_url: 'https://github.com/run/3', ...overrides,
    } } };
}
function deployment() {
  return { ...ci(), eventName: 'deployment_status', payload: {
    deployment: { id: 4, sha: 'a'.repeat(40), ref: 'a'.repeat(40), environment: 'Production', production_environment: false, creator: { id: 35613825 } },
    deployment_status: { state: 'error', creator: { id: 35613825 }, description: 'Build failed @everyone <script> `bad`', log_url: 'https://vercel.com/build/4' },
  } };
}

test('INV-fail-forward: repeated CI failure updates one incident with the failed job and real excerpt', async () => {
  const p = provider();
  assert.equal(await report({ ...p, context: ci() }), 1);
  assert.equal(await report({ ...p, context: ci({ head_sha: 'b'.repeat(40) }) }), 1);
  assert.equal(p.issues.length, 1);
  assert.equal(p.issues[0].title, 'P0: CI failed on main');
  assert.deepEqual(p.issues[0].labels.map(x => x.name), ['P0', 'internal-breakage']);
  assert.match(p.issues[0].body, /Commit: b{40}/);
  assert.match(p.issues[0].body, /Job: https:\/\/github.com\/job\/7/);
  assert.match(p.issues[0].body, /compile failed: fixture failure/);
});

test('INV-fail-forward: PR, foreign repository, other workflow and non-main failures cannot open an incident', async () => {
  const p = provider();
  for (const change of [{ event: 'pull_request' }, { head_branch: 'feature' }, { conclusion: 'success' }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'fork/everyfield' } }]) {
    await report({ ...p, context: ci(change) });
  }
  assert.equal(await report({ ...p, context: ci() }), 1);
  assert.equal(p.issues.length, 1);
});

test('INV-fail-forward: production SHA ancestry and Vercel identity gate deployment reports', async () => {
  const p = provider();
  const context = deployment();
  context.payload.deployment.environment = 'Preview';
  await report({ ...p, context });
  context.payload.deployment.environment = 'Production';
  context.payload.deployment_status.creator.id = 123;
  await report({ ...p, context });
  context.payload.deployment_status.creator.id = 35613825;
  for (const status of ['behind', 'diverged']) {
    p.github.rest.repos.compareCommitsWithBasehead = async () => ({ data: { status } });
    await report({ ...p, context });
  }
  p.github.rest.repos.compareCommitsWithBasehead = async () => ({ data: { status: 'identical' } });
  assert.equal(await report({ ...p, context }), 1);
  assert.equal(await report({ ...p, context }), 1);
  assert.equal(p.issues.length, 1);
  assert.equal(p.issues[0].title, 'P0: Vercel production deployment failed');
  assert.match(p.issues[0].body, /Commit: a{40}/);
  assert.match(p.issues[0].body, /https:\/\/vercel.com\/build\/4/);
  assert.match(p.issues[0].body, /Build failed @\u200beveryone &lt;script&gt; 'bad'/);
});

test('INV-fail-forward: unavailable CI logs still file an actionable incident', async () => {
  const p = provider();
  p.github.rest.actions.downloadJobLogsForWorkflowRun = async () => { throw Object.assign(new Error('expired'), { status: 410 }); };
  assert.equal(await report({ ...p, context: ci() }), 1);
  assert.match(p.issues[0].body, /Job log unavailable \(410\); open the job link/);
  assert.match(p.issues[0].body, /https:\/\/github.com\/run\/3/);
});
