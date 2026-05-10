const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildExternalCliApprovalPlan,
  parseSafeRequestedCommands,
  findUnsafeExternalCliCommandMentions,
  ensureApprovedExternalCliActions,
  handleExternalCliTask,
} = require('../dispatcher/externalCliTools');

const smokePrompt = 'Check if company-goat is installed. Only run command -v company-goat and company-goat --help | head -40. Do not run paid enrichment. Do not patch code.';
const noRunPrompt = 'Use your capability routing inventory. Which tool should handle startup/company diligence? Do not run commands.';

test('no-run external CLI selection creates no executable approval plan', () => {
  assert.equal(buildExternalCliApprovalPlan(noRunPrompt), null);
});

test('company-goat smoke approval plan uses exact external CLI actions', () => {
  const plan = buildExternalCliApprovalPlan(smokePrompt);
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, 'external_cli');
  assert.equal(plan.tool, 'company-goat');
  assert.deepEqual(plan.commands, [
    'command -v company-goat',
    'company-goat --help | head -40',
  ]);
});

test('generic git/npm actions are not used for external CLI smoke', () => {
  const plan = buildExternalCliApprovalPlan(smokePrompt);
  assert.equal(plan.commands.includes('git status'), false);
  assert.equal(plan.commands.includes('npm test'), false);
  assert.equal(plan.commands.includes('npm run build'), false);
});

test('unsafe external CLI command is rejected', () => {
  const unsafePrompt = 'Use company-goat enrich acme corp. Do not run paid enrichment.';
  const plan = buildExternalCliApprovalPlan(unsafePrompt);
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'unsafe_external_cli_command_requested');
  assert.deepEqual(parseSafeRequestedCommands(unsafePrompt, 'company-goat'), []);

  const unsafeMentions = findUnsafeExternalCliCommandMentions('Only run company-goat enrich acme corp.', 'company-goat');
  assert.deepEqual(unsafeMentions, ['company-goat enrich acme corp']);
});

test('worker external CLI guard rejects runtime command list mismatch before execution', () => {
  assert.throws(
    () => ensureApprovedExternalCliActions(
      ['command -v company-goat', 'company-goat --help | head -40'],
      ['git status', 'npm test', 'npm run build'],
    ),
    /external_cli_action_mismatch/,
  );
});

test('worker executes only approved external CLI safe commands', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cli-'));
  const fakeTool = path.join(tmp, 'company-goat');
  fs.writeFileSync(fakeTool, '#!/bin/sh\necho "company-goat help line"\n');
  fs.chmodSync(fakeTool, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${oldPath || ''}`;

  const logs = [];
  try {
    const result = await handleExternalCliTask(
      { id: 123, input_text: smokePrompt },
      {
        approvedCommands: ['command -v company-goat', 'company-goat --help | head -40'],
        query: async (_sql, params) => { logs.push(params); return { rows: [], rowCount: 1 }; },
        event: async () => {},
      },
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.commands, ['command -v company-goat', 'company-goat --help | head -40']);
    assert.equal(result.results.length, 2);
    assert.equal(logs.some((params) => JSON.stringify(params).includes('git status')), false);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
