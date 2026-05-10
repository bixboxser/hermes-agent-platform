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
  assert.match(
    worker,
    /const \{ handleExternalCliTask, approvedExternalCliActionsFromSnapshot \} = require\('\.\/dispatcher\/externalCliTools'\);/,
  );
  assert.match(
    worker,
    /const \{ buildSkillContext, matchSkills, checkSkillRequirements \} = require\('\.\/skills\/registry'\);/,
  );
});
