const { test } = require('node:test');
const assert = require('node:assert/strict');
const queue = require('./internal-feedback-queue.cjs');

test('INV-internal-feedback: P0 and P1 reach the desk, public feedback, PRs and proof issues do not', () => {
  const issue = (number, labels, extra = {}) => ({ number, title: `Failure ${number}`, html_url: `https://github.com/SebastianGarces/everyfield/issues/${number}`, labels: labels.map(name => ({ name })), ...extra });
  const result = queue({ internalFeedback: { repo: 'SebastianGarces/everyfield', priorities: ['P0', 'P1'] } }, repo => {
    assert.equal(repo, 'SebastianGarces/everyfield');
    return [issue(1, ['P0']), issue(2, ['P1']), issue(3, ['P0', 'fail-forward-test']), issue(4, ['needs-triage']), issue(5, ['P1'], { pull_request: {} })];
  });
  assert.deepEqual(result, { repo: 'SebastianGarces/everyfield', count: 2, issues: [
    { number: 1, url: 'https://github.com/SebastianGarces/everyfield/issues/1', priority: 'P0', title: 'Failure 1' },
    { number: 2, url: 'https://github.com/SebastianGarces/everyfield/issues/2', priority: 'P1', title: 'Failure 2' },
  ] });
});
