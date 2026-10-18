#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Internal issues stay separate from the public FB publisher and its privacy boundary.
// The repository is public and issue forms add P0/P1 labels for any author, so only issues
// opened by a trusted person or by the fail-forward reporter (GitHub Actions bot) can reach
// the desk. The bot's author_association is NONE, so it is matched by its numeric ID.
const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const ACTIONS_BOT_ID = 41898282;
function trusted(issue) {
  return TRUSTED_ASSOCIATIONS.includes(issue.author_association) ||
    (issue.user?.type === 'Bot' && issue.user.id === ACTIONS_BOT_ID);
}
function queue(config, readIssues) {
  const route = config.internalFeedback;
  if (!route || route.repo !== 'SebastianGarces/everyfield' ||
      !Array.isArray(route.priorities) || route.priorities.some(label => !['P0', 'P1'].includes(label))) {
    throw new Error('Configure internalFeedback.repo and P0/P1 priorities before polling');
  }
  const issues = readIssues(route.repo).filter(issue => !issue.pull_request && trusted(issue) &&
    !issue.labels.some(label => label.name === 'fail-forward-test') &&
    issue.labels.some(label => route.priorities.includes(label.name)));
  return { repo: route.repo, count: issues.length, issues: issues.map(issue => ({
    number: issue.number, url: issue.html_url,
    priority: issue.labels.some(label => label.name === 'P0') ? 'P0' : 'P1',
    title: issue.title,
  })) };
}
if (require.main === module) {
  const root = resolve(__dirname, '../..');
  const config = JSON.parse(readFileSync(resolve(root, 'evf.config.json'), 'utf8'));
  const result = queue(config, repo => JSON.parse(execFileSync('gh', [
    'api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&per_page=100`,
  ], { encoding: 'utf8' })).flat());
  console.log(JSON.stringify(result));
}
module.exports = queue;
