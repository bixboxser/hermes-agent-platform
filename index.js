const nodeCrypto = require('node:crypto');
const express = require("express");
const axios = require("axios");
const { query } = require("./db");
const { canonicalizeApprovalSnapshot, hashApprovalSnapshot, normalizeInputText } = require("./approvalSnapshot");
const { getSystemHealth } = require("./dispatcher/health");
const {
  formatSkillsList,
  formatSkillMatches,
  formatSkillShow,
  formatSkillWhy,
  formatSkillDoctor,
  classifyTelegramSkillIntent,
  matchSkills,
  checkSkillRequirements,
  buildSkillContext,
  buildSkillUsageEvents,
} = require("./skills/registry");
const {
  ensureGBrainSchema,
  learnFromText,
  recallMemories,
  rememberOperatorMemory,
  recallOperatorMemories,
  getOperatorMemoryStats,
  runDispatcher,
  buildCodexPrompt,
  reviewCodexResult,
  buildAudit,
  buildDeployCheck,
} = require("./gbrain");
const { isExternalCliTask, routeTool, buildExternalCliApprovalPlan } = require('./dispatcher/externalCliTools');
const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    const health = await getSystemHealth();
    const code = health.status === 'down' ? 503 : 200;
    return res.status(code).json(health);
  } catch (_e) {
    return res.status(503).json({ status: 'down', env: process.env.HERMES_ENV || 'dev', db: { ok: false } });
  }
});


const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const AUTO_DAILY_ENABLED = process.env.AUTO_DAILY_ENABLED === "true";
const AUTO_WEEKLY_ENABLED = process.env.AUTO_WEEKLY_ENABLED === "true";

let lastDailyKey = null;
let lastWeeklyKey = null;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_STATES = {
  IDLE: null,
  AWAITING_DEPLOY_CHECK: "awaiting_deploy_check",
  AWAITING_CODEX: "awaiting_codex",
  AWAITING_REVIEW: "awaiting_review",
  AWAITING_RECALL: "awaiting_recall",
  AWAITING_LEARN: "awaiting_learn",
  AWAITING_AUDIT: "awaiting_audit",
};
const ALLOWED_USER_IDS = String(process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((id) => Number(id.trim()))
  .filter(Boolean);

let offset = 0;

const { exec } = require("child_process");

function execAsync(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: (stdout || "").toString(),
        stderr: (stderr || "").toString(),
      });
    });
  });
}

async function sendTelegramMessage(chatId, text, extra ={}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: String(text || "").replace(/(token|apikey|authorization|password|bearer)\s*[:=]?\s*[^\s]+/gi, "$1=[REDACTED]").slice(0, 3500),
    ...extra,
  });
}


async function getOrCreateTelegramSession(userId) {
  const existing = await query(
    `select * from telegram_sessions where telegram_user_id = $1`,
    [userId]
  );

  if (existing.rows[0]) return existing.rows[0];

  await query(
    `insert into telegram_sessions (telegram_user_id)
     values ($1)
     on conflict (telegram_user_id) do nothing`,
    [userId]
  );

  const created = await query(
    `select * from telegram_sessions where telegram_user_id = $1`,
    [userId]
  );

  return created.rows[0] || null;
}

async function setTelegramSessionState(userId, state, data) {
  if (data === undefined) {
    await query(
      `insert into telegram_sessions (telegram_user_id, state, updated_at)
       values ($1, $2, now())
       on conflict (telegram_user_id)
       do update set state = excluded.state, updated_at = now()`,
      [userId, state]
    );
    return;
  }

  await query(
    `insert into telegram_sessions (telegram_user_id, state, data, updated_at)
     values ($1, $2, $3, now())
     on conflict (telegram_user_id)
     do update set state = excluded.state, data = excluded.data, updated_at = now()`,
    [userId, state, data]
  );
}

async function clearTelegramSessionState(userId) {
  await query(
    `insert into telegram_sessions (telegram_user_id, state, updated_at)
     values ($1, null, now())
     on conflict (telegram_user_id)
     do update set state = null, updated_at = now()`,
    [userId]
  );
}

async function handleTelegramState({ userId, chatId, text, state }) {
  switch (state) {
    case TELEGRAM_STATES.AWAITING_DEPLOY_CHECK: {
      const result = await buildDeployCheck(text);
      await sendTelegramMessage(chatId, `🚀 Deploy Check:

${result}`);
      await clearTelegramSessionState(userId);
      return true;
    }
    case TELEGRAM_STATES.AWAITING_CODEX: {
      const result = await buildCodexPrompt(text);
      await sendTelegramMessage(chatId, `🛠 Prompt Codex:

${result}`);
      await clearTelegramSessionState(userId);
      return true;
    }
    case TELEGRAM_STATES.AWAITING_REVIEW: {
      const result = await reviewCodexResult(text);

      let autoLearnText = "";
      try {
        const memory = await learnFromText(result, "auto_review");
        autoLearnText = `

🧬 Auto Learn: đã lưu vào GBrain
- ${memory.title}`;
      } catch (e) {
        autoLearnText = `

⚠️ Auto Learn lỗi: ${e.message}`;
      }

      await sendTelegramMessage(chatId, `🔍 Review Patch:

${result}${autoLearnText}`);
      await clearTelegramSessionState(userId);
      return true;
    }
    case TELEGRAM_STATES.AWAITING_RECALL: {
      const memories = await recallMemories(text);
      const reply = memories.length
        ? memories.map((m) => `🧠 ${m.title}\n${m.summary}\n${m.lesson ? `Lesson: ${m.lesson}` : ""}`).join("\n\n")
        : "Chưa tìm thấy memory liên quan.";

      await sendTelegramMessage(chatId, reply);
      await clearTelegramSessionState(userId);
      return true;
    }
    case TELEGRAM_STATES.AWAITING_LEARN: {
      const memory = await learnFromText(text, "button_learn");
      await sendTelegramMessage(chatId, `🧬 Đã lưu vào GBrain:
${memory.title}

${memory.lesson || memory.summary}`);
      await clearTelegramSessionState(userId);
      return true;
    }
    case TELEGRAM_STATES.AWAITING_AUDIT: {
      const result = await buildAudit(text);
      await sendTelegramMessage(chatId, `🧪 Audit:

${result}`);
      await clearTelegramSessionState(userId);
      return true;
    }
    default:
      return false;
  }
}

async function createGithubIssue(taskText) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    throw new Error("Missing GitHub env: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  }

  const issueBody = `[TASK] ${taskText}

[CONTEXT]
This is Hermes Agent Platform.
Do not reference or modify any external project.

[READ FIRST]

* index.js
* worker.js
* gbrain.js
* db/**
* docker-compose.yml

[REQUIREMENTS]

* Follow existing architecture
* Do not break Telegram bot
* Log lifecycle events into hermes_task_events
* Preserve duplicate issue protection logic

[ACCEPTANCE]

* Feature works end-to-end
* Code builds
* No regression

[OUTPUT]
Create a pull request with implementation.`;

  const res = await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      title: `[Code Agent] ${taskText.slice(0, 120)}`,
      body: issueBody,
      labels: ["code-agent"],
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  return {
    issueUrl: res.data.html_url,
    issueNumber: res.data.number,
  };
}


async function createIssueComment(taskId, issueNumber, body) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    throw new Error("Missing GitHub env: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  }

  try {
    const res = await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

    return {
      commentUrl: res.data.html_url,
    };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    await query(
      `insert into hermes_task_events (task_id, event_type, message, payload)
       values ($1, 'codex_trigger_failed', $2, $3)`,
      [taskId, "Failed to add Codex trigger comment", { error: errMsg }]
    );
    throw err;
  }
}

async function findLinkedPullRequest(issueNumber) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    throw new Error("Missing GitHub env: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  }

  const res = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  const linked = (res.data || []).find(
    (e) => e.event === "cross-referenced" && e.source?.issue?.pull_request?.html_url
  );

  if (!linked) return null;

  return {
    pullRequestUrl: linked.source.issue.pull_request.html_url,
    pullRequestNumber: linked.source.issue.number,
  };
}

async function buildDailyReport() {
  let memoryCount = 0;
  try {
    const mem = await query(`select count(*)::int as c from gbrain_memories`);
    memoryCount = mem.rows[0]?.c || 0;
  } catch {}

  let activeSessions = 0;
  try {
    const s = await query(
      `select count(*)::int as c from telegram_sessions where state is not null`
    );
    activeSessions = s.rows[0]?.c || 0;
  } catch {}

  let recentTasks = [];
  try {
    const t = await query(
      `select id, status, input_text, created_at
       from hermes_tasks
       order by created_at desc
       limit 5`
    );
    recentTasks = t.rows || [];
  } catch {}

  const grouped = {};
  for (const t of recentTasks) {
      const s = (t.input_text || "").toLowerCase();

  if (
    s === "/time" ||
    s === "/memu" ||
    s === "/menu" ||
    s === "/status" ||
    s === "/daily" ||
    s === "/weekly" ||
    s === "/commands"
  ) {
    continue;
  }

  const key = s.slice(0, 30);
  grouped[key] = (grouped[key] || 0) + 1;  
  }

  const taskText =
    Object.entries(grouped)
      .map(([k, v]) => `${v}x - ${k}`)
      .join("\n") || "Chưa có task";

  let topIssues = [];
  try {
    const rows = await query(`
      select 
        case
          when input_text ilike '%payment%' then 'payment'
          when input_text ilike '%qr%' then 'qr'
          when input_text ilike '%booking%' then 'booking'
          when input_text ilike '%admin%' then 'admin'
          when input_text ilike '%cleaner%' then 'cleaner'
          else null
        end as key,
        count(*)::int as c
      from hermes_tasks
      where input_text is not null
        and input_text not ilike '%git%'
        and input_text not ilike '%readme%'
        and input_text not ilike '%package.json%'
        and input_text not ilike '%xem repo%'
        and input_text not ilike '%chạy lệnh%'
      group by key
      having
        case
          when input_text ilike '%payment%' then 'payment'
          when input_text ilike '%qr%' then 'qr'
          when input_text ilike '%booking%' then 'booking'
          when input_text ilike '%admin%' then 'admin'
          when input_text ilike '%cleaner%' then 'cleaner'
          else null
        end is not null
      order by c desc
      limit 3
    `);

    topIssues = rows.rows || [];
  } catch {}

  const issueText = topIssues.length
    ? topIssues.map((i) => `${i.c}x - ${i.key}`).join("\n")
    : "Chưa có pattern rõ";

  const appLog = await execAsync("docker logs hermes_app --tail 20 2>&1");
  const workerLog = await execAsync("docker logs hermes_worker --tail 20 2>&1");

  const appErr = (appLog.stdout || "").toLowerCase().includes("error");
  const workerErr = (workerLog.stdout || "").toLowerCase().includes("error");

  let suggestions = [];

  if (topIssues.length > 0) {
    const top = topIssues[0].key;

    if (top === "payment") {
      suggestions.push("🔥 Ưu tiên cao: Fix payment QR ngay");
      suggestions.push("👉 Gợi ý: /audit lỗi payment QR → /codex fix → /review");
    }

    if (top === "cleaner") {
      suggestions.push("🧹 Kiểm tra flow cleaner bot hoặc task assignment");
    }

    if (top === "booking") {
      suggestions.push("📅 Kiểm tra booking flow / conflict / pricing");
    }
  }

  if (memoryCount < 10) {
    suggestions.push("🧠 Nên dùng /learn thêm để tăng GBrain");
  }

  if (activeSessions > 0) {
    suggestions.push("⚠️ Có session đang chờ → hoàn thành flow đang dở");
  }

  if (appErr || workerErr) {
    suggestions.push("🚨 Có dấu hiệu lỗi → chạy /audit");
  }

  if (suggestions.length === 0) {
    suggestions.push("✅ Hệ thống ổn → tiếp tục /codex hoặc /audit");
  }

  return `📅 Hermes Daily Report

🤖 System:
- hermes_app: ${appErr ? "⚠️ issue" : "OK"}
- hermes_worker: ${workerErr ? "⚠️ issue" : "OK"}

🧠 GBrain:
- Memories: ${memoryCount}

🧩 Sessions:
- Active: ${activeSessions}

📌 Recent Tasks:
${taskText}

🔥 Top Issues:
${issueText}

🎯 Gợi ý:
${suggestions.join("\n")}

NEXT ACTION:
- Debug → /audit <vấn đề>
- Fix → /codex <task>
- Review → /review <kết quả>`;
}

async function buildWeeklyReport() {
  let tasks7d = [];
  try {
    const t = await query(`
      select input_text, created_at
      from hermes_tasks
      where created_at >= now() - interval '7 days'
        and input_text is not null
    `);
    tasks7d = t.rows || [];
  } catch {}

  const counter = {};
  for (const t of tasks7d) {
    const s = (t.input_text || "").toLowerCase();

    let key = null;
    if (s.includes("payment")) key = "payment";
    else if (s.includes("qr")) key = "qr";
    else if (s.includes("booking")) key = "booking";
    else if (s.includes("admin")) key = "admin";
    else if (s.includes("cleaner")) key = "cleaner";

    if (!key) continue;
    if (
      s.includes("git") ||
      s.includes("readme") ||
      s.includes("package.json") ||
      s.includes("xem repo") ||
      s.includes("chạy lệnh")
    )
      continue;

    counter[key] = (counter[key] || 0) + 1;
  }

  const topProblems = Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const problemText = topProblems.length
    ? topProblems.map(([k, v]) => `${v}x - ${k}`).join("\n")
    : "Chưa có pattern rõ";

  let lessons = [];
  try {
    const l = await query(`
      select title, summary
      from gbrain_memories
      where created_at >= now() - interval '7 days'
        and title not ilike '%test%'
        and title not ilike '%tên người dùng%'
        and title not ilike '%mason%'
        and title not ilike '%demo%'
        and summary not ilike '%test%'
        and summary not ilike '%tên người dùng%'
        and summary not ilike '%mason%'
        and summary not ilike '%demo%'
      order by created_at desc
      limit 5
    `);
    lessons = l.rows || [];
  } catch {}

  const lessonText = lessons.length
    ? lessons.map((l) => `- ${l.title}`).join("\n")
    : "Chưa có lesson mới";

  let patterns = [];
  if (topProblems.length > 0) {
    const [k, v] = topProblems[0];
    if (v >= 3) {
      patterns.push(`Lặp lại nhiều lần: ${k} (${v} lần)`);
    }
  }
  if (patterns.length === 0) {
    patterns.push("Chưa thấy pattern xấu rõ ràng");
  }

  let actions = [];
  if (topProblems.length > 0) {
    const [k] = topProblems[0];

    if (k === "payment") {
      actions.push("🔥 Fix dứt điểm flow payment/payOS (QR, polling, webhook)");
      actions.push("👉 Dùng: /audit lỗi payment → /codex fix → /review");
    }
    if (k === "booking") {
      actions.push("📅 Rà soát booking conflict + pricing logic");
    }
    if (k === "admin") {
      actions.push("🛠 Audit admin flows + permissions (RBAC)");
    }
    if (k === "cleaner") {
      actions.push("🧹 Kiểm tra cleaner bot + task assignment + photo review");
    }
  }

  if (actions.length === 0) {
    actions.push("✅ Hệ ổn → tiếp tục /codex để build feature");
  }

  return `📊 Hermes Weekly Report

🔥 Top Problems (7d):
${problemText}

🧠 Lessons (7d):
${lessonText}

📉 Pattern:
${patterns.join("\n")}

🚀 Đề xuất:
${actions.join("\n")}

NEXT ACTION:
- Deep debug → /audit <vấn đề>
- Fix → /codex <task>
- Review → /review <kết quả>`;
}


const CASUAL_TELEGRAM_INPUTS = new Set([
  "hi",
  "hello",
  "hey",
  "chào",
  "chao",
  "xin chào",
  "xin chao",
  "alo",
  "test",
  "ping",
  "ok",
]);

const TASK_LIKE_TELEGRAM_PATTERNS = [
  /^(git|gh|npm|pnpm|yarn|node|docker|kubectl)\b/i,
  /^(kiểm tra|kiem tra|check|xem|chạy|chay|run)\b.*\b(health|status|test|build|deploy|log|logs)\b/i,
  /^(tạo|tao|create|mở|mo|open)\b.*\b(issue|ticket|task|bug|pr|pull request)\b/i,
  /\b(health check|repo status|branch status|run build|run test)\b/i,
];

function normalizeTelegramIntentText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.。！？]+$/g, "")
    .replace(/\s+/g, " ");
}

function isCasualTelegramInput(text) {
  return CASUAL_TELEGRAM_INPUTS.has(normalizeTelegramIntentText(text));
}

function isTaskLikeTelegramInput(text) {
  const normalizedIntentText = normalizeTelegramIntentText(text);
  return isExternalCliTask(normalizedIntentText) || TASK_LIKE_TELEGRAM_PATTERNS.some((pattern) => pattern.test(normalizedIntentText));
}

function buildCasualTelegramReply() {
  return [
    "👋 Chào bạn! Hermes đang sẵn sàng hỗ trợ.",
    "",
    "Mình có thể giúp:",
    "- Kiểm tra repo/health: git status, kiểm tra health",
    "- Chạy build/test có duyệt an toàn: npm run build",
    "- Tạo issue hoặc chuẩn bị prompt Codex: /code <task>, /codex <task>",
    "- Audit/review/recall memory: /audit, /review, /recall",
    "",
    "Gõ /commands hoặc /menu để xem thêm lệnh.",
  ].join("\n");
}

function buildUnknownTelegramReply(text) {
  return [
    `Mình chưa rõ bạn muốn Hermes làm gì với: "${String(text || "").slice(0, 120)}"`,
    "",
    "Bạn muốn mình kiểm tra, build/test, tạo issue, audit, hay chỉ chat?",
    "Ví dụ: git status, npm run build, kiểm tra health, tạo issue <nội dung>.",
  ].join("\n");
}




function extractLessonCandidateText(event) {
  const payload = event?.payload || event?.metadata || {};
  return payload.lesson_candidate || payload.lesson || event?.message || "";
}

function summarizeSkillEvents(events) {
  const summary = { selectedSkills: [], missingEnv: [], missingTools: [] };
  for (const event of events || []) {
    const data = event.payload || event.metadata || {};
    if (Array.isArray(data.selected_skills)) {
      summary.selectedSkills = data.selected_skills.map((skill) => skill.name || skill).filter(Boolean);
    }
    if (Array.isArray(data.selected_skill_names)) summary.selectedSkills = data.selected_skill_names.filter(Boolean);
    if (Array.isArray(data.missing_env)) summary.missingEnv = data.missing_env.filter(Boolean);
    if (Array.isArray(data.missing_tools)) summary.missingTools = data.missing_tools.filter(Boolean);
  }
  return summary;
}

async function getSkillLessonReview(taskId, options = {}) {
  const queryFn = options.queryFn || query;
  const taskRes = await queryFn(
    `select id,status,input_text from hermes_tasks where id=$1 limit 1`,
    [taskId],
  );
  const task = taskRes.rows[0];
  if (!task) return { task: null, candidate: null, events: [] };
  let eventsRes;
  try {
    eventsRes = await queryFn(
      `select event_type,message,payload,metadata,created_at
       from hermes_task_events
       where task_id=$1
       order by sequence_id desc nulls last, created_at desc, id desc
       limit 100`,
      [taskId],
    );
  } catch {
    eventsRes = await queryFn(
      `select event_type,message,payload,metadata,created_at
       from hermes_task_events
       where task_id=$1
       order by created_at desc, id desc
       limit 100`,
      [taskId],
    );
  }
  const events = eventsRes.rows || [];
  const candidate = events.find((event) => event.event_type === 'skill_lesson_candidate') || null;
  return { task, candidate, events };
}

async function buildSkillLearnReviewMessage(taskId, options = {}) {
  const { task, candidate, events } = await getSkillLessonReview(taskId, options);
  if (!task) return `Không tìm thấy task #${taskId}.`;
  if (!candidate) return `No skill_lesson_candidate found for task #${taskId}. Use /events ${taskId} to inspect task history.`;
  const eventSummary = summarizeSkillEvents(events);
  const lesson = truncateForTelegram(extractLessonCandidateText(candidate), 900);
  return [
    `Skill lesson review for task #${task.id}`,
    `- Status: ${task.status}`,
    `- Input: ${truncateForTelegram(task.input_text, 500)}`,
    `- Selected skills: ${eventSummary.selectedSkills.length ? eventSummary.selectedSkills.join(', ') : '-'}`,
    `- Missing env: ${eventSummary.missingEnv.length ? eventSummary.missingEnv.join(', ') : '-'}`,
    `- Missing tools: ${eventSummary.missingTools.length ? eventSummary.missingTools.join(', ') : '-'}`,
    `Potential lesson to save: ${lesson}`,
    `Next step: /skills save-memory ${task.id} or /skills append-skill ${task.id} <skill-name>`,
  ].join("\n");
}

async function saveSkillLessonToMemory(taskId, options = {}) {
  const queryFn = options.queryFn || query;
  const { task, candidate } = await getSkillLessonReview(taskId, { queryFn });
  if (!task) return { ok: false, message: `Không tìm thấy task #${taskId}.` };
  if (!candidate) return { ok: false, message: `No skill_lesson_candidate found for task #${taskId}. Nothing saved.` };
  const lesson = redactSensitiveText(extractLessonCandidateText(candidate));
  if (!lesson.trim()) return { ok: false, message: `Skill lesson candidate for task #${taskId} is empty. Nothing saved.` };
  const memoryKey = `skill_lesson:task:${task.id}`;
  const memoryRes = await queryFn(
    `insert into hermes_memories (memory_key,memory_text,source,trust_score,memory_type,importance,confidence,last_used_at)
     values ($1,$2,$3,$4,$5,$6,$7,now())
     returning id,memory_key,memory_text,memory_type`,
    [memoryKey, lesson, 'skill_layer_v3_reviewed', 0.7, 'ops_sop', 3, 0.7],
  );
  await queryFn(
    `insert into hermes_task_events (task_id,event_type,message,payload)
     values ($1,$2,$3,$4::jsonb)`,
    [task.id, 'skill_lesson_saved_to_memory', 'Reviewed skill lesson saved to hermes_memories', JSON.stringify({ memory_key: memoryKey, memory_id: memoryRes.rows[0]?.id || null })],
  );
  return { ok: true, memory: memoryRes.rows[0] || { memory_key: memoryKey, memory_text: lesson, memory_type: 'ops_sop' } };
}

async function buildSkillSaveMemoryMessage(taskId, options = {}) {
  const saved = await saveSkillLessonToMemory(taskId, options);
  if (!saved.ok) return saved.message;
  return [
    `Skill lesson saved to memory ✅`,
    `- Task: #${taskId}`,
    `- Memory: ${saved.memory.id || saved.memory.memory_key || '-'}`,
    `- Type: ${saved.memory.memory_type || 'ops_sop'}`,
    `- Text: ${truncateForTelegram(saved.memory.memory_text, 500)}`,
  ].join("\n");
}

async function buildSkillsCommandReply(text, options = {}) {
  const input = String(text || "").trim();
  if (/^\/skills(?:@\w+)?\s+list$/i.test(input) || /^\/skills(?:@\w+)?$/i.test(input)) {
    return `Curated Hermes Skill Pack v2\n\n${formatSkillsList()}\n\nRouting: classify intent → match top 1-3 skills → check env/tools → load selected SKILL.md only → plan → require approval for risky/prod actions → execute → verify → save lessons.`;
  }

  const showMatch = input.match(/^\/skills(?:@\w+)?\s+show\s+([\s\S]+)$/i);
  if (showMatch) return formatSkillShow(showMatch[1].trim());

  const whyMatch = input.match(/^\/skills(?:@\w+)?\s+why\s+([\s\S]+)$/i);
  if (whyMatch) {
    const queryText = whyMatch[1].trim();
    if (!queryText) return "Dùng: /skills why <task>";
    const routed = classifyTelegramSkillIntent(queryText);
    if (routed.intent === "small_talk") return "Small-talk detected: no heavy task flow and no SKILL.md loaded.";
    return formatSkillWhy(queryText, { limit: 3 });
  }

  if (/^\/skills(?:@\w+)?\s+doctor$/i.test(input)) return formatSkillDoctor();

  const learnMatch = input.match(/^\/skills(?:@\w+)?\s+learn(?:\s+(\d+))?$/i);
  if (learnMatch) {
    const taskId = Number(learnMatch[1]);
    if (!Number.isInteger(taskId) || taskId <= 0) return "Dùng: /skills learn <task_id>";
    return buildSkillLearnReviewMessage(taskId, options);
  }

  const saveMemoryMatch = input.match(/^\/skills(?:@\w+)?\s+save-memory(?:\s+(\d+))?$/i);
  if (saveMemoryMatch) {
    const taskId = Number(saveMemoryMatch[1]);
    if (!Number.isInteger(taskId) || taskId <= 0) return "Dùng: /skills save-memory <task_id>";
    return buildSkillSaveMemoryMessage(taskId, options);
  }

  const match = input.match(/^\/skills(?:@\w+)?\s+match\s+([\s\S]+)$/i);
  if (!match) return "Dùng: /skills list | show <name> | why <task> | match <task> | doctor | learn <task_id> | save-memory <task_id>";

  const queryText = match[1].trim();
  if (!queryText) return "Dùng: /skills match <task>";
  const routed = classifyTelegramSkillIntent(queryText);
  if (routed.intent === "small_talk") {
    return "Small-talk detected: no heavy task flow and no SKILL.md loaded.";
  }
  return formatSkillMatches(queryText, { limit: 3 });
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/?#]+:[^\s@/?#]+@/g, (match) => match.replace(/:\/\/[^\s:/?#]+:[^\s@/?#]+@/, "://[REDACTED]@"))
    .replace(/\b(?:DATABASE_URL|database_url)\s*[:=]\s*[^\s,;]+/gi, "DATABASE_URL=[REDACTED]")
    .replace(/\b(?:sk|pk|ghp|gho|glpat|xoxb|xoxp)-[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(token|apikey|api_key|authorization|password|bearer|secret|client_secret|access_key)\s*[:=]?\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgres://[REDACTED]@");
}

function truncateForTelegram(value, max = 500) {
  const text = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatAge(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (!total) return "-";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes || 1}m`;
}

function parsePositiveIntegerArg(text, command) {
  const raw = String(text || "").trim().split(/\s+/)[1];
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: `Dùng: ${command} <id_số_nguyên_dương>` };
  }
  return { id };
}

function parseCommandIdAndReason(text, command) {
  const match = String(text || "").trim().match(/^\/[a-z_-]+(?:@[\w_]+)?\s+(\d+)(?:\s+([\s\S]+))?$/i);
  const id = Number(match?.[1]);
  if (!Number.isInteger(id) || id <= 0) {
    return { error: `Dùng: ${command} <id_số_nguyên_dương>${command === "/retry" ? "" : " <reason optional>"}` };
  }
  return { id, reason: truncateForTelegram(match?.[2] || "", 240) };
}

function formatIso(value) {
  return value ? new Date(value).toISOString() : "-";
}

function formatTimeRemaining(value) {
  if (!value) return "-";
  const seconds = Math.floor((new Date(value).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  return formatAge(seconds);
}

function approvalPayloadSummary(payload) {
  const p = payload || {};
  const risk = p.risk_level || p.riskLevel || "-";
  const actions = Array.isArray(p.action_list)
    ? p.action_list
    : Array.isArray(p.actions)
      ? p.actions
      : Array.isArray(p.execution_plan)
        ? p.execution_plan
        : [];
  return {
    risk,
    actions: actions.map((a) => truncateForTelegram(typeof a === "string" ? a : JSON.stringify(a), 60)).slice(0, 4).join(", ") || "-",
  };
}

async function buildTelegramStatusMessage() {
  const health = await getSystemHealth();
  const latest = health.latest_task;
  const latestLine = latest
    ? `#${latest.id} ${latest.status} — ${truncateForTelegram(latest.input_text, 80)}`
    : "-";
  const workerAge = health.worker.last_heartbeat_at
    ? formatAge(Math.floor((Date.now() - new Date(health.worker.last_heartbeat_at).getTime()) / 1000))
    : "-";
  const warnings = (health.warnings || []).slice(0, 2).map((w) => `- Warning: ${truncateForTelegram(w, 120)}`);

  return [
    "Hermes Status",
    `- App: ${health.app?.ok ? "OK" : "WARN"}`,
    `- DB: ${health.db?.ok ? "OK" : "DOWN"}`,
    `- Worker: ${health.worker?.alive ? "OK" : "UNKNOWN"}${workerAge !== "-" ? ` (heartbeat ${workerAge} ago)` : ""}`,
    `- Env: ${health.app_env || "development"} / ${health.env || "dev"}`,
    `- Project: ${truncateForTelegram(health.projectRoot || "-", 120)}`,
    `- Pending: ${health.queue.pending}`,
    `- Planned: ${health.queue.planned}`,
    `- Pending approval: ${health.queue.pending_approval}`,
    `- Approved: ${health.queue.approved}`,
    `- Running: ${health.queue.running}`,
    `- Completed 24h: ${health.queue.completed_24h}`,
    `- Failed 24h: ${health.queue.failed_24h}`,
    `- Oldest pending: ${formatAge(health.queue.oldest_pending_seconds)}`,
    `- Oldest approval: ${formatAge(health.queue.oldest_pending_approval_seconds)}`,
    `- Latest task: ${latestLine}`,
    ...warnings,
  ].join("\n");
}

async function buildPendingApprovalsMessage() {
  const res = await query(
    `select id,status,input_text,intent,created_at,approval_expires_at,approval_snapshot_payload
     from hermes_tasks
     where status=$1
     order by created_at asc
     limit $2`,
    ["pending_approval", 12],
  );
  if (!res.rows.length) return "No pending approvals.";

  const rows = res.rows.map((t) => {
    const payload = approvalPayloadSummary(t.approval_snapshot_payload || {});
    const ageSeconds = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 1000);
    return [
      `#${t.id} ${t.status} — ${truncateForTelegram(t.input_text, 90)}`,
      `Risk: ${payload.risk} | Age: ${formatAge(ageSeconds)} | Expires: ${formatIso(t.approval_expires_at)} (${formatTimeRemaining(t.approval_expires_at)})`,
      `Actions: ${payload.actions}`,
    ].join("\n");
  });

  return ["Pending approvals:", ...rows].join("\n\n");
}

async function buildQueueMessage() {
  let health;
  const warnings = [];
  try {
    health = await getSystemHealth();
  } catch (err) {
    health = { queue: {}, worker: {}, latest_task: null, warnings: [] };
    warnings.push(`health partial: ${truncateForTelegram(err.message, 120)}`);
  }
  const queue = health.queue || {};
  const latest = health.latest_task
    ? `#${health.latest_task.id} ${health.latest_task.status} — ${truncateForTelegram(health.latest_task.input_text, 80)}`
    : "-";
  const workerAge = health.worker?.last_heartbeat_at
    ? formatAge(Math.floor((Date.now() - new Date(health.worker.last_heartbeat_at).getTime()) / 1000))
    : "-";
  const healthWarnings = [...warnings, ...(health.warnings || [])].slice(0, 3);

  return [
    "Queue summary",
    `- pending: ${queue.pending || 0}`,
    `- planned: ${queue.planned || 0}`,
    `- pending_approval: ${queue.pending_approval || 0}`,
    `- approved: ${queue.approved || 0}`,
    `- running: ${queue.running || 0}`,
    `- completed 24h: ${queue.completed_24h || 0}`,
    `- failed 24h: ${queue.failed_24h || 0}`,
    `- oldest pending: ${formatAge(queue.oldest_pending_seconds)}`,
    `- oldest approval: ${formatAge(queue.oldest_pending_approval_seconds)}`,
    `- latest: ${latest}`,
    `- worker: ${health.worker?.alive ? "alive" : "unknown"}${workerAge !== "-" ? ` (${workerAge} ago)` : ""}`,
    ...healthWarnings.map((w) => `- warning: ${truncateForTelegram(w, 140)}`),
  ].join("\n");
}


function taskAgeSeconds(task, nowMs = Date.now()) {
  return Math.floor((nowMs - new Date(task.created_at).getTime()) / 1000);
}

function isTaskStale(task, nowMs = Date.now()) {
  const ageSeconds = taskAgeSeconds(task, nowMs);
  if (task.status === 'pending') return ageSeconds > 24 * 3600;
  if (task.status === 'approved') return ageSeconds > 24 * 3600;
  if (task.status === 'running') return ageSeconds > 30 * 60;
  if (task.status === 'pending_approval') {
    if (task.approval_expires_at && new Date(task.approval_expires_at).getTime() < nowMs) return true;
    return ageSeconds > 24 * 3600;
  }
  return false;
}

function formatStaleTaskRow(task, nowMs = Date.now()) {
  const ageSeconds = Number.isFinite(Number(task.age_seconds)) ? Number(task.age_seconds) : taskAgeSeconds(task, nowMs);
  return `#${task.id} ${task.status} age=${formatAge(ageSeconds)} — ${truncateForTelegram(task.input_text, 90)} | created=${formatIso(task.created_at)}${task.approval_expires_at ? ` | approval_expires=${formatIso(task.approval_expires_at)}` : ''}`;
}

async function fetchStaleTasks(options = {}) {
  const queryFn = options.queryFn || query;
  const res = await queryFn(
    `select id,status,input_text,created_at,approval_expires_at,
            extract(epoch from (now() - created_at))::int as age_seconds
     from hermes_tasks
     where (status='pending' and created_at < now() - interval '24 hours')
        or (status='approved' and created_at < now() - interval '24 hours')
        or (status='running' and created_at < now() - interval '30 minutes')
        or (status='pending_approval' and (approval_expires_at < now() or (approval_expires_at is null and created_at < now() - interval '24 hours')))
     order by created_at asc
     limit $1`,
    [options.limit || 25],
  );
  return res.rows || [];
}

async function buildTasksStaleMessage(options = {}) {
  const rows = await fetchStaleTasks(options);
  if (!rows.length) return 'No stale pending/pending_approval/approved/running tasks found.';
  return ['Stale tasks (read-only):', ...rows.map((task) => `- ${formatStaleTaskRow(task, options.nowMs)}`)].join('\n');
}

async function expireStaleTasks(options = {}) {
  if (!options.operatorAuthorized) {
    return { ok: false, message: 'Operator authorization required for /tasks expire-stale.' };
  }
  const queryFn = options.queryFn || query;
  const stale = await fetchStaleTasks({ ...options, queryFn, limit: options.limit || 100 });
  const eligible = stale.filter((task) => task.status === 'pending_approval');
  const expired = [];
  const skipped = stale.filter((task) => task.status !== 'pending_approval').map((task) => ({ id: task.id, status: task.status, reason: 'not_expired_in_v3_fsm_guard' }));
  for (const task of eligible) {
    const updated = await queryFn(
      `update hermes_tasks
       set status='failed', error_text=$2, updated_at=now()
       where id=$1 and status='pending_approval'
       returning id,status`,
      [task.id, 'Expired by operator stale-task cleanup'],
    );
    if ((updated.rowCount || 0) !== 1) continue;
    expired.push(task.id);
    await queryFn(
      `insert into hermes_task_events (task_id,event_type,message,payload)
       values ($1,$2,$3,$4::jsonb)`,
      [task.id, 'stale_task_expired', 'Expired by operator stale-task cleanup', JSON.stringify({ previous_status: task.status, new_status: 'failed' })],
    );
    await queryFn(
      `insert into hermes_task_events (task_id,event_type,message,payload)
       values ($1,$2,$3,$4::jsonb)`,
      [task.id, 'status_transition', 'pending_approval -> failed', JSON.stringify({ reason: 'Expired by operator stale-task cleanup' })],
    );
  }
  return { ok: true, expired, skipped };
}

async function buildTasksExpireStaleMessage(options = {}) {
  const result = await expireStaleTasks(options);
  if (!result.ok) return result.message;
  const lines = [
    `Expired stale tasks: ${result.expired.length}`,
    `- ids: ${result.expired.length ? result.expired.join(', ') : '-'}`,
  ];
  if (result.skipped.length) {
    lines.push(`- skipped by v3 FSM guard: ${result.skipped.map((s) => `#${s.id} ${s.status}`).join(', ')}`);
  }
  return lines.join('\n');
}

async function buildTasksSummaryMessage(options = {}) {
  const queryFn = options.queryFn || query;
  const summary = await queryFn(
    `select
       coalesce(sum(case when status='pending' then 1 else 0 end),0)::int as pending,
       coalesce(sum(case when status='pending_approval' then 1 else 0 end),0)::int as pending_approval,
       coalesce(sum(case when status='approved' then 1 else 0 end),0)::int as approved,
       coalesce(sum(case when status='running' then 1 else 0 end),0)::int as running,
       coalesce(sum(case when status='completed' and updated_at > now() - interval '24 hours' then 1 else 0 end),0)::int as completed_24h,
       coalesce(sum(case when status='failed' and updated_at > now() - interval '24 hours' then 1 else 0 end),0)::int as failed_24h,
       coalesce(extract(epoch from (now() - min(case when status='pending' then created_at end)))::int,0) as oldest_pending_age_seconds,
       coalesce(sum(case when status='pending' and created_at < now() - interval '24 hours' then 1 else 0 end),0)::int as stale_pending,
       coalesce(sum(case when status='pending_approval' and (approval_expires_at < now() or (approval_expires_at is null and created_at < now() - interval '24 hours')) then 1 else 0 end),0)::int as stale_pending_approval,
       coalesce(sum(case when status='approved' and created_at < now() - interval '24 hours' then 1 else 0 end),0)::int as stale_approved,
       coalesce(sum(case when status='running' and created_at < now() - interval '30 minutes' then 1 else 0 end),0)::int as stale_running
     from hermes_tasks`,
  );
  const row = summary.rows[0] || {};
  return [
    'Tasks summary',
    `- pending: ${row.pending || 0}`,
    `- pending_approval: ${row.pending_approval || 0}`,
    `- approved: ${row.approved || 0}`,
    `- running: ${row.running || 0}`,
    `- completed_24h: ${row.completed_24h || 0}`,
    `- failed_24h: ${row.failed_24h || 0}`,
    `- oldest pending age: ${formatAge(row.oldest_pending_age_seconds)}`,
    `- stale pending: ${row.stale_pending || 0}`,
    `- stale pending_approval: ${row.stale_pending_approval || 0}`,
    `- stale approved: ${row.stale_approved || 0}`,
    `- stale running: ${row.stale_running || 0}`,
  ].join('\n');
}

async function buildTasksCommandReply(text, options = {}) {
  const input = String(text || '').trim();
  if (/^\/tasks(?:@\w+)?\s+stale$/i.test(input)) return buildTasksStaleMessage(options);
  if (/^\/tasks(?:@\w+)?\s+summary$/i.test(input)) return buildTasksSummaryMessage(options);
  if (/^\/tasks(?:@\w+)?\s+expire-stale$/i.test(input)) {
    const operatorAuthorized = Object.prototype.hasOwnProperty.call(options, 'operatorAuthorized')
      ? options.operatorAuthorized
      : isAllowed(options.userId);
    return buildTasksExpireStaleMessage({ ...options, operatorAuthorized });
  }
  return 'Dùng: /tasks stale | /tasks summary | /tasks expire-stale';
}

async function buildTelegramTaskMessage(text) {
  const parsed = parsePositiveIntegerArg(text, "/task");
  if (parsed.error) return parsed.error;
  const id = parsed.id;
  const tRes = await query(
    `select id,status,intent,input_text,created_at,updated_at,approval_expires_at,approved_by,approved_at,result_text,error_text,result_summary
     from hermes_tasks
     where id=$1
     limit 1`,
    [id],
  );
  const t = tRes.rows[0];
  if (!t) return `Không tìm thấy task #${id}.`;
  const result = t.result_text || (t.result_summary ? JSON.stringify(t.result_summary) : "");
  return [
    `Task #${t.id}`,
    `- Status: ${t.status}`,
    `- Intent: ${t.intent || "-"}`,
    `- Input: ${truncateForTelegram(t.input_text, 500)}`,
    `- Created: ${t.created_at ? new Date(t.created_at).toISOString() : "-"}`,
    `- Updated: ${t.updated_at ? new Date(t.updated_at).toISOString() : "-"}`,
    `- Approval expires: ${t.approval_expires_at ? new Date(t.approval_expires_at).toISOString() : "-"}`,
    `- Approved by: ${t.approved_by || "-"}`,
    `- Approved at: ${t.approved_at ? new Date(t.approved_at).toISOString() : "-"}`,
    result ? `- Result: ${truncateForTelegram(result, 700)}` : null,
    t.error_text ? `- Error: ${truncateForTelegram(t.error_text, 700)}` : null,
  ].filter(Boolean).join("\n");
}

async function buildTelegramEventsMessage(text) {
  const parsed = parsePositiveIntegerArg(text, "/events");
  if (parsed.error) return parsed.error;
  const id = parsed.id;
  const taskExists = await query(`select id from hermes_tasks where id=$1 limit 1`, [id]);
  if (!taskExists.rows[0]) return `Không tìm thấy task #${id}.`;
  let ev;
  try {
    ev = await query(
      `select id,event_type,message,payload,metadata,created_at
       from hermes_task_events
       where task_id=$1
       order by sequence_id desc nulls last, created_at desc, id desc
       limit 12`,
      [id],
    );
  } catch {
    ev = await query(
      `select id,event_type,message,payload,metadata,created_at
       from hermes_task_events
       where task_id=$1
       order by created_at desc, id desc
       limit 12`,
      [id],
    );
  }
  if (!ev.rows.length) return `Task #${id} chưa có event.`;
  const rows = ev.rows.reverse().map((e) => {
    const detail = e.message || JSON.stringify(e.metadata || e.payload || {});
    return `- ${new Date(e.created_at).toISOString()} — ${e.event_type}: ${truncateForTelegram(detail, 180)}`;
  });
  return [`Events for task #${id}`, ...rows].join("\n");
}

async function buildRememberMessage(text) {
  const memoryText = String(text || "").replace(/^\/remember\b/i, "").trim();
  if (!memoryText) return "Dùng: /remember <thing Hermes should remember>";
  const memory = await rememberOperatorMemory(memoryText, "telegram_operator");
  return [
    "Memory stored ✅",
    `- ID: ${memory.id || "-"}`,
    `- Type: ${memory.memory_type || "project_context"}`,
    `- Summary: ${truncateForTelegram(memory.memory_text, 240)}`,
    "- Retrieval: use /recall <keyword>",
  ].join("\n");
}

async function buildRecallMessage(text) {
  const keyword = String(text || "").replace(/^\/recall\b/i, "").trim();
  if (!keyword) return "Dùng: /recall <keyword>";
  const memories = await recallOperatorMemories(keyword, 5);
  if (!memories.length) return "No matching memory found.";
  return [
    `Memory recall for: ${truncateForTelegram(keyword, 80)}`,
    ...memories.map((m) => `- #${m.id} [${m.memory_type || "memory"}] ${truncateForTelegram(m.memory_text, 260)}`),
  ].join("\n");
}

async function buildMemoryStatsMessage() {
  const stats = await getOperatorMemoryStats();
  const byType = stats.by_type.length
    ? stats.by_type.map((r) => `- ${r.memory_type}: ${r.count}`).join("\n")
    : "- none: 0";
  return [
    "Memory Stats",
    `- Total: ${stats.total}`,
    `- Latest: ${stats.latest_memory_at ? new Date(stats.latest_memory_at).toISOString() : "-"}`,
    byType,
  ].join("\n");
}

function isAllowed(userId) {
  return ALLOWED_USER_IDS.includes(Number(userId));
}


async function logSkillUsageForTask(taskId, text, options = {}) {
  const events = buildSkillUsageEvents(text, {
    env: options.env || process.env,
    rootDir: options.rootDir || process.cwd(),
    limit: 3,
  });
  const queryFn = options.queryFn || query;
  for (const event of events) {
    await queryFn(
      `insert into hermes_task_events (task_id, event_type, message, payload, metadata)
       values ($1, $2, $3, $4::jsonb, $4::jsonb)`,
      [taskId, event.event_type, event.message, JSON.stringify(event.metadata || {})]
    );
  }
}

async function createTask(chatId, userId, text, options = {}) {
  const normalized = normalizeInputText(text);
  const dedupeSalt = options.idempotencySalt ? `:${options.idempotencySalt}` : "";
  const dedupeKey = nodeCrypto
    .createHash("sha256")
    .update(`${userId}:${normalized}${dedupeSalt}`)
    .digest("hex");
  const externalCliApproval = buildExternalCliApprovalPlan(text);
  if (externalCliApproval && !externalCliApproval.ok) {
    const unsafeText = externalCliApproval.unsafe_commands.length
      ? ` Unsafe command(s): ${externalCliApproval.unsafe_commands.join(", ")}`
      : "";
    throw new Error(`external_cli_command_rejected: ${externalCliApproval.error}.${unsafeText}`);
  }
  const approvalIntent = externalCliApproval?.ok ? "external_cli" : "execute";
  const approvalSnapshot = canonicalizeApprovalSnapshot({
    taskId: "",
    payload: externalCliApproval?.ok
      ? {
          intent: "external_cli",
          normalized_input: normalized,
          tool: externalCliApproval.tool,
          tool_label: externalCliApproval.tool_label,
          execution_plan: externalCliApproval.plan,
          risk_level: "medium",
          action_list: externalCliApproval.commands,
          memory_ids_used: [],
        }
      : {
          intent: "execute",
          normalized_input: normalized,
          execution_plan: ["parse_intent", "run_gates", "execute_plan"],
          risk_level: "medium",
          action_list: ["git status", "npm test", "npm run build"],
          memory_ids_used: [],
        },
    inputText: text,
    intent: approvalIntent,
    appEnv: process.env.APP_ENV || "development",
  });

  const result = await query(
    `insert into hermes_tasks (telegram_chat_id, telegram_user_id, input_text, intent, status, idempotency_key)
     values ($1, $2, $3, $4, 'planned', $5)
     on conflict (idempotency_key) do update set updated_at=now()
     returning id`,
    [chatId, userId, text, approvalIntent, dedupeKey]
  );

  const taskId = result.rows[0].id;
  const canonicalApprovalSnapshot = canonicalizeApprovalSnapshot({
    taskId,
    payload: approvalSnapshot,
    inputText: text,
    intent: approvalIntent,
    appEnv: process.env.APP_ENV || "development",
  });
  const approvalSnapshotHash = hashApprovalSnapshot(canonicalApprovalSnapshot);

  await query(
    `insert into hermes_task_events (task_id, event_type, message)
     values ($1, 'created', $2)`,
    [taskId, "Task created from Telegram"]
  );
  await logSkillUsageForTask(taskId, text);
  await query(
    `insert into hermes_task_events (task_id, event_type, message)
     values ($1, 'planned', $2)`,
    [taskId, "Task moved to planned"]
  );
  const plannedToPending = await query(
    `update hermes_tasks
     set status='pending_approval',
         approval_snapshot_hash=$2,
         approval_snapshot_payload=$3::jsonb,
         approval_expires_at=now()+interval '15 minutes',
         updated_at=now()
     where id=$1 and status='planned'`,
    [taskId, approvalSnapshotHash, JSON.stringify(canonicalApprovalSnapshot)],
  );
  if ((plannedToPending.rowCount || 0) === 1) {
    await query(
    `insert into hermes_task_events (task_id, event_type, message)
     values ($1, 'pending_approval', $2)`,
    [taskId, "Task requires explicit approval before running"]
    );
    const actionItems = Array.isArray(approvalSnapshot.action_list) ? approvalSnapshot.action_list : [];
    const actionList = actionItems.length ? `\n- ${actionItems.join("\n- ")}` : " -";
    const shortHash = approvalSnapshotHash ? approvalSnapshotHash.slice(0, 12) : "-";
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const approvalMessage = [
      `🛂 Task #${taskId} cần duyệt`,
      `Intent: ${approvalSnapshot.intent || "-"}`,
      `Input: ${String(text || "").slice(0, 500) || "-"}`,
      `Risk: ${approvalSnapshot.risk_level || "-"}`,
      `Expires: ${expiresAt}`,
      `Snapshot: ${shortHash}`,
      `Actions:${actionList || " -"}`,
    ].join("\n");
    try {
      await sendTelegramMessage(chatId, approvalMessage, {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Duyệt", callback_data: `approve_${taskId}` },
            { text: "❌ Từ chối", callback_data: `reject_${taskId}` },
          ]],
        },
      });
      await query(
        `insert into hermes_task_events (task_id, event_type, message)
         values ($1, 'operator_notified', $2)`,
        [taskId, "Approval request sent to operator"],
      );
    } catch (e) {
      console.warn("[approval notify] failed", e.message);
      await query(
        `insert into hermes_task_events (task_id, event_type, message, payload)
         values ($1, 'operator_notification_failed', $2, $3)`,
        [taskId, "Failed to send approval request", { error: String(e.message || "").slice(0, 200) }],
      );
    }
  }

  return taskId;
}

async function shouldRateLimitApproval(taskId, userId, actionType) {
  const r = await query(
    `select count(*)::int as c
     from hermes_task_events
     where task_id=$1
       and event_type=$2
       and created_at > now() - interval '5 seconds'
       and payload->>'callback_user_id' = $3`,
    [taskId, actionType, String(userId)],
  );
  return (r.rows[0]?.c || 0) > 0;
}

async function handleApprovalDecision({ taskId, actorUserId, chatId, action, reason = "" }) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    await sendTelegramMessage(chatId, "Dùng: /approve <id_số_nguyên_dương> hoặc /reject <id_số_nguyên_dương>");
    return;
  }
  if (!isAllowed(actorUserId)) {
    await sendTelegramMessage(chatId, `❌ Bạn không có quyền ${action === "approve" ? "duyệt" : "từ chối"} task ${taskId}`);
    return;
  }
  const taskCheck = await query(
    `select id,status, input_text, intent, approval_snapshot_hash, approval_snapshot_payload, approval_expires_at
     from hermes_tasks where id=$1 limit 1`,
    [taskId],
  );
  const t = taskCheck.rows[0];
  if (!t) { await sendTelegramMessage(chatId, `⚠️ Task ${taskId} không tồn tại.`); return; }
  if (t.status !== 'pending_approval') { await sendTelegramMessage(chatId, `ℹ️ Task ${taskId} đã được xử lý trước đó.`); return; }
  if (t.approval_expires_at && new Date(t.approval_expires_at).getTime() < Date.now()) {
    await query(`insert into hermes_task_events (task_id, event_type, message, payload) values ($1,'approval_expired',$2,$3)`, [taskId, 'Expired approval rejected', { callback_user_id: actorUserId }]);
    await sendTelegramMessage(chatId, `⛔ Approval cho task ${taskId} đã hết hạn.`);
    return;
  }
  const canonicalPayload = canonicalizeApprovalSnapshot({
    taskId,
    payload: t.approval_snapshot_payload || {},
    inputText: t.input_text,
    intent: t.intent || "execute",
    appEnv: process.env.APP_ENV || "development",
  });
  const expectedHash = hashApprovalSnapshot(canonicalPayload);
  if (expectedHash !== t.approval_snapshot_hash) {
    await query(`insert into hermes_task_events (task_id, event_type, message, payload) values ($1,'approval_snapshot_mismatch',$2,$3)`, [taskId, 'Approval rejected due to snapshot mismatch', { callback_user_id: actorUserId, stored_hash_short: String(t.approval_snapshot_hash || '').slice(0, 12), recomputed_hash_short: String(expectedHash || '').slice(0, 12), stored_task_id_type: typeof (t.approval_snapshot_payload || {}).task_id, canonical_task_id_type: typeof canonicalPayload.task_id }]);
    await sendTelegramMessage(chatId, `⛔ Task ${taskId} đã thay đổi, không thể ${action === "approve" ? "duyệt" : "từ chối"} theo snapshot cũ.`);
    return;
  }

  if (action === "approve") {
    const approved = await query(`update hermes_tasks set status='approved', approved_by=$2, approved_at=now(), updated_at=now() where id=$1 and status='pending_approval'`, [taskId, String(actorUserId)]);
    if ((approved.rowCount || 0) !== 1) { await sendTelegramMessage(chatId, `⚠️ Task ${taskId} không ở trạng thái chờ duyệt.`); return; }
    await query(`insert into hermes_task_events (task_id, event_type, message) values ($1, 'approved', $2)`, [taskId, "Task approved from Telegram"]);
    await sendTelegramMessage(chatId, [`✅ Approved task #${taskId}`, `Input: ${truncateForTelegram(t.input_text, 140)}`, "Next: worker will pick it up."].join("\n"));
    return;
  }
  const safeReason = truncateForTelegram(reason || "No reason provided", 240);
  const errorText = `Rejected by telegram_operator: ${safeReason}`;
  const rej = await query(`update hermes_tasks set status='failed', error_text=$2, updated_at=now() where id=$1 and status='pending_approval'`, [taskId, errorText]);
  if ((rej.rowCount || 0) === 1) {
    await query(`insert into hermes_task_events (task_id, event_type, message, payload) values ($1,'rejected',$2,$3)`, [taskId, 'Task rejected from Telegram', { callback_user_id: actorUserId, reason: safeReason }]);
  }
  await sendTelegramMessage(chatId, [`❌ Rejected task #${taskId}`, `Reason: ${safeReason}`, "Final status: failed"].join("\n"));
}

async function handleCancelTask({ taskId, actorUserId, chatId, reason = "" }) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    await sendTelegramMessage(chatId, "Dùng: /cancel <id_số_nguyên_dương> <reason optional>");
    return;
  }
  if (!isAllowed(actorUserId)) {
    await sendTelegramMessage(chatId, `❌ Bạn không có quyền cancel task ${taskId}`);
    return;
  }
  const res = await query(
    `select id,status,input_text from hermes_tasks where id=$1 limit 1`,
    [taskId],
  );
  const task = res.rows[0];
  if (!task) {
    await sendTelegramMessage(chatId, `⚠️ Task ${taskId} không tồn tại.`);
    return;
  }
  if (task.status === "running") {
    await sendTelegramMessage(chatId, "Running task cancellation is not supported safely yet.");
    return;
  }
  if (["completed", "failed"].includes(task.status)) {
    await sendTelegramMessage(chatId, `Task #${taskId} is terminal (${task.status}) and cannot be cancelled.`);
    return;
  }
  if (task.status !== "pending_approval") {
    await sendTelegramMessage(chatId, `Task #${taskId} is ${task.status}; current FSM only supports safe cancel from pending_approval -> failed.`);
    return;
  }

  const safeReason = truncateForTelegram(reason || "No reason provided", 240);
  const errorText = `Cancelled by telegram_operator: ${safeReason}`;
  const upd = await query(
    `update hermes_tasks
     set status='failed', error_text=$2, updated_at=now()
     where id=$1 and status='pending_approval'`,
    [taskId, errorText],
  );
  if ((upd.rowCount || 0) !== 1) {
    await sendTelegramMessage(chatId, `⚠️ Task #${taskId} is no longer pending_approval.`);
    return;
  }
  await query(
    `insert into hermes_task_events (task_id, event_type, message, payload)
     values ($1,'cancelled',$2,$3)`,
    [taskId, 'Task cancelled from Telegram', { actor_user_id: actorUserId, reason: safeReason, final_status: 'failed' }],
  );
  await sendTelegramMessage(chatId, [`🛑 Cancelled task #${taskId}`, `Reason: ${safeReason}`, "Final status: failed"].join("\n"));
}

async function handleRetryTask({ taskId, actorUserId, chatId }) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    await sendTelegramMessage(chatId, "Dùng: /retry <id_số_nguyên_dương>");
    return;
  }
  if (!isAllowed(actorUserId)) {
    await sendTelegramMessage(chatId, `❌ Bạn không có quyền retry task ${taskId}`);
    return;
  }
  const res = await query(
    `select id,status,input_text,telegram_chat_id,telegram_user_id,intent
     from hermes_tasks
     where id=$1
     limit 1`,
    [taskId],
  );
  const original = res.rows[0];
  if (!original) {
    await sendTelegramMessage(chatId, `⚠️ Task ${taskId} không tồn tại.`);
    return;
  }
  if (original.status !== "failed") {
    await sendTelegramMessage(chatId, `Task #${taskId} is ${original.status}; only failed tasks can be retried.`);
    return;
  }

  const existingRetry = await query(
    `select (payload->>'new_task_id')::bigint as new_task_id
     from hermes_task_events
     where task_id=$1 and event_type='retry_created' and payload ? 'new_task_id'
     order by created_at desc, id desc
     limit 1`,
    [taskId],
  );
  const existingId = existingRetry.rows[0]?.new_task_id;
  if (existingId) {
    const existingTask = await query(`select id,status,input_text from hermes_tasks where id=$1 limit 1`, [existingId]);
    if (existingTask.rows[0]) {
      await sendTelegramMessage(chatId, [`Retry already exists for task #${taskId}: #${existingId}`, `Status: ${existingTask.rows[0].status}`, `Input: ${truncateForTelegram(existingTask.rows[0].input_text, 140)}`].join("\n"));
      return;
    }
  }

  const newTaskId = await createTask(original.telegram_chat_id || chatId, original.telegram_user_id || actorUserId, original.input_text, { idempotencySalt: `retry:${taskId}` });
  const newTask = await query(`select id,status,input_text from hermes_tasks where id=$1 limit 1`, [newTaskId]);
  await query(
    `insert into hermes_task_events (task_id, event_type, message, payload)
     values ($1,'retry_created',$2,$3)`,
    [taskId, 'Retry task created from Telegram', { actor_user_id: actorUserId, new_task_id: newTaskId }],
  );
  await query(
    `insert into hermes_task_events (task_id, event_type, message, payload)
     values ($1,'retry_of',$2,$3)`,
    [newTaskId, 'Task created as retry from Telegram', { actor_user_id: actorUserId, original_task_id: taskId }],
  );
  await sendTelegramMessage(chatId, [`🔁 Retried task #${taskId} as #${newTaskId}`, `New status: ${newTask.rows[0]?.status || "unknown"}`, `Input: ${truncateForTelegram(original.input_text, 140)}`].join("\n"));
}

async function createCodeAgentTask(chatId, userId, taskText) {
  const duplicate = await query(
    `select id, issue_url
     from hermes_tasks
     where telegram_user_id = $1
       and intent = 'code_agent_request'
       and input_text = $2
       and issue_url is not null
     order by created_at desc
     limit 1`,
    [userId, taskText]
  );

  if (duplicate.rows[0]) {
    return { duplicate: true, issueUrl: duplicate.rows[0].issue_url };
  }

  const taskResult = await query(
    `insert into hermes_tasks (telegram_chat_id, telegram_user_id, input_text, intent, status)
     values ($1, $2, $3, 'code_agent_request', 'running')
     returning id`,
    [chatId, userId, taskText]
  );

  const taskId = taskResult.rows[0].id;

  await query(
    `insert into hermes_task_events (task_id, event_type, message)
     values ($1, 'code_issue_requested', $2)`,
    [taskId, "Telegram /code request received"]
  );

  try {
    const { issueUrl, issueNumber } = await createGithubIssue(taskText);
    await query(
      `insert into hermes_task_events (task_id, event_type, message, payload)
       values ($1, 'github_issue_created', $2, $3)`,
      [taskId, `Issue #${issueNumber} created`, { issue_url: issueUrl, issue_number: issueNumber }]
    );

    const triggerText = "@codex implement this issue exactly. Create a pull request. Do not modify unrelated files.";
    let codexTriggerOk = false;
    let codexTriggerError = null;
    let codexTriggerCommentUrl = null;

    try {
      const comment = await createIssueComment(taskId, issueNumber, triggerText);
      codexTriggerOk = true;
      codexTriggerCommentUrl = comment.commentUrl;

      await query(
        `insert into hermes_task_events (task_id, event_type, message, payload)
         values ($1, 'codex_triggered', $2, $3)`,
        [taskId, `Codex trigger comment added on issue #${issueNumber}`, { comment_url: comment.commentUrl }]
      );
    } catch (err) {
      codexTriggerError = err.response?.data?.message || err.message;
    }

    await query(
      `update hermes_tasks
       set status = 'completed',
           issue_url = $1,
           issue_number = $2,
           codex_triggered_at = case when $3 then now() else null end,
           codex_trigger_comment_url = $4,
           result_text = $5,
           updated_at = now()
       where id = $6`,
      [issueUrl, issueNumber, codexTriggerOk, codexTriggerCommentUrl, `GitHub issue created: ${issueUrl}`, taskId]
    );

    return { duplicate: false, issueUrl, issueNumber, taskId, codexTriggerOk, codexTriggerError };
  } catch (err) {
    const errorText = err.response?.data ? JSON.stringify(err.response.data) : err.message;

    await query(
      `update hermes_tasks
       set status = 'failed',
           error_text = $1,
           updated_at = now()
       where id = $2`,
      [errorText, taskId]
    );

    await query(
      `insert into hermes_task_events (task_id, event_type, message, payload)
       values ($1, 'code_issue_failed', $2, $3)`,
      [taskId, "GitHub issue creation failed", { error: errorText }]
    );

    throw err;
  }
}

async function checkAndStorePullRequest(taskId) {
  const taskRes = await query(
    `select id, issue_number, pull_request_url, pull_request_number from hermes_tasks where id = $1 limit 1`,
    [taskId]
  );

  const task = taskRes.rows[0];
  if (!task) {
    throw new Error("Task không tồn tại.");
  }

  if (!task.issue_number) {
    throw new Error("Task chưa có GitHub Issue.");
  }

  const linked = await findLinkedPullRequest(task.issue_number);

  if (!linked) {
    await query(
      `insert into hermes_task_events (task_id, event_type, message, payload)
       values ($1, 'pull_request_not_found', $2, $3)`,
      [taskId, `No linked PR found for issue #${task.issue_number}`, { issue_number: task.issue_number }]
    );
    return null;
  }

  await query(
    `update hermes_tasks
     set pull_request_url = $1,
         pull_request_number = $2,
         pull_request_detected_at = now(),
         updated_at = now()
     where id = $3`,
    [linked.pullRequestUrl, linked.pullRequestNumber, taskId]
  );

  await query(
    `insert into hermes_task_events (task_id, event_type, message, payload)
     values ($1, 'pull_request_detected', $2, $3)`,
    [taskId, `Linked PR #${linked.pullRequestNumber} detected`, { pull_request_url: linked.pullRequestUrl, pull_request_number: linked.pullRequestNumber }]
  );

  return linked;
}

app.get("/", (req, res) => {
  res.send("Hermes v5 Lite App Running 🚀");
});

if (require.main === module) {
  ensureGBrainSchema()
    .then(() => console.log("GBrain schema ready 🧠"))
    .catch((err) => console.error("GBrain schema error:", err.message));
}

async function pollTelegram() {
  try {
    const { data } = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: { offset, timeout: 10 },
    });

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      
      const callback = update.callback_query;

if (callback) {
  const data = callback.data;
  const chatId = callback.message.chat.id;
  
    const callbackUserId = callback.from.id;

  if (data === "menu_commands") {
  await sendTelegramMessage(chatId, "Gõ /commands để xem toàn bộ lệnh Hermes.");
  continue;
}

  if (data === "menu_weekly") {
  await sendTelegramMessage(chatId, "Gõ /weekly để xem báo cáo tuần.");
  continue;
}  

  if (data === "menu_status") {
  await sendTelegramMessage(chatId, "Đang kiểm tra trạng thái...");
  // gọi lại chính command /status
  const fakeText = "/status";
  // đơn giản: gửi lại như user
  await sendTelegramMessage(chatId, "Gõ /status để xem chi tiết.");
  continue;
}

  if (data === "menu_queue") {
    try {
      await sendTelegramMessage(chatId, await buildQueueMessage());
    } catch (err) {
      await sendTelegramMessage(chatId, `Lỗi /queue: ${truncateForTelegram(err.message, 200)}`);
    }
    continue;
  }

  if (data === "menu_pending") {
    try {
      await sendTelegramMessage(chatId, await buildPendingApprovalsMessage());
    } catch (err) {
      await sendTelegramMessage(chatId, `Lỗi /pending: ${truncateForTelegram(err.message, 200)}`);
    }
    continue;
  }

  if (data === "menu_deploy_check") {
  await sendTelegramMessage(chatId, "🚀 Nhập nội dung cần deploy-check:");
  console.log("FSM_TRANSITION", { userId: callback.from.id, state: TELEGRAM_STATES.AWAITING_DEPLOY_CHECK });
  await setTelegramSessionState(callback.from.id, TELEGRAM_STATES.AWAITING_DEPLOY_CHECK);
  continue;
}

  if (data === "menu_codex") {
    await sendTelegramMessage(chatId, "🛠 Nhập task cần build prompt Codex:");
    console.log("FSM_TRANSITION", { userId: callbackUserId, state: TELEGRAM_STATES.AWAITING_CODEX });
    await setTelegramSessionState(callbackUserId, TELEGRAM_STATES.AWAITING_CODEX);
    continue;
  }

  if (data === "menu_review") {
    await sendTelegramMessage(chatId, "🔍 Paste kết quả Codex cần review:");
    console.log("FSM_TRANSITION", { userId: callbackUserId, state: TELEGRAM_STATES.AWAITING_REVIEW });
    await setTelegramSessionState(callbackUserId, TELEGRAM_STATES.AWAITING_REVIEW);
    continue;
  }

  if (data === "menu_recall") {
    await sendTelegramMessage(chatId, "🧠 Nhập từ khóa cần recall:");
    console.log("FSM_TRANSITION", { userId: callbackUserId, state: TELEGRAM_STATES.AWAITING_RECALL });
    await setTelegramSessionState(callbackUserId, TELEGRAM_STATES.AWAITING_RECALL);
    continue;
  }

  if (data === "menu_learn") {
    await sendTelegramMessage(chatId, "🧬 Nhập bài học cần lưu:");
    console.log("FSM_TRANSITION", { userId: callbackUserId, state: TELEGRAM_STATES.AWAITING_LEARN });
    await setTelegramSessionState(callbackUserId, TELEGRAM_STATES.AWAITING_LEARN);
    continue;
  }

  if (data === "menu_audit") {
    await sendTelegramMessage(chatId, "🧪 Nhập vấn đề cần audit:");
    console.log("FSM_TRANSITION", { userId: callbackUserId, state: TELEGRAM_STATES.AWAITING_AUDIT });
    await setTelegramSessionState(callbackUserId, TELEGRAM_STATES.AWAITING_AUDIT);
    continue;
  }

   if (data === "menu_daily") {
  await sendTelegramMessage(chatId, "Gõ /daily để xem báo cáo hôm nay.");
  continue;
}  

  if (data === "menu_codex") {
  await sendTelegramMessage(chatId, "🛠 Nhập task cần build prompt Codex:");
  
  console.log("FSM_TRANSITION", { userId: callback.from.id, state: TELEGRAM_STATES.AWAITING_CODEX });
  await setTelegramSessionState(callback.from.id, TELEGRAM_STATES.AWAITING_CODEX);

  continue;
}    

  if (data === "menu_review") {
    await sendTelegramMessage(chatId, "Dùng:\n/review <paste kết quả Codex>");
    continue;
  }

  if (data === "menu_recall") {
    await sendTelegramMessage(chatId, "Dùng:\n/recall <từ khóa>");
    continue;
  }

  if (data === "menu_learn") {
    await sendTelegramMessage(chatId, "Dùng:\n/learn <bài học cần lưu>");
    continue;
  }

  if (data.startsWith("approve_")) {
    const taskId = Number(data.split("_")[1]);
    if (await shouldRateLimitApproval(taskId, callbackUserId, 'approval_rate_limited')) {
      await sendTelegramMessage(chatId, "⏳ Thao tác quá nhanh, vui lòng đợi vài giây.");
      continue;
    }
    await handleApprovalDecision({ taskId, actorUserId: callbackUserId, chatId, action: "approve" });
  }

  if (data.startsWith("reject_")) {
    const taskId = Number(data.split("_")[1]);
    await handleApprovalDecision({ taskId, actorUserId: callbackUserId, chatId, action: "reject" });
  }
  if (data.startsWith("details_")) {
    const taskId = data.split("_")[1];
    const task = await query(`select id,input_text,intent,status from hermes_tasks where id=$1`, [taskId]);
    const t = task.rows[0];
    if (!t) { await sendTelegramMessage(chatId, "Task không tồn tại."); continue; }
    const details = `📋 Task ${t.id}\nStatus: ${t.status}\nIntent: ${t.intent || 'unknown'}\n\nPlan:\n- Parse intent\n- Run gated execution plan\n- Execute allowed commands only\n\nCommands:\n- git status\n- npm test/build (nếu cần)\n\nAffected components:\n- worker.js / dispatcher/* / db\n\nRisk:\n- Có thể fail build/test\n- Có thể tạo side-effect nếu task sai ngữ cảnh\n- Ảnh hưởng queue/task execution pipeline`;
    await sendTelegramMessage(chatId, details);
    continue;
  }

  continue;
} 
       
      const message = update.message;
      if (!message?.text) continue;

      const chatId = message.chat.id;
      const userId = message.from.id;
      const text = message.text.trim();
      const normalized = text.toLowerCase();
      console.log("INCOMING:", { userId, text });

      if (!isAllowed(userId)) {
        await sendTelegramMessage(chatId, "Bạn không có quyền sử dụng Hermes.");
        continue;
      }


      if (normalized === "/skills" || normalized === "/skills list" || normalized.startsWith("/skills match ") || normalized.startsWith("/skills show ") || normalized.startsWith("/skills why ") || normalized === "/skills doctor" || normalized.startsWith("/skills learn") || normalized.startsWith("/skills save-memory")) {
        try {
          await sendTelegramMessage(chatId, await buildSkillsCommandReply(text));
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /skills: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /skills", { userId, chatId });
        continue;
      }

      if (normalized === "/status") {
        try {
          await sendTelegramMessage(chatId, await buildTelegramStatusMessage());
        } catch (err) {
          await sendTelegramMessage(chatId, `Hermes Status\n- App: WARN\n- DB: DOWN or unavailable\n- Warning: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /status", { userId, chatId });
        continue;
      }

      try {
        await query(
          `insert into telegram_users (telegram_user_id, is_allowed)
           values ($1, $2)
           on conflict (telegram_user_id)
           do update set last_seen_at = now()`,
          [userId, isAllowed(userId)]
        );
      } catch (err) {
        console.warn("telegram user upsert failed:", err.message);
      }

      if (normalized === "/start") {
        await sendTelegramMessage(chatId, "👋 Hermes đã sẵn sàng.\n\nGõ /help để xem lệnh.");
        console.log("COMMAND_HANDLED /start", { userId, chatId });
        continue;
      }

      if (normalized === "/help") {
        await sendTelegramMessage(chatId, "Gõ /commands để xem toàn bộ lệnh Hermes.");
        console.log("COMMAND_HANDLED /help", { userId, chatId });
        continue;
      }

      if (normalized === "/health") {
        await sendTelegramMessage(chatId, "Hermes app online ✅\nWorker sẽ xử lý task trong nền.");
        console.log("COMMAND_HANDLED /health", { userId, chatId });
        continue;
      }
      if (normalized === "/task" || normalized.startsWith("/task ")) {
        try {
          await sendTelegramMessage(chatId, await buildTelegramTaskMessage(text));
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /task: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /task", { userId, chatId });
        continue;
      }

      if (normalized === "/events" || normalized.startsWith("/events ")) {
        try {
          await sendTelegramMessage(chatId, await buildTelegramEventsMessage(text));
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /events: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /events", { userId, chatId });
        continue;
      }

      if (normalized === "/pending") {
        try {
          await sendTelegramMessage(chatId, await buildPendingApprovalsMessage());
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /pending: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /pending", { userId, chatId });
        continue;
      }

      if (normalized === "/queue") {
        try {
          await sendTelegramMessage(chatId, await buildQueueMessage());
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /queue: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /queue", { userId, chatId });
        continue;
      }

      if (normalized === "/tasks" || normalized.startsWith("/tasks ")) {
        try {
          await sendTelegramMessage(chatId, await buildTasksCommandReply(text, { userId }));
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /tasks: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /tasks", { userId, chatId });
        continue;
      }

      if (normalized === "/memory stats") {
        try {
          await sendTelegramMessage(chatId, await buildMemoryStatsMessage());
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /memory stats: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /memory stats", { userId, chatId });
        continue;
      }

      if (normalized === "/remember" || normalized.startsWith("/remember ")) {
        try {
          await sendTelegramMessage(chatId, await buildRememberMessage(text));
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /remember: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /remember", { userId, chatId });
        continue;
      }

      if (normalized === "/recall" || normalized.startsWith("/recall ")) {
        try {
          await sendTelegramMessage(chatId, await buildRecallMessage(text));
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /recall: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /recall", { userId, chatId });
        continue;
      }

      if (normalized === "/approve" || normalized.startsWith("/approve ")) {
        const parsed = parseCommandIdAndReason(text, "/approve");
        if (parsed.error) { await sendTelegramMessage(chatId, "Dùng: /approve <id_số_nguyên_dương>"); continue; }
        try {
          await handleApprovalDecision({ taskId: parsed.id, actorUserId: userId, chatId, action: "approve" });
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /approve: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /approve", { userId, chatId, taskId: parsed.id });
        continue;
      }
      if (normalized === "/reject" || normalized.startsWith("/reject ")) {
        const parsed = parseCommandIdAndReason(text, "/reject");
        if (parsed.error) { await sendTelegramMessage(chatId, parsed.error); continue; }
        try {
          await handleApprovalDecision({ taskId: parsed.id, actorUserId: userId, chatId, action: "reject", reason: parsed.reason });
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /reject: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /reject", { userId, chatId, taskId: parsed.id });
        continue;
      }

      if (normalized === "/cancel" || normalized.startsWith("/cancel ")) {
        const parsed = parseCommandIdAndReason(text, "/cancel");
        if (parsed.error) { await sendTelegramMessage(chatId, parsed.error); continue; }
        try {
          await handleCancelTask({ taskId: parsed.id, actorUserId: userId, chatId, reason: parsed.reason });
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /cancel: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /cancel", { userId, chatId, taskId: parsed.id });
        continue;
      }

      if (normalized === "/retry" || normalized.startsWith("/retry ")) {
        const parsed = parseCommandIdAndReason(text, "/retry");
        if (parsed.error) { await sendTelegramMessage(chatId, parsed.error); continue; }
        try {
          await handleRetryTask({ taskId: parsed.id, actorUserId: userId, chatId });
        } catch (err) {
          await sendTelegramMessage(chatId, `Lỗi /retry: ${truncateForTelegram(err.message, 200)}`);
        }
        console.log("COMMAND_HANDLED /retry", { userId, chatId, taskId: parsed.id });
        continue;
      }

      if (text === "/commands") {
  await sendTelegramMessage(chatId, `📚 Hermes Commands

/status — system health
/queue — queue summary
/tasks summary|stale|expire-stale — task hygiene
/pending — pending approvals
/skills list|match|learn|save-memory — curated Hermes Skill Pack v3
/task <id> — task details
/events <id> — task event timeline
/approve <id> — approve pending task
/reject <id> <reason> — reject pending task
/cancel <id> <reason> — cancel queued approval safely
/retry <id> — retry failed task
/remember <text> — save memory
/recall <keyword> — search memory
/memory stats — memory stats

Other tools:
/menu — quick buttons
/codex <task> — build Codex prompt
/review <result> — review patch and learn
/audit <issue> — deep debug/audit
/deploy-check <text> — deploy safety checklist`);
  continue;
}

      // ===== SESSION HANDLER =====
const session = await getOrCreateTelegramSession(userId);
const sessionState = session?.state || null;

      if (text === "/status") {
  try {
    // 1) Docker services
    const ps = await execAsync("d	ocker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'");
    let services = "Không lấy được docker status";
    if (ps.ok && ps.stdout.trim()) {
  services = ps.stdout.trim().slice(0, 1200);
}
    // 2) Logs nhanh
    const appLog = await execAsync(
      "docker logs hermes_app --tail 20 2>&1"
    );
    const workerLog = await execAsync(
      "docker logs hermes_worker --tail 20 2>&1"
    );

    const appErr = (appLog.stdout || "").toLowerCase().includes("error");
    const workerErr = (workerLog.stdout || "").toLowerCase().includes("error");

    // 3) GBrain stats
    let memoryCount = 0;
    try {
      const mem = await query(`select count(*)::int as c from gbrain_memories`);
      memoryCount = mem.rows[0]?.c || 0;
    } catch {}

    // 4) Sessions
    let activeSessions = 0;
    try {
      const s = await query(
        `select count(*)::int as c from telegram_sessions where state is not null`
      );
      activeSessions = s.rows[0]?.c || 0;
    } catch {}

    // 5) Tổng hợp
    const reply = `📊 Hermes Status

🤖 App:
- hermes_app: ${appErr ? "⚠️ có lỗi gần đây" : "OK"}
- hermes_worker: ${workerErr ? "⚠️ có lỗi gần đây" : "OK"}

🐳 Docker:
${services}

🧠 GBrain:
- Memories: ${memoryCount}

🧩 Sessions:
- Active: ${activeSessions}

🧪 Logs (gần nhất):
- app: ${appErr ? "có 'error' trong 20 dòng" : "clean"}
- worker: ${workerErr ? "có 'error' trong 20 dòng" : "clean"}

NEXT ACTION:
- Nếu có lỗi → /audit <mô tả>
- Nếu cần fix → /codex <task>
- Review patch → /review <kết quả>
`;

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /status: ${err.message}`);
  }

  continue;
}

      const handled = await handleTelegramState({ userId, chatId, text, state: sessionState });
      if (handled) {
        console.log("FSM_HANDLED", sessionState);
        continue;
      }

      if (text === "/id") {
        await sendTelegramMessage(chatId, `Telegram user_id của bạn là: ${userId}`);
        continue;
      }

      if (text === "/time" || text.toLowerCase() === "mấy giờ rồi") {
  const now = new Date();

  const vnTime = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false,
  }).format(now);

  await sendTelegramMessage(chatId, `🕒 Giờ Việt Nam hiện tại: ${vnTime}`);
  continue;
}

      if (text === "/menu") {
  await sendTelegramMessage(chatId, "Hermes Control Center:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📚 Commands", callback_data: "menu_commands" }],
        [{ text: "📊 Status", callback_data: "menu_status" }],
        [{ text: "📋 Queue", callback_data: "menu_queue" }, { text: "🛂 Pending", callback_data: "menu_pending" }],
        [{ text: "🚀 Deploy Check", callback_data: "menu_deploy_check" }],
        [{ text: "🧪 Audit", callback_data: "menu_audit" }],
        [{ text: "🛠 Build Codex Prompt", callback_data: "menu_codex" }],
        [{ text: "🔍 Review Patch", callback_data: "menu_review" }],
        [{ text: "📅 Daily Report", callback_data: "menu_daily" }],
        [{ text: "📊 Weekly Report", callback_data: "menu_weekly" }],
        [{ text: "🧠 Recall GBrain", callback_data: "menu_recall" }],
        [{ text: "🧬 Learn", callback_data: "menu_learn" }],
      ],
    },
  });
  continue;
}

   if (text === "/learn-history") {
  try {
    const res = await query(`
      select id, category, title, created_at
      from gbrain_memories
      order by created_at desc
      limit 10
    `);

    const rows = res.rows || [];

    const msg = rows.length
      ? "🧠 GBrain Recent Memories:\n\n" +
        rows
          .map(
            (r) =>
              `#${r.id} [${r.category}] - ${r.title}`
          )
          .join("\n")
      : "Chưa có memory.";

    await sendTelegramMessage(chatId, msg);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /learn-history: ${err.message}`);
  }

  continue;
}

   if (text === "/memory-stats") {
  try {
    const res = await query(`
      select category, count(*)::int as c
      from gbrain_memories
      group by category
      order by c desc
    `);

    const rows = res.rows || [];

    const allCategories = [
      "known_bug",
      "coding_rule",
      "deployment_rule",
      "ops_sop",
      "project_context",
    ];

    const map = {};
    for (const r of rows) {
      map[r.category] = r.c;
    }

    const msg = `🧠 Memory Stats

known_bug: ${map["known_bug"] || 0}
coding_rule: ${map["coding_rule"] || 0}
deployment_rule: ${map["deployment_rule"] || 0}
ops_sop: ${map["ops_sop"] || 0}
project_context: ${map["project_context"] || 0}
`;

    await sendTelegramMessage(chatId, msg);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /memory-stats: ${err.message}`);
  }

  continue;
}

   if (text.startsWith("/quick-fix")) {
  try {
    const input = text.replace("/quick-fix", "").trim();

    if (!input) {
      await sendTelegramMessage(chatId, "Dùng: /quick-fix <vấn đề>");
      continue;
    }

    // 1. Audit (chỉ lấy nhận định ngắn)
    const audit = await buildAudit(input);

    const quickSummary = audit
      .split("ROOT CAUSE")[0]   // lấy phần đầu thôi
      .replace("NHẬN ĐỊNH NHANH:", "")
      .trim();

    // 2. Codex prompt (giữ full)
    const codex = await buildCodexPrompt(input);

    // 3. Reply gọn
    const reply = `⚡ Quick Fix

🧠 Nhận định:
${quickSummary}

🛠 Prompt Codex:
${codex}

👉 NEXT:
1. Copy prompt sang Codex
2. Paste kết quả vào /review`;

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /quick-fix: ${err.message}`);
  }

  continue;
}

   if (text.startsWith("/forget")) {
  try {
    const id = text.split(" ")[1];

    if (!id) {
      await sendTelegramMessage(chatId, "Dùng: /forget <id>");
      continue;
    }

    const result = await query(
      `delete from gbrain_memories where id = $1 returning id`,
      [id]
    );

    if (result.rowCount > 0) {
      await sendTelegramMessage(chatId, `🗑️ Đã xoá memory #${id}`);
    } else {
      await sendTelegramMessage(chatId, `Không tìm thấy memory #${id}`);
    }
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /forget: ${err.message}`);
  }

  continue;
}

      if (text.startsWith("/learn")) {
  const input = text.replace("/learn", "").trim();

  if (!input) {
    await sendTelegramMessage(chatId, "Bạn cần gửi nội dung sau /learn.");
    continue;
  }

  try {
    const memory = await learnFromText(input, "telegram");
    await sendTelegramMessage(
      chatId,
      `🧬 Đã lưu vào GBrain:\n${memory.title}\n\nLesson: ${memory.lesson || memory.summary}`
    );
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /learn: ${err.message}`);
  }

  continue;
}

if (text.startsWith("/recall")) {
  const input = text.replace("/recall", "").trim();

  if (!input) {
    await sendTelegramMessage(chatId, "Bạn cần nhập từ khóa sau /recall.");
    continue;
  }

  try {
    const memories = await recallMemories(input);

    if (!memories.length) {
      await sendTelegramMessage(chatId, "Chưa tìm thấy memory liên quan.");
      continue;
    }

    const reply = memories
      .map(
        (m) =>
          `🧠 ${m.title}\n${m.summary}\n${m.lesson ? `Lesson: ${m.lesson}` : ""}\nTags: ${(m.tags || []).join(", ")}`
      )
      .join("\n\n");

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /recall: ${err.message}`);
  }

  continue;
}

      if (text.startsWith("/codex")) {
  const input = text.replace("/codex", "").trim();

  if (!input) {
    await sendTelegramMessage(chatId, "Bạn cần gửi nội dung sau /codex.");
    continue;
  }

  try {
    const result = await buildCodexPrompt(input);
    await sendTelegramMessage(chatId, `🛠 Prompt Codex:\n\n${result}`);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /codex: ${err.message}`);
  }

  continue;
}

if (text.startsWith("/code")) {
  const input = text.replace("/code", "").trim();

  if (!input) {
    await sendTelegramMessage(chatId, "Bạn cần gửi nội dung sau /code.");
    continue;
  }

  try {
    const result = await createCodeAgentTask(chatId, userId, input);
    if (result.duplicate) {
      await sendTelegramMessage(chatId, `Issue đã tồn tại cho task này: ${result.issueUrl}`);
    } else {
      const triggerLine = result.codexTriggerOk
        ? "Codex trigger: ✅ thành công"
        : `Codex trigger: ❌ thất bại (${result.codexTriggerError || "unknown error"})`;
      await sendTelegramMessage(
        chatId,
        `✅ Đã tạo GitHub Issue #${result.issueNumber}:\n${result.issueUrl}\n${triggerLine}`
      );
    }
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /code: ${err.message}`);
  }

  continue;
}


if (text.startsWith("/pr")) {
  const input = text.replace("/pr", "").trim();

  if (!input || Number.isNaN(Number(input))) {
    await sendTelegramMessage(chatId, "Bạn cần nhập task_id hợp lệ sau /pr. Ví dụ: /pr 123");
    continue;
  }

  try {
    const pr = await checkAndStorePullRequest(Number(input));
    if (!pr) {
      await sendTelegramMessage(chatId, `Chưa tìm thấy PR linked cho task #${input}.`);
    } else {
      await sendTelegramMessage(chatId, `✅ Đã tìm thấy PR #${pr.pullRequestNumber}:\n${pr.pullRequestUrl}`);
    }
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /pr: ${err.message}`);
  }

  continue;
}

if (text.startsWith("/review")) {
  const input = text.replace("/review", "").trim();

  if (!input) {
    await sendTelegramMessage(chatId, "Bạn cần paste kết quả Codex sau /review.");
    continue;
  }

  try {

    const result = await reviewCodexResult(input);

let autoLearnText = "";

if (
  result.includes("LESSON NÊN LƯU") ||
  result.includes("LESSON NEN LUU") ||
  result.includes("lesson")
) {
  try {
    const memory = await learnFromText(result, "auto_review");
    autoLearnText = `\n\n🧬 Auto Learn: đã lưu vào GBrain\n- ${memory.title}`;
  } catch (e) {
    console.error("Auto learn failed:", e.message);
    autoLearnText = `\n\n⚠️ Auto Learn lỗi: ${e.message}`;
  }
}

await sendTelegramMessage(
  chatId,
  `🔍 Review Patch:\n\n${result}${autoLearnText}`
);

  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /review: ${err.message}`);
  }

  continue;
}

    if (text.startsWith("/audit")) {
  const input = text.replace("/audit", "").trim();

  if (!input) {
    await sendTelegramMessage(chatId, "Bạn cần gửi nội dung sau /audit.");
    continue;
  }

  try {
    const result = await buildAudit(input);
    await sendTelegramMessage(chatId, `🧪 Audit:\n\n${result}`);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /audit: ${err.message}`);
  }

  continue;
}

    if (text.startsWith("/deploy-check")) {
  const input = text.replace("/deploy-check", "").trim();

  try {
    const result = await buildDeployCheck(input);
    await sendTelegramMessage(chatId, `🚀 Deploy Check:\n\n${result}`);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /deploy-check: ${err.message}`);
  }

  continue;
}

    if (text === "/weekly") {
  try {
    // 1) Tasks 7 ngày
    let tasks7d = [];
    try {
      const t = await query(`
        select input_text, created_at
        from hermes_tasks
        where created_at >= now() - interval '7 days'
          and input_text is not null
      `);
      tasks7d = t.rows || [];
    } catch {}

    // 2) Gom nhóm vấn đề (lọc noise + normalize)
    const counter = {};
    for (const t of tasks7d) {
      const s = (t.input_text || "").toLowerCase();

      let key = null;
      if (s.includes("payment")) key = "payment";
      else if (s.includes("qr")) key = "qr";
      else if (s.includes("booking")) key = "booking";
      else if (s.includes("admin")) key = "admin";
      else if (s.includes("cleaner")) key = "cleaner";

      // bỏ noise
      if (!key) continue;
      if (s.includes("git") || s.includes("readme") || s.includes("package.json") || s.includes("xem repo") || s.includes("chạy lệnh")) continue;

      counter[key] = (counter[key] || 0) + 1;
    }

    const topProblems = Object.entries(counter)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    const problemText = topProblems.length
      ? topProblems.map(([k, v]) => `${v}x - ${k}`).join("\n")
      : "Chưa có pattern rõ";

    // 3) Lessons từ GBrain (7 ngày)
    let lessons = [];
    try {
      const l = await query(`
        select title, summary
  from gbrain_memories
  where created_at >= now() - interval '7 days'
    and title not ilike '%test%'
    and title not ilike '%tên người dùng%'
    and title not ilike '%mason%'
    and title not ilike '%demo%'
    and summary not ilike '%test%'
    and summary not ilike '%tên người dùng%'
    and summary not ilike '%mason%'
    and summary not ilike '%demo%'
  order by created_at desc
  limit 5
      `);
      lessons = l.rows || [];
    } catch {}

    const lessonText = lessons.length
      ? lessons.map((l) => `- ${l.title}`).join("\n")
      : "Chưa có lesson mới";

    // 4) Pattern xấu
    let patterns = [];
    if (topProblems.length > 0) {
      const [k, v] = topProblems[0];
      if (v >= 3) {
        patterns.push(`Lặp lại nhiều lần: ${k} (${v} lần)`);
      }
    }
    if (patterns.length === 0) {
      patterns.push("Chưa thấy pattern xấu rõ ràng");
    }

    // 5) Đề xuất hành động
    let actions = [];
    if (topProblems.length > 0) {
      const [k] = topProblems[0];

      if (k === "payment") {
        actions.push("🔥 Fix dứt điểm flow payment/payOS (QR, polling, webhook)");
        actions.push("👉 Dùng: /audit lỗi payment → /codex fix → /review");
      }
      if (k === "booking") {
        actions.push("📅 Rà soát booking conflict + pricing logic");
      }
      if (k === "admin") {
        actions.push("🛠 Audit admin flows + permissions (RBAC)");
      }
      if (k === "cleaner") {
        actions.push("🧹 Kiểm tra cleaner bot + task assignment + photo review");
      }
    }

    if (actions.length === 0) {
      actions.push("✅ Hệ ổn → tiếp tục /codex để build feature");
    }

    // 6) Reply
    const reply = `📊 Hermes Weekly Report

🔥 Top Problems (7d):
${problemText}

🧠 Lessons (7d):
${lessonText}

📉 Pattern:
${patterns.join("\n")}

🚀 Đề xuất:
${actions.join("\n")}

NEXT ACTION:
- Deep debug → /audit <vấn đề>
- Fix → /codex <task>
- Review → /review <kết quả>
`;

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /weekly: ${err.message}`);
  }

  continue;
}

 
  if (text === "/daily") {
  try {
    const report = await buildDailyReport();
    await sendTelegramMessage(chatId, report);
  } catch (err) {
    await sendTelegramMessage(chatId, `Lỗi /daily: ${err.message}`);
  }

  continue;
}
  


      if (isCasualTelegramInput(text)) {
        console.log("CASUAL_CHAT_HANDLED", { userId, chatId, text });
        await sendTelegramMessage(chatId, buildCasualTelegramReply());
        continue;
      }

      if (!isTaskLikeTelegramInput(text)) {
        console.log("UNKNOWN_INTENT_CLARIFICATION", { userId, chatId, text });
        await sendTelegramMessage(chatId, buildUnknownTelegramReply(text));
        continue;
      }

      if (isExternalCliTask(text) && /do not run commands|don't run commands|no commands|không chạy lệnh/i.test(text)) {
        const tool = routeTool(text);
        await sendTelegramMessage(chatId, tool
          ? `Recommended tool: ${tool.name} (${tool.label}). No commands were run.`
          : 'No remembered capability tool matched this request. No commands were run.');
        continue;
      }

      console.log("DEFAULT_TASK_PATH_ENTERED", { userId, chatId, text });
      try {
        const taskId = await createTask(chatId, userId, text);
        await sendTelegramMessage(chatId, `Đã nhận task #${taskId}. Hermes đang xử lý...`);
      } catch (err) {
        if (String(err.message || "").startsWith("external_cli_command_rejected:")) {
          await sendTelegramMessage(chatId, `Rejected external CLI request: ${String(err.message).replace(/^external_cli_command_rejected:\s*/, "")}`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error("Polling error:", err.response?.data || err.message);
  }

  setTimeout(pollTelegram, 1000);
}

function getVietnamDateKey() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
  });
}


function getVietnamHourMinute() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const hour = parts.find(p => p.type === "hour")?.value;
  const minute = parts.find(p => p.type === "minute")?.value;

  return `${hour}:${minute}`;
}

function getVietnamWeekday() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
  }).format(new Date());
}

async function sendAutoReport() {
  if (!OWNER_CHAT_ID) return;

  const dateKey = getVietnamDateKey();
  const time = getVietnamHourMinute();
  const weekday = getVietnamWeekday();

  // Daily: mỗi ngày 08:30 VN
  if (AUTO_DAILY_ENABLED && time === "08:30" && lastDailyKey !== dateKey) {
    lastDailyKey = dateKey;
    await sendTelegramMessage(
      OWNER_CHAT_ID,
      "📅 Auto Daily Report\n\nGõ /daily để xem báo cáo hôm nay."
    );
  }

  // Weekly: thứ 2 08:35 VN
  if (
    AUTO_WEEKLY_ENABLED &&
    weekday === "Mon" &&
    time === "08:35" &&
    lastWeeklyKey !== dateKey
  ) {
    lastWeeklyKey = dateKey;
    await sendTelegramMessage(
      OWNER_CHAT_ID,
      "📊 Auto Weekly Report\n\nGõ /weekly để xem báo cáo tuần."
    );
  }
}

if (require.main === module) {
  setInterval(() => {
    sendAutoReport().catch((err) =>
      console.error("Auto report error:", err.message)
    );
  }, 60 * 1000);

  pollTelegram();

  app.listen(3000, () => {
    console.log("Hermes app running on port 3000");
  });
}

module.exports = {
  app,
  createTask,
  logSkillUsageForTask,
  buildSkillsCommandReply,
  buildSkillLearnReviewMessage,
  saveSkillLessonToMemory,
  buildSkillSaveMemoryMessage,
  buildTasksCommandReply,
  buildTasksStaleMessage,
  expireStaleTasks,
  buildTasksExpireStaleMessage,
  buildTasksSummaryMessage,
  isTaskStale,
  isCasualTelegramInput,
  isTaskLikeTelegramInput,
};
