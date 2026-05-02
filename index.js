const express = require("express");
const axios = require("axios");
const { query } = require("./db");
const { canonicalizeApprovalSnapshot, hashApprovalSnapshot, normalizeInputText } = require("./approvalSnapshot");
const { getSystemHealth } = require("./dispatcher/health");
const {
  ensureGBrainSchema,
  learnFromText,
  recallMemories,
  runDispatcher,
  buildCodexPrompt,
  reviewCodexResult,
  buildAudit,
  buildDeployCheck,
} = require("./gbrain");
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

function isAllowed(userId) {
  return ALLOWED_USER_IDS.includes(Number(userId));
}


async function createTask(chatId, userId, text) {
  const normalized = normalizeInputText(text);
  const dedupeKey = crypto
    .createHash("sha256")
    .update(`${userId}:${normalized}`)
    .digest("hex");
  const approvalSnapshot = canonicalizeApprovalSnapshot({
    taskId: "",
    payload: {
      intent: "execute",
      normalized_input: normalized,
      execution_plan: ["parse_intent", "run_gates", "execute_plan"],
      risk_level: "medium",
      action_list: ["git status", "npm test", "npm run build"],
      memory_ids_used: [],
    },
    inputText: text,
    intent: "execute",
    appEnv: process.env.APP_ENV || "development",
  });

  const result = await query(
    `insert into hermes_tasks (telegram_chat_id, telegram_user_id, input_text, status, idempotency_key)
     values ($1, $2, $3, 'planned', $4)
     on conflict (idempotency_key) do update set updated_at=now()
     returning id`,
    [chatId, userId, text, dedupeKey]
  );

  const taskId = result.rows[0].id;
  const canonicalApprovalSnapshot = canonicalizeApprovalSnapshot({
    taskId,
    payload: approvalSnapshot,
    inputText: text,
    intent: "execute",
    appEnv: process.env.APP_ENV || "development",
  });
  const approvalSnapshotHash = hashApprovalSnapshot(canonicalApprovalSnapshot);

  await query(
    `insert into hermes_task_events (task_id, event_type, message)
     values ($1, 'created', $2)`,
    [taskId, "Task created from Telegram"]
  );
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
    const actionList = Array.isArray(approvalSnapshot.action_list) ? approvalSnapshot.action_list.join(", ") : "-";
    const shortHash = approvalSnapshotHash ? approvalSnapshotHash.slice(0, 12) : "-";
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const approvalMessage = [
      `🛂 Task #${taskId} cần duyệt`,
      `Intent: ${approvalSnapshot.intent || "-"}`,
      `Input: ${String(text || "").slice(0, 500) || "-"}`,
      `Risk: ${approvalSnapshot.risk_level || "-"}`,
      `Expires: ${expiresAt}`,
      `Snapshot: ${shortHash}`,
      `Actions: ${actionList || "-"}`,
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

async function handleApprovalDecision({ taskId, actorUserId, chatId, action }) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    await sendTelegramMessage(chatId, "Dùng: /approve <id_số_nguyên_dương> hoặc /reject <id_số_nguyên_dương>");
    return;
  }
  if (!isAllowed(actorUserId)) {
    await sendTelegramMessage(chatId, `❌ Bạn không có quyền ${action === "approve" ? "duyệt" : "từ chối"} task ${taskId}`);
    return;
  }
  const taskCheck = await query(
    `select status, input_text, intent, approval_snapshot_hash, approval_snapshot_payload, approval_expires_at
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
    await sendTelegramMessage(chatId, `✅ Đã duyệt task ${taskId}`);
    return;
  }
  const rej = await query(`update hermes_tasks set status='failed', error_text='Rejected by operator', updated_at=now() where id=$1 and status='pending_approval'`, [taskId]);
  if ((rej.rowCount || 0) === 1) {
    await query(`insert into hermes_task_events (task_id, event_type, message, payload) values ($1,'rejected',$2,$3)`, [taskId, 'Task rejected from Telegram', { callback_user_id: actorUserId }]);
  }
  await sendTelegramMessage(chatId, `❌ Đã từ chối task ${taskId}`);
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

ensureGBrainSchema()
  .then(() => console.log("GBrain schema ready 🧠"))
  .catch((err) => console.error("GBrain schema error:", err.message));

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

      await query(
        `insert into telegram_users (telegram_user_id, is_allowed)
         values ($1, $2)
         on conflict (telegram_user_id)
         do update set last_seen_at = now()`,
        [userId, isAllowed(userId)]
      );

      if (!isAllowed(userId)) {
        await sendTelegramMessage(chatId, "Bạn không có quyền sử dụng Hermes.");
        continue;
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
      if (normalized.startsWith("/task ")) {
        const id = Number(text.split(/\s+/)[1]);
        if (!Number.isInteger(id) || id <= 0) { await sendTelegramMessage(chatId, "Dùng: /task <id_số_nguyên_dương>"); continue; }
        const tRes = await query(`select id,status,intent,input_text,created_at,updated_at,approved_by,approved_at,result_text,error_text,result_summary from hermes_tasks where id=$1 limit 1`, [id]);
        const t = tRes.rows[0];
        if (!t) { await sendTelegramMessage(chatId, `Không tìm thấy task #${id}.`); continue; }
        const eRes = await query(`select event_type,message,created_at from hermes_task_events where task_id=$1 order by id desc limit 10`, [id]);
        const events = eRes.rows.reverse().map((e,i)=>`${i+1}. ${e.event_type} — ${String(e.message||'').slice(0,120)}`).join("\n");
        await sendTelegramMessage(chatId, `📌 Task #${t.id}\n\nStatus: ${t.status}\nIntent: ${t.intent || '-'}\nInput: ${String(t.input_text||'').slice(0,300)}\nApproval: ${t.approved_by ? `approved by ${t.approved_by}` : 'n/a'}\n\nLatest events:\n${events || '-' }\n\nResult: ${String(t.result_text || t.error_text || '-').replace(/(token|apikey|authorization|password|bearer)\s*[:=]?\s*[^\s]+/gi, "$1=[REDACTED]").slice(0,500)}`);
        continue;
      }
      if (normalized.startsWith("/events ")) {
        const parts = text.split(/\s+/);
        const id = Number(parts[1]); if (!Number.isInteger(id) || id <= 0) { await sendTelegramMessage(chatId, "Dùng: /events <id> [limit 1-50] [offset>=0]"); continue; }
        const limit = Math.min(50, Math.max(1, Number(parts[2] || 20)));
        const offsetArg = Math.max(0, Number(parts[3] || 0));
        let ev;
        try {
          ev = await query(`select id,event_type,message,created_at from hermes_task_events where task_id=$1 order by sequence_id asc nulls last, id asc, created_at asc limit $2 offset $3`, [id, limit, offsetArg]);
        } catch {
          ev = await query(`select id,event_type,message,created_at from hermes_task_events where task_id=$1 order by id asc, created_at asc limit $2 offset $3`, [id, limit, offsetArg]);
        }
        const msg = ev.rows.map((e,i)=>`${i+1+offsetArg}. ${new Date(e.created_at).toISOString()} — ${e.event_type}\n   ${String(e.message||'').slice(0,120)}`).join("\n\n") || "Không có event.";
        await sendTelegramMessage(chatId, `🧾 Events for task #${id}\n\n${msg}`);
        continue;
      }
      if (normalized.startsWith("/approve")) {
        const id = Number(text.split(/\s+/)[1]);
        if (!Number.isInteger(id) || id <= 0) { await sendTelegramMessage(chatId, "Dùng: /approve <id_số_nguyên_dương>"); continue; }
        await handleApprovalDecision({ taskId: id, actorUserId: userId, chatId, action: "approve" });
        continue;
      }
      if (normalized.startsWith("/reject")) {
        const id = Number(text.split(/\s+/)[1]);
        if (!Number.isInteger(id) || id <= 0) { await sendTelegramMessage(chatId, "Dùng: /reject <id_số_nguyên_dương>"); continue; }
        await handleApprovalDecision({ taskId: id, actorUserId: userId, chatId, action: "reject" });
        continue;
      }

      if (text === "/commands") {
  await sendTelegramMessage(chatId, `📚 Hermes Commands

/menu
Mở bảng nút nhanh.

/status
Kiểm tra trạng thái Hermes, GBrain, session, logs.

/codex <task>
Tạo prompt chuẩn cho Codex/Cursor.

/review <kết quả Codex>
Review patch, đánh giá rủi ro, auto learn vào GBrain.

/audit <vấn đề>
Audit lỗi/sự cố và tạo hướng xử lý.

/deploy-check <nội dung deploy>
Checklist an toàn trước deploy.

/learn <bài học>
Lưu memory vào GBrain.

/recall <từ khóa>
Tìm lại memory trong GBrain.

Flow chuẩn:
1. /codex <vấn đề>
2. Copy sang Codex
3. /review <kết quả>
4. /recall <từ khóa> để kiểm tra Hermes đã học`);
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
  


      console.log("DEFAULT_TASK_PATH_ENTERED", { userId, chatId, text });
      const taskId = await createTask(chatId, userId, text);
      await sendTelegramMessage(chatId, `Đã nhận task #${taskId}. Hermes đang xử lý...`);
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

setInterval(() => {
  sendAutoReport().catch((err) =>
    console.error("Auto report error:", err.message)
  );
}, 60 * 1000);

pollTelegram();

app.listen(3000, () => {
  console.log("Hermes app running on port 3000");
});
