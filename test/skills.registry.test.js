const assert = require("node:assert/strict");
const {
  CUSTOM_SKILL_NAMES,
  classifyTelegramSkillIntent,
  formatSkillMatches,
  getSkillRegistry,
  matchSkills,
} = require("../skills/registry");

const expectedCuratedNames = new Set([
  "hermes-agent",
  "hermes-agent-skill-authoring",
  "plan",
  "writing-plans",
  "systematic-debugging",
  "requesting-code-review",
  "test-driven-development",
  "spike",
  "dogfood",
  "native-mcp",
  "webhook-subscriptions",
  "codex",
  "github-auth",
  "github-pr-workflow",
  "github-issues",
  "github-code-review",
  "github-repo-management",
  "codebase-inspection",
  "google-workspace",
  "maps",
  "ocr-and-documents",
  "nano-pdf",
  "powerpoint",
  "popular-web-designs",
  "claude-design",
  "sketch",
  "architecture-diagram",
  "humanizer",
  "baoyu-infographic",
  "youtube-content",
  ...CUSTOM_SKILL_NAMES,
]);

const registryNames = getSkillRegistry().map((skill) => skill.name);
assert.deepEqual(new Set(registryNames), expectedCuratedNames, "registry must contain only the curated Hermes Skill Pack v1");
assert.equal(registryNames.length, expectedCuratedNames.size, "registry names must be unique");

assert.deepEqual(
  matchSkills("fix docker compose postgres deploy issue").map((skill) => skill.name),
  ["vps-deploy-runbook", "docker-compose-v1-safety"],
);

assert.deepEqual(
  matchSkills("create PR for booking timezone bug").map((skill) => skill.name),
  ["github-pr-workflow", "somewhere-booking-debug"],
);

assert.deepEqual(
  matchSkills("make daily cashier report Google Sheet").map((skill) => skill.name),
  ["google-workspace", "huong-cafe-daily-cashier-report"],
);

assert.equal(classifyTelegramSkillIntent("hi").intent, "small_talk");
assert.deepEqual(classifyTelegramSkillIntent("hi").skills, []);

const safeFailure = formatSkillMatches("make daily cashier report Google Sheet", { env: {} });
assert.match(safeFailure, /Safe failure until requirements exist/);
assert.match(safeFailure, /GOOGLE_APPLICATION_CREDENTIALS/);

console.log("skills.registry.test.js passed");
