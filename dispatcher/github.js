const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const { startIdempotentAction, completeIdempotentAction, failIdempotentAction } = require('./idempotency');
const { updateSession } = require('./session');

const execAsync = promisify(exec);

function getGithubConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    base: process.env.GITHUB_DEFAULT_BASE || 'main',
  };
}

function createBranchName(task) {
  const slug = String(task.input_text || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
  return `hermes/task-${task.id}-${slug}`;
}

async function createIssueFromTask(task, session) {
  const cfg = getGithubConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) return null;
  const idemKey = `issue:${task.id}`;
  const start = await startIdempotentAction(idemKey, task.id, 'create_issue', { title: task.input_text });
  if (start.state === 'completed') return start.existing.response;
  if (start.state !== 'started') return null;
  try {
    const res = await axios.post(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/issues`, { title: `Hermes task #${task.id}`, body: task.input_text }, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' } });
    await completeIdempotentAction(idemKey, res.data);
    await updateSession(task.id, { issue_url: res.data.html_url });
    return res.data;
  } catch (e) { await failIdempotentAction(idemKey, e.message); throw e; }
}

async function commitChanges(task, session, summary, projectRoot) {
  const msg = `hermes(task-${task.id}): ${String(summary || 'update').slice(0, 64)}`;
  await execAsync('git add -A', { cwd: projectRoot, shell: '/bin/bash' });
  await execAsync(`git commit -m ${JSON.stringify(msg)}`, { cwd: projectRoot, shell: '/bin/bash' });
  return msg;
}

async function pushBranch(task, session, projectRoot) {
  const branch = session.branch_name || createBranchName(task);
  const idemKey = `push:${task.id}:${branch}`;
  const start = await startIdempotentAction(idemKey, task.id, 'git_push', { branch });
  if (start.state === 'completed') return start.existing.response;
  if (start.state !== 'started') return { skipped: true, reason: start.state };
  try {
    const out = await execAsync(`git push -u origin ${branch}`, { cwd: projectRoot, shell: '/bin/bash' });
    const response = { stdout: out.stdout || '', stderr: out.stderr || '', branch };
    await completeIdempotentAction(idemKey, response);
    return response;
  } catch (e) { await failIdempotentAction(idemKey, e.message); throw e; }
}

async function createPullRequest(task, session, gateResult) {
  const cfg = getGithubConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) return null;
  const branch = session.branch_name || createBranchName(task);
  const idemKey = `pr:${task.id}:${branch}`;
  const payload = { branch, gateResult };
  const start = await startIdempotentAction(idemKey, task.id, 'create_pr', payload);
  if (start.state === 'completed') return start.existing.response;
  if (start.state !== 'started') return null;
  const body = [
    '## Hermes Task Summary', task.input_text || '-', '',
    '## Files Changed', 'See commit diff in branch.', '',
    '## Gate Result', gateResult || 'not_run', '',
    '## Approval Status', 'Push approval required/executed by policy.', '',
    '## Risks', 'Automated change. Validate before merge.', '',
    '## Rollback Notes', `git revert or reset branch ${branch}.`
  ].join('\n');
  try {
    const res = await axios.post(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/pulls`, { title: `Hermes task #${task.id}`, head: branch, base: cfg.base, body }, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' } });
    await completeIdempotentAction(idemKey, res.data);
    await updateSession(task.id, { pr_url: res.data.html_url, branch_name: branch });
    return res.data;
  } catch (e) { await failIdempotentAction(idemKey, e.message); throw e; }
}

async function commentOnIssue(issueNumber, message) {
  const cfg = getGithubConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) return null;
  return axios.post(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/issues/${issueNumber}/comments`, { body: message }, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' } });
}

module.exports = { createIssueFromTask, createBranchName, commitChanges, pushBranch, createPullRequest, commentOnIssue };
