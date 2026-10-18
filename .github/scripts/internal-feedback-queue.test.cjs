const { test } = require('node:test');
const assert = require('node:assert/strict');
const queue = require('./internal-feedback-queue.cjs');

test('INV-internal-feedback: P0 and P1 reach the desk, public feedback, PRs and proof issues do not', () => {
  const issue = (number, labels, extra = {}) => ({ number, title: `Failure ${number}`, html_url: `https://github.com/SebastianGarces/everyfield/issues/${number}`, labels: labels.map(name => ({ name })), author_association: 'OWNER', ...extra });
  const result = queue({ internalFeedback: { repo: 'SebastianGarces/everyfield', priorities: ['P0', 'P1'] } }, repo => {
    assert.equal(repo, 'SebastianGarces/everyfield');
    return [issue(1, ['P0']), issue(2, ['P1']), issue(3, ['P0', 'fail-forward-test']), issue(4, ['needs-triage']), issue(5, ['P1'], { pull_request: {} })];
  });
  assert.deepEqual(result, { repo: 'SebastianGarces/everyfield', count: 2, issues: [
    { number: 1, url: 'https://github.com/SebastianGarces/everyfield/issues/1', priority: 'P0', title: 'Failure 1' },
    { number: 2, url: 'https://github.com/SebastianGarces/everyfield/issues/2', priority: 'P1', title: 'Failure 2' },
  ] });
});

test('INV-internal-feedback: only trusted authors and the Actions reporter reach the P0/P1 queue', () => {
  const issue = (number, extra) => ({ number, title: `Failure ${number}`, html_url: `https://github.com/SebastianGarces/everyfield/issues/${number}`, labels: [{ name: 'P0' }], ...extra });
  const result = queue({ internalFeedback: { repo: 'SebastianGarces/everyfield', priorities: ['P0', 'P1'] } }, () => [
    issue(1, { author_association: 'OWNER', user: { id: 1, type: 'User' } }),
    issue(2, { author_association: 'MEMBER', user: { id: 2, type: 'User' } }),
    issue(3, { author_association: 'COLLABORATOR', user: { id: 3, type: 'User' } }),
    issue(4, { author_association: 'NONE', user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' } }),
    issue(5, { author_association: 'NONE', user: { id: 5, type: 'User' } }),
    issue(6, { author_association: 'CONTRIBUTOR', user: { id: 6, type: 'User' } }),
    issue(7, { author_association: 'FIRST_TIME_CONTRIBUTOR', user: { id: 7, type: 'User' } }),
    issue(8, { author_association: 'NONE', user: { id: 8, login: 'other-app[bot]', type: 'Bot' } }),
  ]);
  assert.deepEqual(result.issues.map(i => i.number), [1, 2, 3, 4]);
  assert.equal(result.count, 4);
});
