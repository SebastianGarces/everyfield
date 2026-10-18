const { test } = require('node:test');
const assert = require('node:assert/strict');
const report = require('./fail-forward.cjs');

function provider() {
  const issues = [];
  const anchors = new Map();
  const github = { rest: {
    issues: {
      getLabel: async ({ name }) => {
        if (!name.startsWith('evf-incident-')) return { data: {} };
        if (!anchors.has(name)) throw Object.assign(new Error('missing'), { status: 404 });
        return { data: anchors.get(name) };
      },
      createLabel: async input => { anchors.set(input.name, input); return { data: input }; },
      updateLabel: async input => { anchors.set(input.name, input); return { data: input }; },
      get: async ({ issue_number }) => ({ data: issues.find(i => i.number === issue_number) }),
      listForRepo: () => {},
      create: async input => {
        const issue = { ...input, state: 'open', number: issues.length + 1, html_url: `https://github.com/SebastianGarces/everyfield/issues/${issues.length + 1}`, labels: input.labels.map(name => ({ name })) };
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

test('BUG-W5: repeated CI failure updates one incident even while the issue list is stale', async () => {
  const p = provider();
  assert.equal(await report({ ...p, context: ci() }), 1);
  const paginate = p.github.paginate;
  p.github.paginate = async (endpoint, options) => endpoint === p.github.rest.issues.listForRepo ? [] : paginate(endpoint, options);
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

test('INV-fail-forward: unknown creation outcome refuses retry until the issue pointer is reconciled', async () => {
  const p = provider();
  const create = p.github.rest.issues.create;
  p.github.rest.issues.create = async input => { await create(input); throw new Error('Lost response'); };
  await assert.rejects(report({ ...p, context: ci() }), /Lost response/);
  await assert.rejects(report({ ...p, context: ci() }), /unknown issue-creation outcome/);
  assert.equal(p.issues.length, 1);
  await p.github.rest.issues.updateLabel({ name: 'evf-incident-ci', description: 'evf-incident:1' });
  assert.equal(await report({ ...p, context: ci() }), 1);
  assert.match(p.issues[0].body, /Job: https:\/\/github.com\/job\/7/);
});

test('INV-fail-forward: a long job log keeps the error that comes before post-job cleanup', async () => {
  const p = provider();
  const log = [
    ...Array.from({ length: 400 }, (_, i) => `setup line ${i}`),
    'src/app.ts(4,2): error TS2322: fixture type error',
    '##[error]Process completed with exit code 2.',
    ...Array.from({ length: 120 }, (_, i) => `Post job cleanup line ${i}`),
  ].join('\n');
  p.github.rest.actions.downloadJobLogsForWorkflowRun = async () => ({ url: `data:text/plain,${encodeURIComponent(log)}` });
  assert.equal(await report({ ...p, context: ci() }), 1);
  const body = p.issues[0].body;
  assert.match(body, /error TS2322: fixture type error\n##\[error\]Process completed with exit code 2\.\n```/);
  assert.doesNotMatch(body, /Post job cleanup/);
  assert.match(body, /setup line 399/);
  assert.doesNotMatch(body, /setup line 100\n/);
});

test('INV-fail-forward: many failed jobs stay inside the GitHub issue body limit and keep their errors', async () => {
  for (const count of [10, 128, 400]) {
    const p = provider();
    const jobs = Array.from({ length: count }, (_, i) => ({ id: i, name: `matrix job ${i} ${'n'.repeat(300)}`, conclusion: 'failure', html_url: `https://github.com/SebastianGarces/everyfield/actions/runs/3/job/${100000 + i}`, steps: [{ name: `Compile ${'s'.repeat(300)}`, conclusion: 'failure' }] }));
    p.github.paginate = async endpoint => endpoint === p.github.rest.issues.listForRepo ? p.issues : jobs;
    p.github.rest.actions.downloadJobLogsForWorkflowRun = async ({ job_id }) => ({ url: `data:text/plain,${encodeURIComponent(`${'x'.repeat(199)}\n`.repeat(100) + `##[error]fixture failure in job ${job_id}\ncleanup`)}` });
    assert.equal(await report({ ...p, context: ci() }), 1);
    const body = p.issues[0].body;
    assert.ok(body.length <= 65536, `${count} jobs: body has ${body.length} characters`);
    const shown = body.match(/^### matrix job /gm).length;
    assert.equal((body.match(/##\[error\]fixture failure in job \d+\n```/g) || []).length, shown);
    if (shown < count) assert.match(body, new RegExp(`\n${count - shown} more failed jobs are not shown\\. Open the run link`));
    else assert.equal(count, 10);
  }
});

test('INV-fail-forward: a CI run that never started is reported as an incident', async () => {
  const p = provider();
  p.github.paginate = async endpoint => endpoint === p.github.rest.issues.listForRepo ? p.issues : [];
  assert.equal(await report({ ...p, context: ci({ conclusion: 'startup_failure' }) }), 1);
  assert.equal(p.issues[0].title, 'P0: CI failed on main');
  assert.match(p.issues[0].body, /CI did not start \(startup_failure\)/);
  assert.match(p.issues[0].body, /Source: https:\/\/github.com\/run\/3/);
});
