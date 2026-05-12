process.env.PROJECT_ROOT_PROD = process.env.PROJECT_ROOT_PROD || '/tmp/hermes-prod-root-for-tests';
process.env.DISABLE_TELEGRAM = 'true';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSkillContext,
  buildSkillUsageEvents,
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

test('simulated real Telegram task writes Skill Layer v2 events with metadata', async () => {
  const { logSkillUsageForTask } = require('../index');
  const writes = [];
  await logSkillUsageForTask(24, 'fix docker compose postgres deploy issue skill event smoke', {
    env: { DATABASE_URL: 'postgres://secret-value-should-not-appear' },
    queryFn: async (sql, params) => {
      writes.push({ sql, params, metadata: JSON.parse(params[3]) });
      return { rows: [], rowCount: 1 };
    },
  });

  const eventTypes = writes.map((write) => write.params[1]);
  assert.deepEqual(eventTypes, ['skills_matched', 'skill_requirements_checked', 'skill_loaded', 'skill_context_attached']);
  assert.ok(writes.every((write) => /payload, metadata/.test(write.sql)));

  const matched = writes.find((write) => write.params[1] === 'skills_matched').metadata;
  assert.ok(matched.selected_skills.some((skill) => skill.name === 'docker-compose-v1-safety'));
  assert.ok(matched.selected_skills.every((skill) => Number.isFinite(skill.score)));
  assert.ok(matched.selected_skills.every((skill) => skill.category));
  assert.ok(matched.selected_skills.some((skill) => skill.matched_keywords.includes('docker') || skill.matched_keywords.includes('postgres')));
  assert.ok(matched.selected_skills.some((skill) => skill.workflow_boost_labels.length));

  const requirements = writes.find((write) => write.params[1] === 'skill_requirements_checked').metadata;
  assert.equal(typeof requirements.satisfied, 'boolean');
  assert.ok(Array.isArray(requirements.missing_env));
  assert.ok(Array.isArray(requirements.missing_tools));
  assert.ok(requirements.host_operator_required_tools.includes('docker'));
  assert.ok(requirements.skills.every((skill) => typeof skill.satisfied === 'boolean'));

  const loaded = writes.find((write) => write.params[1] === 'skill_loaded').metadata;
  assert.ok(loaded.loaded_custom_skill_paths.every((skillPath) => /skills\/custom\/.+\/SKILL\.md$/.test(skillPath)));
  assert.ok(loaded.selected_skill_names.includes('docker-compose-v1-safety'));
  assert.equal(typeof loaded.truncated, 'boolean');
  assert.ok(loaded.total_skill_context_chars > 0);

  const attached = writes.find((write) => write.params[1] === 'skill_context_attached').metadata;
  assert.ok(attached.attached_skill_names.includes('docker-compose-v1-safety'));
  assert.equal(typeof attached.truncated, 'boolean');
  assert.ok(attached.char_count > 0);
});

test('/skills why remains task-free and does not write task events', async () => {
  const { logSkillUsageForTask } = require('../index');
  const writes = [];
  await logSkillUsageForTask(26, '/skills why fix docker compose postgres deploy issue', { queryFn: async (...args) => writes.push(args) });
  const output = formatSkillWhy('fix docker compose postgres deploy issue');
  assert.match(output, /Skill match explanation/);
  assert.doesNotMatch(output, /Task created from Telegram/);
  assert.doesNotMatch(output, /hermes_tasks/);
  assert.deepEqual(writes, []);
  assert.equal(typeof logSkillUsageForTask, 'function');
});

test('small-talk does not write skill events', async () => {
  const { classifyTelegramSkillIntent } = require('../skills/registry');
  const { logSkillUsageForTask } = require('../index');
  const writes = [];
  assert.deepEqual(classifyTelegramSkillIntent('Hi'), { intent: 'small_talk', skills: [] });
  await logSkillUsageForTask(25, 'Hi', { queryFn: async (...args) => writes.push(args) });
  assert.deepEqual(writes, []);
});

test('skill event metadata redacts env values and includes only env names', () => {
  const events = buildSkillUsageEvents('somewhere payment payos admin webhook', {
    env: { PAYOS_CLIENT_ID: 'client-secret-value' },
  });
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /client-secret-value/);
  assert.doesNotMatch(serialized, /postgres:\/\//);
  const requirements = events.find((event) => event.event_type === 'skill_requirements_checked').metadata;
  assert.ok(requirements.missing_env.includes('PAYOS_API_KEY'));
  assert.ok(requirements.missing_env.includes('PAYOS_CHECKSUM_KEY'));
  assert.ok(!requirements.missing_env.includes('client-secret-value'));
});
