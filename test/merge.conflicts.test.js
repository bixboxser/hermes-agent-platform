const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const repoRoot = join(__dirname, '..');

test('worker.js resolves external CLI and skill registry import conflict', () => {
  const worker = readFileSync(join(repoRoot, 'worker.js'), 'utf8');

  const conflictMarkers = ['<' + '<<<<<<', '=' + '======', '>' + '>>>>>>'];
  for (const marker of conflictMarkers) {
    assert.equal(worker.includes(marker), false);
  }
  const expectedResolvedBlock = [
    'const { runGoalTask } = require("./dispatcher/goals");',
    'const { handleExternalCliTask, approvedExternalActionsFromSnapshot } = require("./dispatcher/externalCliTools");',
    'const { buildSkillContext, matchSkills, checkSkillRequirements } = require("./skills/registry");',
    '',
    'const rawExecAsync = promisify(exec);',
  ].join('\n');

  assert.equal(worker.includes(expectedResolvedBlock), true);
  assert.equal((worker.match(/handleExternalCliTask/g) || []).length, 2);
});
