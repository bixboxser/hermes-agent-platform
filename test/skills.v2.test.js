const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSkillContext,
  checkSkillRequirements,
  formatSkillDoctor,
  formatSkillShow,
  formatSkillWhy,
  matchSkills,
} = require('../skills/registry');

test('/skills show custom skill returns SKILL.md content', () => {
  const output = formatSkillShow('vps-deploy-runbook', { rootDir: process.cwd(), maxChars: 3200 });
  assert.match(output, /Custom skill: vps-deploy-runbook/);
  assert.match(output, /## Procedure/);
  assert.match(output, /Docker Compose/);
});

test('/skills show unknown skill gives closest matches', () => {
  const output = formatSkillShow('unknown-name', { rootDir: process.cwd() });
  assert.match(output, /Skill not found: unknown-name/);
  assert.match(output, /Closest matches:/);
});

test('/skills why explains deterministic docker postgres matches', () => {
  const output = formatSkillWhy('fix docker compose postgres deploy issue', { env: {} });
  assert.match(output, /docker-compose-v1-safety/);
  assert.match(output, /postgres-recovery-runbook/);
  assert.match(output, /systematic-debugging|vps-deploy-runbook/);
  assert.match(output, /matched keywords:/);
  assert.match(output, /category\/workflow boost:/);
  assert.match(output, /Host\/operator tool required: docker/);
});

test('docker and psql are host/operator tools when unavailable in container', () => {
  const req = checkSkillRequirements({ tools: ['docker', 'psql'], env: [] }, {});
  assert.equal(req.ok, false);
  assert.deepEqual(req.missingTools, ['docker', 'psql']);
  assert.match(req.toolStatuses.find((t) => t.tool === 'docker').label, /Host\/operator tool required: docker/);
  const psql = req.toolStatuses.find((t) => t.tool === 'psql');
  if (!psql.availableInContainer) assert.match(psql.label, /Host\/operator tool required: psql/);
});

test('missing GOOGLE_APPLICATION_CREDENTIALS remains safe failure', () => {
  const req = checkSkillRequirements({ tools: ['google-workspace'], env: ['GOOGLE_APPLICATION_CREDENTIALS'] }, {});
  assert.equal(req.ok, false);
  assert.deepEqual(req.missingEnv, ['GOOGLE_APPLICATION_CREDENTIALS']);
  assert.deepEqual(req.missingTools, ['google-workspace']);
});

test('skill context is capped and loads only selected custom skills', () => {
  const context = buildSkillContext('fix docker compose postgres deploy issue', { maxChars: 500 });
  assert.equal(context.truncated, true);
  assert.ok(context.text.length <= 540);
  assert.ok(context.loadedCustomSkillPaths.every((p) => /skills\/custom\/.+\/SKILL\.md$/.test(p)));
  assert.deepEqual(context.selectedSkills.map((s) => s.name), matchSkills('fix docker compose postgres deploy issue').map((s) => s.name));
});

test('/skills doctor reports health without secret values', () => {
  const output = formatSkillDoctor({ env: { GOOGLE_APPLICATION_CREDENTIALS: 'secret-file.json' } });
  assert.match(output, /Hermes Skill System Doctor/);
  assert.match(output, /Registry loaded: true/);
  assert.doesNotMatch(output, /secret-file/);
});

test('/skills why formatter is lightweight and task-free', () => {
  const output = formatSkillWhy('fix docker compose postgres deploy issue');
  assert.match(output, /Skill match explanation/);
  assert.doesNotMatch(output, /Task created from Telegram/);
});

test('real task planning code emits skill usage events', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'index.js'), 'utf8');
  for (const eventName of ['skills_matched', 'skill_requirements_checked', 'skill_loaded', 'skill_missing_requirements', 'skill_context_attached']) {
    assert.match(source, new RegExp(eventName));
  }
});

test('small-talk still bypasses skill matching/heavy flow', () => {
  const { classifyTelegramSkillIntent } = require('../skills/registry');
  assert.deepEqual(classifyTelegramSkillIntent('Hi'), { intent: 'small_talk', skills: [] });
});
