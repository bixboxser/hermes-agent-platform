const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

const CUSTOM_SKILL_NAMES = [
  "vps-deploy-runbook",
  "docker-compose-v1-safety",
  "postgres-recovery-runbook",
  "telegram-operator-flow",
  "approval-snapshot-safety",
  "somewhere-booking-debug",
  "somewhere-payment-admin-debug",
  "huong-cafe-daily-cashier-report",
];

const CURATED_SKILLS = [
  { name: "hermes-agent", category: "CORE_AGENT", description: "Operate the custom Hermes Node.js agent safely.", keywords: ["hermes", "agent", "node", "worker", "operator"], tools: ["node"], env: [] },
  { name: "hermes-agent-skill-authoring", category: "CORE_AGENT", description: "Author small procedural Hermes skills without loading the full public catalog.", keywords: ["skill", "author", "skill.md", "procedure"], tools: [], env: [] },
  { name: "plan", category: "CORE_AGENT", description: "Break a task into explicit steps before execution.", keywords: ["plan", "steps", "proposal"], tools: [], env: [] },
  { name: "writing-plans", category: "CORE_AGENT", description: "Write clear implementation plans and acceptance criteria.", keywords: ["write plan", "planning", "acceptance"], tools: [], env: [] },
  { name: "systematic-debugging", category: "CORE_AGENT", description: "Debug by reproducing, isolating, fixing, and verifying.", keywords: ["debug", "bug", "root cause", "issue", "error", "fix"], tools: [], env: [] },
  { name: "requesting-code-review", category: "CORE_AGENT", description: "Ask for a useful code review with context and risk notes.", keywords: ["review", "code review", "request review"], tools: [], env: [] },
  { name: "test-driven-development", category: "CORE_AGENT", description: "Write or update tests before changing behavior.", keywords: ["test", "tdd", "regression"], tools: ["npm"], env: [] },
  { name: "spike", category: "CORE_AGENT", description: "Time-box uncertain technical exploration.", keywords: ["spike", "explore", "prototype"], tools: [], env: [] },
  { name: "dogfood", category: "CORE_AGENT", description: "Use Hermes against its own workflows and record lessons.", keywords: ["dogfood", "self test", "hermes"], tools: [], env: [] },
  { name: "native-mcp", category: "CORE_AGENT", description: "Use native MCP integrations only when connected and relevant.", keywords: ["mcp", "tool", "integration"], tools: [], env: [] },
  { name: "webhook-subscriptions", category: "CORE_AGENT", description: "Design and debug webhook subscription flows.", keywords: ["webhook", "subscription", "callback"], tools: [], env: [] },

  { name: "codex", category: "CODE_GITHUB", description: "Prepare Codex tasks and consume Codex results.", keywords: ["codex", "agent", "task"], tools: ["git"], env: [] },
  { name: "github-auth", category: "CODE_GITHUB", description: "Check GitHub auth requirements without exposing tokens.", keywords: ["github", "auth", "token", "permission"], tools: ["git"], env: ["GITHUB_TOKEN"] },
  { name: "github-pr-workflow", category: "CODE_GITHUB", description: "Create, review, and track GitHub pull requests.", keywords: ["github", "pr", "pull request", "merge", "branch", "booking"], tools: ["git"], env: ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"] },
  { name: "github-issues", category: "CODE_GITHUB", description: "Create and triage GitHub issues for Codex handoff.", keywords: ["issue", "ticket", "bug", "github"], tools: ["git"], env: ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"] },
  { name: "github-code-review", category: "CODE_GITHUB", description: "Review GitHub diffs and comments safely.", keywords: ["review", "diff", "github", "pr"], tools: ["git"], env: ["GITHUB_TOKEN"] },
  { name: "github-repo-management", category: "CODE_GITHUB", description: "Inspect and maintain GitHub repo settings and branches.", keywords: ["repo", "branch", "github", "manage"], tools: ["git"], env: ["GITHUB_TOKEN"] },
  { name: "codebase-inspection", category: "CODE_GITHUB", description: "Inspect repo structure before editing code.", keywords: ["inspect", "codebase", "repo", "find"], tools: ["rg", "git"], env: [] },

  { name: "google-workspace", category: "BUSINESS_OPS", description: "Work with Google Sheets/Docs/Drive when credentials are available.", keywords: ["google", "sheet", "sheets", "docs", "drive", "cashier", "report"], tools: [], env: ["GOOGLE_APPLICATION_CREDENTIALS"] },
  { name: "maps", category: "BUSINESS_OPS", description: "Use maps/location workflows for business ops.", keywords: ["maps", "location", "route", "place"], tools: [], env: [] },
  { name: "ocr-and-documents", category: "BUSINESS_OPS", description: "Extract text from images and operational documents.", keywords: ["ocr", "document", "receipt", "invoice", "scan"], tools: [], env: [] },
  { name: "nano-pdf", category: "BUSINESS_OPS", description: "Create or inspect compact PDF outputs.", keywords: ["pdf", "export", "document"], tools: [], env: [] },
  { name: "powerpoint", category: "BUSINESS_OPS", description: "Prepare slide decks and business presentations.", keywords: ["powerpoint", "slides", "presentation"], tools: [], env: [] },

  { name: "popular-web-designs", category: "DESIGN_CONTENT", description: "Reference common web design patterns.", keywords: ["web design", "landing", "ui", "website"], tools: [], env: [] },
  { name: "claude-design", category: "DESIGN_CONTENT", description: "Structure design prompts and visual critiques.", keywords: ["design", "mockup", "visual"], tools: [], env: [] },
  { name: "sketch", category: "DESIGN_CONTENT", description: "Sketch product/content ideas before implementation.", keywords: ["sketch", "wireframe", "draft"], tools: [], env: [] },
  { name: "architecture-diagram", category: "DESIGN_CONTENT", description: "Create architecture diagrams for systems and deploys.", keywords: ["architecture", "diagram", "system", "flow"], tools: [], env: [] },
  { name: "humanizer", category: "DESIGN_CONTENT", description: "Rewrite content in a more natural, human tone.", keywords: ["humanize", "rewrite", "tone", "content"], tools: [], env: [] },
  { name: "baoyu-infographic", category: "DESIGN_CONTENT", description: "Create clear infographic-style content.", keywords: ["infographic", "visual", "content"], tools: [], env: [] },
  { name: "youtube-content", category: "DESIGN_CONTENT", description: "Plan YouTube scripts, titles, and content workflows.", keywords: ["youtube", "video", "script", "thumbnail"], tools: [], env: [] },

  { name: "vps-deploy-runbook", category: "CUSTOM", description: "Deploy and debug the Hermes Node.js agent on a VPS.", keywords: ["vps", "deploy", "server", "ssh", "production", "docker compose", "postgres"], tools: ["docker", "git"], env: [] },
  { name: "docker-compose-v1-safety", category: "CUSTOM", description: "Run Docker Compose safely without destructive volume removal.", keywords: ["docker", "compose", "container", "logs", "postgres", "deploy"], tools: ["docker"], env: [] },
  { name: "postgres-recovery-runbook", category: "CUSTOM", description: "Recover or debug Postgres safely with backups first.", keywords: ["postgres", "database", "db", "migration", "backup", "recovery"], tools: ["psql"], env: ["DATABASE_URL"] },
  { name: "telegram-operator-flow", category: "CUSTOM", description: "Route Telegram operator requests through lightweight intent matching.", keywords: ["telegram", "operator", "bot", "message", "small talk", "routing"], tools: [], env: ["TELEGRAM_TOKEN", "ALLOWED_USER_IDS"] },
  { name: "approval-snapshot-safety", category: "CUSTOM", description: "Preserve approval snapshot hashing and explicit approval boundaries.", keywords: ["approval", "snapshot", "hash", "approve", "risk"], tools: [], env: [] },
  { name: "somewhere-booking-debug", category: "CUSTOM", description: "Debug Somewhere Staycation booking/admin/timezone flows.", keywords: ["somewhere", "staycation", "booking", "timezone", "calendar", "supabase"], tools: ["git"], env: ["NEXT_PUBLIC_SUPABASE_URL"] },
  { name: "somewhere-payment-admin-debug", category: "CUSTOM", description: "Debug Somewhere payOS payment, webhook, and admin flows.", keywords: ["somewhere", "payment", "payos", "qr", "webhook", "admin", "supabase"], tools: ["git"], env: ["PAYOS_CLIENT_ID", "PAYOS_API_KEY", "PAYOS_CHECKSUM_KEY"] },
  { name: "huong-cafe-daily-cashier-report", category: "CUSTOM", description: "Build Hưởng Café/Kitchen daily cashier reports in Google Sheets.", keywords: ["huong", "hưởng", "cafe", "kitchen", "cashier", "daily report", "google sheet", "sop", "menu"], tools: [], env: ["GOOGLE_APPLICATION_CREDENTIALS"] },
];

function getSkillRegistry() {
  return CURATED_SKILLS.map((skill) => ({ ...skill }));
}

function scoreSkill(skill, queryText) {
  const q = String(queryText || "").toLowerCase();
  const nameHits = skill.name.split(/[-_]/).filter((part) => q.includes(part)).length * 3;
  const keywordHits = skill.keywords.filter((keyword) => q.includes(keyword.toLowerCase())).length * 4;
  const descHits = skill.description.toLowerCase().split(/\W+/).filter((word) => word.length > 4 && q.includes(word)).length;
  let workflowBoost = 0;

  if (/docker\s+compose/.test(q) && q.includes("postgres") && q.includes("deploy") && skill.name === "vps-deploy-runbook") workflowBoost += 20;
  if ((q.includes(" pr") || q.includes("pull request")) && skill.name === "github-pr-workflow") workflowBoost += 16;
  if (q.includes("booking") && q.includes("timezone") && skill.name === "somewhere-booking-debug") workflowBoost += 12;
  if (q.includes("cashier") && q.includes("google") && skill.name === "google-workspace") workflowBoost += 10;
  if (q.includes("cashier") && (q.includes("sheet") || q.includes("report")) && skill.name === "huong-cafe-daily-cashier-report") workflowBoost += 10;

  return nameHits + keywordHits + descHits + workflowBoost;
}

function matchSkills(queryText, limit = 3) {
  const q = String(queryText || "").trim();
  if (!q) return [];
  const scored = getSkillRegistry()
    .map((skill) => ({ ...skill, score: scoreSkill(skill, q) }))
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const maxScore = scored[0]?.score || 0;
  const relevant = scored.filter((skill) => skill.score >= Math.max(8, maxScore * 0.35));
  return relevant.slice(0, Math.max(1, Math.min(Number(limit) || 3, 3)));
}

function toolAvailable(tool) {
  if (!/^[a-z0-9._-]+$/i.test(String(tool || ""))) return false;
  try {
    execFileSync("sh", ["-lc", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkSkillRequirements(skill, env = process.env) {
  const missingEnv = (skill.env || []).filter((name) => !env[name]);
  const missingTools = (skill.tools || []).filter((tool) => !toolAvailable(tool));
  return {
    ok: missingEnv.length === 0 && missingTools.length === 0,
    missingEnv,
    missingTools,
  };
}

function classifyTelegramSkillIntent(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized || ["hi", "hello", "hey", "chào", "chao", "alo", "ok", "ping", "test"].includes(normalized)) {
    return { intent: "small_talk", skills: [] };
  }
  return { intent: "task", skills: matchSkills(normalized, 3) };
}

function loadCustomSkillMarkdown(name, rootDir = process.cwd()) {
  if (!CUSTOM_SKILL_NAMES.includes(name)) return null;
  const skillPath = join(rootDir, "skills", "custom", name, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  return readFileSync(skillPath, "utf8");
}

function formatSkillsList() {
  const grouped = getSkillRegistry().reduce((acc, skill) => {
    acc[skill.category] = acc[skill.category] || [];
    acc[skill.category].push(skill.name);
    return acc;
  }, {});
  return Object.entries(grouped)
    .map(([category, names]) => `${category}\n${names.map((name) => `- ${name}`).join("\n")}`)
    .join("\n\n");
}

function formatSkillMatches(queryText, options = {}) {
  const matches = matchSkills(queryText, options.limit || 3);
  if (!matches.length) return `No curated Hermes skills matched: ${queryText}`;
  const lines = [`Matched curated Hermes skills for: ${queryText}`];
  for (const skill of matches) {
    const req = checkSkillRequirements(skill, options.env || process.env);
    lines.push(`- ${skill.name} (${skill.category}) — ${skill.description}`);
    if (!req.ok) {
      lines.push(`  Safe failure until requirements exist: missing env [${req.missingEnv.join(", ") || "none"}], missing tools [${req.missingTools.join(", ") || "none"}]`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  CUSTOM_SKILL_NAMES,
  getSkillRegistry,
  matchSkills,
  checkSkillRequirements,
  classifyTelegramSkillIntent,
  loadCustomSkillMarkdown,
  formatSkillsList,
  formatSkillMatches,
};
