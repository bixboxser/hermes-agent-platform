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

const TOOL_CAPABILITY_PROFILE = Object.freeze({
  docker: { kind: "host_tool", hostStatus: "requires_host_operator" },
  psql: { kind: "host_or_container_tool", hostStatus: "requires_host_operator" },
  git: { kind: "container_tool" },
  node: { kind: "container_tool" },
  npm: { kind: "container_tool" },
  rg: { kind: "container_tool" },
  gh: { kind: "external_or_container_tool" },
  codex: { kind: "external_or_container_tool" },
  "google-workspace": { kind: "external_tool", env: ["GOOGLE_APPLICATION_CREDENTIALS"] },
});

const SKILL_CONTEXT_MAX_CHARS = 4500;
const TELEGRAM_SKILL_OUTPUT_MAX_CHARS = 3200;

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

  { name: "google-workspace", category: "BUSINESS_OPS", description: "Work with Google Sheets/Docs/Drive when credentials are available.", keywords: ["google", "sheet", "sheets", "docs", "drive", "cashier", "report"], tools: ["google-workspace"], env: ["GOOGLE_APPLICATION_CREDENTIALS"] },
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
  { name: "huong-cafe-daily-cashier-report", category: "CUSTOM", description: "Build Hưởng Café/Kitchen daily cashier reports in Google Sheets.", keywords: ["huong", "hưởng", "cafe", "kitchen", "cashier", "daily report", "google sheet", "sop", "menu"], tools: ["google-workspace"], env: ["GOOGLE_APPLICATION_CREDENTIALS"] },
];

function getSkillRegistry() {
  return CURATED_SKILLS.map((skill) => ({ ...skill, keywords: [...(skill.keywords || [])], tools: [...(skill.tools || [])], env: [...(skill.env || [])] }));
}

function analyzeSkillMatch(skill, queryText) {
  const q = String(queryText || "").toLowerCase();
  const nameParts = skill.name.split(/[-_]/).filter(Boolean);
  const matchedNameParts = nameParts.filter((part) => q.includes(part));
  const matchedKeywords = (skill.keywords || []).filter((keyword) => q.includes(keyword.toLowerCase()));
  const descHits = skill.description.toLowerCase().split(/\W+/).filter((word) => word.length > 4 && q.includes(word));
  const boosts = [];
  let workflowBoost = 0;

  if (/docker\s+compose/.test(q) && q.includes("postgres") && q.includes("deploy")) {
    if (["vps-deploy-runbook", "docker-compose-v1-safety", "postgres-recovery-runbook", "systematic-debugging"].includes(skill.name)) {
      const boost = skill.name === "vps-deploy-runbook" ? 4 : skill.name === "docker-compose-v1-safety" ? 18 : skill.name === "postgres-recovery-runbook" ? 14 : 20;
      workflowBoost += boost;
      boosts.push(`docker-compose postgres deploy +${boost}`);
    }
  }
  if ((q.includes(" pr") || q.includes("pull request")) && skill.name === "github-pr-workflow") { workflowBoost += 16; boosts.push("pull-request workflow +16"); }
  if (q.includes("booking") && q.includes("timezone") && skill.name === "somewhere-booking-debug") { workflowBoost += 12; boosts.push("booking timezone +12"); }
  if (q.includes("cashier") && q.includes("google") && skill.name === "google-workspace") { workflowBoost += 10; boosts.push("cashier google +10"); }
  if (q.includes("cashier") && (q.includes("sheet") || q.includes("report")) && skill.name === "huong-cafe-daily-cashier-report") { workflowBoost += 10; boosts.push("cashier report +10"); }

  const nameScore = matchedNameParts.length * 3;
  const keywordScore = matchedKeywords.length * 4;
  const descScore = descHits.length;
  return {
    nameScore,
    keywordScore,
    descScore,
    workflowBoost,
    boosts,
    matchedKeywords: [...new Set([...matchedNameParts, ...matchedKeywords])],
    score: nameScore + keywordScore + descScore + workflowBoost,
  };
}

function scoreSkill(skill, queryText) {
  return analyzeSkillMatch(skill, queryText).score;
}

function matchSkills(queryText, limit = 3) {
  const q = String(queryText || "").trim();
  if (!q) return [];
  const scored = getSkillRegistry()
    .map((skill) => ({ ...skill, ...analyzeSkillMatch(skill, q) }))
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const maxScore = scored[0]?.score || 0;
  const relevant = scored.filter((skill) => skill.score >= Math.max(8, maxScore * 0.25));
  return relevant.slice(0, Math.max(1, Math.min(Number(limit) || 3, 3)));
}

function toolAvailable(tool) {
  if (!/^[a-z0-9._-]+$/i.test(String(tool || ""))) return false;
  try {
    execFileSync("bash", ["--noprofile", "--norc", "-lc", `command -v ${tool}`], { stdio: "ignore", env: process.env });
    return true;
  } catch {
    return false;
  }
}

function describeToolStatus(tool, env = process.env) {
  const profile = TOOL_CAPABILITY_PROFILE[tool] || { kind: "container_tool" };
  const availableInContainer = profile.kind !== "external_tool" && toolAvailable(tool);
  if (profile.kind === "host_tool") {
    return { tool, kind: profile.kind, availableInContainer, status: process.env.HERMES_SAFE_HOST_WRAPPER ? "available_via_safe_wrapper" : profile.hostStatus, ok: Boolean(process.env.HERMES_SAFE_HOST_WRAPPER), label: `Host/operator tool required: ${tool}` };
  }
  if (profile.kind === "host_or_container_tool") {
    if (availableInContainer) return { tool, kind: profile.kind, availableInContainer, status: "available_container", ok: true, label: `${tool}: available in container` };
    return { tool, kind: profile.kind, availableInContainer, status: profile.hostStatus, ok: false, label: `Host/operator tool required: ${tool}` };
  }
  if (profile.kind === "external_tool") {
    const requiredEnv = profile.env || [];
    const missingEnv = requiredEnv.filter((name) => !env[name]);
    return { tool, kind: profile.kind, availableInContainer: false, status: missingEnv.length ? "missing_external_credentials" : "external_credentials_configured", ok: missingEnv.length === 0, missingEnv, label: `${tool}: external service${missingEnv.length ? " credentials missing" : " configured"}` };
  }
  if (profile.kind === "external_or_container_tool") {
    return { tool, kind: profile.kind, availableInContainer, status: availableInContainer ? "available_container" : "external_or_container_unavailable", ok: availableInContainer, label: availableInContainer ? `${tool}: available in container` : `${tool}: external/container tool unavailable` };
  }
  return { tool, kind: profile.kind, availableInContainer, status: availableInContainer ? "available_container" : "missing_container_tool", ok: availableInContainer, label: availableInContainer ? `${tool}: available in container` : `Missing container tool: ${tool}` };
}

function checkSkillRequirements(skill, env = process.env) {
  const missingEnv = (skill.env || []).filter((name) => !env[name]);
  const toolStatuses = (skill.tools || []).map((tool) => describeToolStatus(tool, env));
  const missingTools = toolStatuses.filter((status) => !status.ok).map((status) => status.tool);
  const hostOperatorTools = toolStatuses.filter((status) => status.status === "requires_host_operator" || status.status === "available_on_host_unverified").map((status) => status.tool);
  return {
    ok: missingEnv.length === 0 && missingTools.length === 0,
    missingEnv,
    missingTools,
    hostOperatorTools,
    toolStatuses,
  };
}

function buildSkillContext(queryText, options = {}) {
  const skills = matchSkills(queryText, options.limit || 3);
  return {
    input: String(queryText || ''),
    skills: skills.map((skill) => ({
      ...skill,
      requirements: checkSkillRequirements(skill, options.env || process.env),
    })),
  };
}

function classifyTelegramSkillIntent(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized || ["hi", "hello", "hey", "chào", "chao", "alo", "ok", "ping", "test"].includes(normalized)) {
    return { intent: "small_talk", skills: [] };
  }
  return { intent: "task", skills: matchSkills(normalized, 3) };
}

function customSkillPath(name, rootDir = process.cwd()) {
  return join(rootDir, "skills", "custom", name, "SKILL.md");
}

function loadCustomSkillMarkdown(name, rootDir = process.cwd()) {
  if (!CUSTOM_SKILL_NAMES.includes(name)) return null;
  const skillPath = customSkillPath(name, rootDir);
  if (!existsSync(skillPath)) return null;
  return readFileSync(skillPath, "utf8");
}

function closestSkillNames(name, limit = 3) {
  const needle = String(name || "").toLowerCase();
  return getSkillRegistry()
    .map((skill) => {
      const hay = skill.name.toLowerCase();
      const overlap = needle.split(/[-_\s]+/).filter((part) => part && hay.includes(part)).length;
      const prefix = hay.startsWith(needle.slice(0, Math.min(4, needle.length))) ? 2 : 0;
      const lengthPenalty = Math.abs(hay.length - needle.length) / 20;
      return { name: skill.name, score: overlap + prefix - lengthPenalty };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((item) => item.name);
}

function capTelegramText(text, max = TELEGRAM_SKILL_OUTPUT_MAX_CHARS) {
  const value = String(text || "");
  if (value.length <= max) return { text: value, truncated: false };
  const firstSection = value.split(/\n##\s+/)[0];
  const prefix = firstSection.length > 120 ? firstSection : value.slice(0, max - 120);
  return { text: `${prefix.slice(0, max - 120)}\n\n[Truncated for Telegram safety. Showing first section only.]`, truncated: true };
}

function formatSkillShow(name, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const wanted = String(name || "").trim();
  if (!wanted) return "Dùng: /skills show <name>";
  const skill = getSkillRegistry().find((item) => item.name === wanted);
  if (!skill) return [`Skill not found: ${wanted}`, `Closest matches: ${closestSkillNames(wanted).join(", ") || "none"}`].join("\n");
  const md = loadCustomSkillMarkdown(skill.name, rootDir);
  if (md) {
    const capped = capTelegramText(md, options.maxChars || TELEGRAM_SKILL_OUTPUT_MAX_CHARS);
    return [`Custom skill: ${skill.name}`, `Path: ${customSkillPath(skill.name, rootDir)}`, capped.text, capped.truncated ? "Output truncated: true" : "Output truncated: false"].join("\n\n");
  }
  return [
    `Curated metadata-only skill: ${skill.name}`,
    `Category: ${skill.category}`,
    `Description: ${skill.description}`,
    `Keywords: ${(skill.keywords || []).join(", ") || "none"}`,
    `Required env: ${(skill.env || []).join(", ") || "none"}`,
    `Required tools: ${(skill.tools || []).join(", ") || "none"}`,
    "Full SKILL.md is not installed locally; only curated public metadata is available.",
  ].join("\n");
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

function formatRequirementStatus(req) {
  const tools = (req.toolStatuses || []).map((item) => item.label).join("; ") || "none";
  return `env missing [${req.missingEnv.join(", ") || "none"}], tools [${tools}]`;
}

function formatSkillMatches(queryText, options = {}) {
  const matches = matchSkills(queryText, options.limit || 3);
  if (!matches.length) return `No curated Hermes skills matched: ${queryText}`;
  const lines = [`Matched curated Hermes skills for: ${queryText}`];
  for (const skill of matches) {
    const req = checkSkillRequirements(skill, options.env || process.env);
    lines.push(`- ${skill.name} (${skill.category}) — ${skill.description}`);
    if (!req.ok) lines.push(`  Safe failure until requirements exist: ${formatRequirementStatus(req)}`);
  }
  return lines.join("\n");
}

function formatSkillWhy(queryText, options = {}) {
  const matches = matchSkills(queryText, options.limit || 3);
  if (!matches.length) return `No skill match for: ${queryText}`;
  const lines = [`Skill match explanation for: ${queryText}`];
  for (const skill of matches) {
    const req = checkSkillRequirements(skill, options.env || process.env);
    lines.push(`- ${skill.name} score=${skill.score}`);
    lines.push(`  matched keywords: ${skill.matchedKeywords?.join(", ") || "none"}`);
    lines.push(`  category/workflow boost: ${skill.boosts?.join("; ") || "none"}`);
    lines.push(`  required env/tools: env [${(skill.env || []).join(", ") || "none"}], tools [${(skill.tools || []).join(", ") || "none"}]`);
    lines.push(`  requirements satisfied: ${req.ok ? "yes" : "no"} (${formatRequirementStatus(req)})`);
    lines.push(`  full SKILL.md loaded for real task: ${skill.category === "CUSTOM" && Boolean(loadCustomSkillMarkdown(skill.name, options.rootDir || process.cwd())) ? "yes" : "no; metadata only"}`);
  }
  return lines.join("\n");
}

function extractSection(md, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(md || "").match(new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|$)`, "im"));
  return match ? match[1].trim() : "";
}

function buildSkillContext(queryText, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const maxChars = options.maxChars || SKILL_CONTEXT_MAX_CHARS;
  const selected = matchSkills(queryText, options.limit || 3);
  const loadedCustomSkillPaths = [];
  const parts = [];
  for (const skill of selected) {
    const md = skill.category === "CUSTOM" ? loadCustomSkillMarkdown(skill.name, rootDir) : null;
    if (md) {
      loadedCustomSkillPaths.push(customSkillPath(skill.name, rootDir));
      parts.push([
        `### ${skill.name}`,
        `When to use: ${extractSection(md, "When to Use") || skill.description}`,
        `Procedure:\n${extractSection(md, "Procedure") || "- Follow existing Hermes safety gates."}`,
        `Pitfalls:\n${extractSection(md, "Pitfalls") || "- Do not bypass approval or execution validation."}`,
        `Verification:\n${extractSection(md, "Verification") || "- Verify with the narrowest safe check."}`,
        `Safety notes:\n${extractSection(md, "Safety/approval notes") || "- Keep approval gates intact; never log secrets."}`,
      ].join("\n"));
    } else {
      parts.push(`### ${skill.name}\nDescription: ${skill.description}\nRequirements: env [${(skill.env || []).join(", ") || "none"}], tools [${(skill.tools || []).join(", ") || "none"}]\nFull SKILL.md: not installed locally; metadata only.`);
    }
  }
  const full = parts.length ? `Skill Context\n${parts.join("\n\n")}` : "";
  const truncated = full.length > maxChars;
  const text = truncated ? `${full.slice(0, maxChars)}\n[Skill Context truncated]` : full;
  return {
    selectedSkills: selected.map((skill) => ({ name: skill.name, score: skill.score })),
    loadedCustomSkillPaths,
    text,
    truncated,
    totalSkillContextChars: text.length,
  };
}

function skillSelectionMetadata(selected) {
  return selected.map((skill) => ({
    name: skill.name,
    score: skill.score,
    category: skill.category,
    matched_keywords: skill.matchedKeywords || [],
    workflow_boost_labels: skill.boosts || [],
  }));
}

function skillRequirementsMetadata(selected, env = process.env) {
  const skills = selected.map((skill) => {
    const req = checkSkillRequirements(skill, env);
    return {
      name: skill.name,
      satisfied: req.ok,
      missing_env: req.missingEnv,
      missing_tools: req.missingTools,
      host_operator_required_tools: req.hostOperatorTools,
      tool_statuses: (req.toolStatuses || []).map((tool) => ({
        tool: tool.tool,
        kind: tool.kind,
        status: tool.status,
        available_in_container: tool.availableInContainer,
      })),
    };
  });
  return {
    satisfied: skills.every((skill) => skill.satisfied),
    missing_env: [...new Set(skills.flatMap((skill) => skill.missing_env || []))],
    missing_tools: [...new Set(skills.flatMap((skill) => skill.missing_tools || []))],
    host_operator_required_tools: [...new Set(skills.flatMap((skill) => skill.host_operator_required_tools || []))],
    skills,
  };
}

function buildSkillUsageEvents(queryText, options = {}) {
  if (/^\/skills(?:\s+(?:why|show|doctor|list|match)\b|\s*$)/i.test(String(queryText || "").trim())) {
    return [];
  }
  const routed = classifyTelegramSkillIntent(queryText);
  if (routed.intent === "small_talk") return [];
  const selected = matchSkills(queryText, options.limit || 3);
  if (!selected.length) return [];

  const selectedSkills = skillSelectionMetadata(selected);
  const requirements = skillRequirementsMetadata(selected, options.env || process.env);
  const context = buildSkillContext(queryText, options);
  const selectedSkillNames = selectedSkills.map((skill) => skill.name);
  const events = [
    {
      event_type: "skills_matched",
      message: "Skills matched for task planning",
      metadata: { selected_skills: selectedSkills },
    },
    {
      event_type: "skill_requirements_checked",
      message: "Skill requirements checked",
      metadata: { selected_skill_names: selectedSkillNames, ...requirements },
    },
  ];

  if (context.loadedCustomSkillPaths.length) {
    events.push({
      event_type: "skill_loaded",
      message: "Custom skill context loaded",
      metadata: {
        loaded_custom_skill_paths: context.loadedCustomSkillPaths,
        selected_skill_names: selectedSkillNames,
        truncated: context.truncated,
        total_skill_context_chars: context.totalSkillContextChars,
      },
    });
  }

  if (context.text) {
    events.push({
      event_type: "skill_context_attached",
      message: "Skill context attached to planning context",
      metadata: {
        attached_skill_names: selectedSkillNames,
        truncated: context.truncated,
        char_count: context.totalSkillContextChars,
      },
    });
  }

  return events;
}

function getSkillDoctor(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const customFiles = CUSTOM_SKILL_NAMES.map((name) => ({ name, path: customSkillPath(name, rootDir), readable: Boolean(loadCustomSkillMarkdown(name, rootDir)) }));
  const containerTools = Object.keys(TOOL_CAPABILITY_PROFILE).filter((tool) => TOOL_CAPABILITY_PROFILE[tool].kind !== "external_tool" && toolAvailable(tool));
  const hostTools = Object.entries(TOOL_CAPABILITY_PROFILE).filter(([, meta]) => meta.kind === "host_tool" || meta.kind === "host_or_container_tool").map(([tool, meta]) => `${tool}:${meta.hostStatus || "requires_host_operator"}`);
  const optionalEnvWarnings = ["GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].filter((name) => !(options.env || process.env)[name]);
  return {
    totalCuratedSkills: getSkillRegistry().filter((skill) => skill.category !== "CUSTOM").length,
    totalCustomSkills: CUSTOM_SKILL_NAMES.length,
    customFiles,
    registryLoaded: true,
    envToolCheckerStatus: "ok",
    availableContainerTools: containerTools,
    hostToolsOperatorRequired: hostTools,
    warningsMissingOptionalEnvs: optionalEnvWarnings,
  };
}

function formatSkillDoctor(options = {}) {
  const d = getSkillDoctor(options);
  return [
    "Hermes Skill System Doctor",
    `- Registry loaded: ${d.registryLoaded}`,
    `- Total curated skills: ${d.totalCuratedSkills}`,
    `- Total custom skills: ${d.totalCustomSkills}`,
    `- Custom skill files readable: ${d.customFiles.filter((f) => f.readable).length}/${d.customFiles.length}`,
    `- Env/tool checker: ${d.envToolCheckerStatus}`,
    `- Available container tools: ${d.availableContainerTools.join(", ") || "none"}`,
    `- Host tools operator-required: ${d.hostToolsOperatorRequired.join(", ") || "none"}`,
    `- Missing optional env names: ${d.warningsMissingOptionalEnvs.join(", ") || "none"}`,
    "No secret values printed.",
  ].join("\n");
}

module.exports = {
  CUSTOM_SKILL_NAMES,
  TOOL_CAPABILITY_PROFILE,
  SKILL_CONTEXT_MAX_CHARS,
  TELEGRAM_SKILL_OUTPUT_MAX_CHARS,
  getSkillRegistry,
  analyzeSkillMatch,
  matchSkills,
  checkSkillRequirements,
  buildSkillContext,
  classifyTelegramSkillIntent,
  loadCustomSkillMarkdown,
  buildSkillContext,
  buildSkillUsageEvents,
  closestSkillNames,
  formatSkillsList,
  formatSkillMatches,
  formatSkillShow,
  formatSkillWhy,
  getSkillDoctor,
  formatSkillDoctor,
};
