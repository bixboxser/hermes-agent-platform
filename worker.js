const axios = require("axios");
const OpenAI = require("openai");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const { query } = require("./db");

const execAsync = promisify(exec);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const PROJECT_ROOT = "/root/projects/somewhere-sanctuary-hub-main-final";

const ai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

async function sendTelegramMessage(chatId, text, buttons = null) {
  const MAX = 3500;
  const chunks = String(text).match(new RegExp(`[\\s\\S]{1,${MAX}}`, "g")) || [""];

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id: chatId,
      text: chunks[i],
    };

    if (buttons && i === chunks.length - 1) {
      payload.reply_markup = {
        inline_keyboard: buttons,
      };
    }

    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  }
}

async function event(taskId, type, message, payload = {}) {
  await query(
    `insert into hermes_task_events (task_id, event_type, message, payload)
     values ($1, $2, $3, $4)`,
    [taskId, type, message, payload]
  );
}

async function logAction(taskId, actionName, input, output, status) {
  await query(
    `insert into hermes_action_logs (task_id, action_name, input, output, status)
     values ($1, $2, $3, $4, $5)`,
    [taskId, actionName, input, output, status]
  );
}

function isSafePath(filePath) {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  return resolved.startsWith(PROJECT_ROOT);
}

function isProtectedFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");

  const protectedPatterns = [
    ".env",
    ".env.local",
    ".env.production",
    "docker-compose.yml",
    "package-lock.json",
    "supabase/migrations/",
    ".git/",
    "node_modules/",
  ];

  return protectedPatterns.some((pattern) =>
    normalized === pattern || normalized.startsWith(pattern)
  );
}

function assertCanEditFile(filePath) {
  if (!isSafePath(filePath)) {
    throw new Error("File path không an toàn.");
  }

  if (isProtectedFile(filePath)) {
    throw new Error(`File được bảo vệ, không cho Hermes sửa: ${filePath}`);
  }
}


function shouldRunBuildForFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");

  const docsOnly = [
    "README.md",
    "docs/",
    "OPERATIONS_RUNBOOK.md",
    "SUPABASE_SETUP.md",
  ];

  if (docsOnly.some((p) => normalized === p || normalized.startsWith(p))) {
    return false;
  }

  const buildSensitive = [
    "src/",
    "app/",
    "pages/",
    "components/",
    "lib/",
    "middleware.ts",
    "next.config.ts",
    "package.json",
    "tsconfig.json",
    "tailwind.config.ts",
    "postcss.config.cjs",
  ];

  return buildSensitive.some((p) => normalized === p || normalized.startsWith(p));
}

function findLatestBackup(fullPath) {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);

  if (!fs.existsSync(dir)) return null;

  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.hermes-backup-`))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return backups[0] || null;
}

function isSafeCommand(command) {
  const safePrefixes = [
    "pwd",
    "ls",
    "cat",
    "find",
    "grep",
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run build",
    "git status",
    "git diff",
    "git log",
  ];

function buildSimpleDiff(oldContent, newContent) {
  // diff đơn giản (line-by-line)
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let diff = [];
  const max = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];

    if (o === n) {
      diff.push("  " + (o ?? ""));
    } else {
      if (o !== undefined) diff.push("- " + o);
      if (n !== undefined) diff.push("+ " + n);
    }
  }
  return diff.join("\n");
}

  const dangerous = [
    "rm ",
    "rm -rf",
    "sudo",
    "chmod",
    "chown",
    "curl ",
    "wget ",
    "scp ",
    "ssh ",
    "docker",
    "docker-compose",
    "systemctl",
    "reboot",
    "shutdown",
    "kill",
    "pkill",
    "mv ",
    "cp ",
    "sed ",
    "perl ",
    "python ",
    "python3 ",
    "node -e",
    "npm install",
    "npm audit fix",
    "npx ",
    ">",
    ">>",
    "|",
    "&&",
    ";",
    "`",
    "$(",
  ];

  const trimmed = command.trim();

  if (dangerous.some((x) => trimmed.includes(x))) return false;
  return safePrefixes.some((x) => trimmed.startsWith(x));
}

async function runSafeCommand(taskId, command) {
  if (!isSafeCommand(command)) {
    await query(
      `insert into hermes_approvals (task_id, action_name, command, status)
       values ($1, 'command_requires_approval', $2, 'pending')`,
      [taskId, command]
    );
  
  const taskRow = await query(
  `select telegram_chat_id from hermes_tasks where id=$1`,
  [taskId]
);

const chatId = taskRow.rows[0]?.telegram_chat_id;

if (chatId) {
  await sendTelegramMessage(
    chatId,
    `⚠️ Lệnh cần duyệt:\n\n${command}`,
    [
      [
        { text: "✅ Duyệt", callback_data: `approve_${taskId}` },
        { text: "❌ Từ chối", callback_data: `reject_${taskId}` },
      ],
    ]
  );
}

return "Đang chờ bạn duyệt...";

  }

  const { stdout, stderr } = await execAsync(command, {
    cwd: PROJECT_ROOT,
    shell: "/bin/bash",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });

  return [stdout, stderr].filter(Boolean).join("\n") || "Lệnh chạy xong, không có output.";
}



async function classifyIntent(text) {
  const intent = detectIntent(text);
  console.log("INTENT:", intent, "| TEXT:", text);
}

async function loadMemories() {
  const result = await query(
    `select memory_text from hermes_memories order by updated_at desc limit 10`
  );
  return result.rows.map((r) => r.memory_text).join("\n");
}

function buildSimpleDiff(oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let diff = [];
  const max = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];

    if (o === n) {
      diff.push("  " + (o ?? ""));
    } else {
      if (o !== undefined) diff.push("- " + o);
      if (n !== undefined) diff.push("+ " + n);
    }
  }

  return diff.join("\n");
}

function detectIntent(text) {
  const lower = text.toLowerCase();

  // recall memory
  if (lower.includes("nhớ gì") || lower.includes("memory")) {
    return "recall_memory";
  }

  // learn (PHẢI RẤT CHẶT)
  if (
    lower.includes("nhớ rằng") ||
    lower.includes("ghi nhớ") ||
    lower.includes("remember that") ||
    lower.includes("save this") ||
    lower.includes("store this")
  ) {
    return "learn";
  }

  // audit (ưu tiên cao)
  if (
    lower.includes("audit") ||
    lower.includes("đánh giá") ||
    lower.includes("phân tích") ||
    lower.includes("roadmap") ||
    lower.includes("architecture") ||
    lower.includes("gap") ||
    lower.includes("còn thiếu") ||
    lower.includes("thiếu gì")
  ) {
    return "audit";
  }

  // execute
  if (
    lower.includes("fix") ||
    lower.includes("sửa") ||
    lower.includes("build") ||
    lower.includes("implement") ||
    lower.includes("debug") ||
    lower.includes("tạo") ||
    lower.includes("viết")
  ) {
    return "execute";
  }

  // fallback
  return "execute";
}

async function runAction(task) {
  const text = task.input_text;
  const intent = await classifyIntent(text);

  if (intent === "create_patch") {
  // mẫu: "sửa file package.json: thêm script build"
  const match = text.match(/sửa file\s+([^\:]+)\:(.+)/i);
  if (!match) return "Cú pháp: sửa file <tên_file>: <mô tả thay đổi>";

  const filePath = match[1].trim();
  const instruction = match[2].trim();

  assertCanEditFile(filePath);

  const fullPath = path.resolve(PROJECT_ROOT, filePath);
  if (!fs.existsSync(fullPath)) return `Không tìm thấy file: ${filePath}`;

  const oldContent = fs.readFileSync(fullPath, "utf8");

const aiRes = await ai.chat.completions.create({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    
     reasoning_effort: "high",    extra_body: {      thinking: { type: "enabled" }    },

     messages: [
      {
        role: "system",
        content: "Bạn sửa code theo yêu cầu, trả về TOÀN BỘ nội dung file mới, không giải thích."
      },
      {
        role: "user",
        content: `File hiện tại:\n${oldContent}\n\nYêu cầu: ${instruction}`
      }
    ],
    temperature: 0.2,
  });

  const newContent = aiRes.choices?.[0]?.message?.content || oldContent;
  const diff = buildSimpleDiff(oldContent, newContent);

  const r = await query(
    `insert into hermes_patches (task_id, file_path, diff_text)
     values ($1, $2, $3) returning id`,
    [task.id, filePath, diff]
  );

  return `Đã tạo patch #${r.rows[0].id} cho ${filePath}\n\nXem bằng: xem patch ${r.rows[0].id}`;
}

  await query(
    `update hermes_tasks set intent=$1, updated_at=now() where id=$2`,
    [intent, task.id]
  );

  await event(task.id, "intent_detected", `Intent: ${intent}`);

  if (intent === "health_check") {
    return "Hermes health check ✅\nApp: online\nWorker: online\nDB: Postgres\nDev Agent: enabled";
  }

  if (intent === "list_tasks") {
    const result = await query(
      `select id,status,intent,input_text from hermes_tasks order by id desc limit 10`
    );
    return result.rows.map((t) => `#${t.id} — ${t.status} — ${t.intent || "-"} — ${t.input_text}`).join("\n");
  }

  if (intent === "view_patch") {
  const m = text.match(/\d+/);
  if (!m) return "Dùng: xem patch <id>";

  const id = Number(m[0]);
  const r = await query(`select * from hermes_patches where id=$1`, [id]);
  if (!r.rows.length) return "Không tìm thấy patch";

  return `Patch #${id} (${r.rows[0].file_path}):\n\n${r.rows[0].diff_text.slice(0, 3500)}`;
}


if (intent === "approve_patch") {
  const m = text.match(/\d+/);
  if (!m) return "Dùng: duyệt patch <id>";

  const id = Number(m[0]);

  const r = await query(`select * from hermes_patches where id=$1`, [id]);
  if (!r.rows.length) return "Không tìm thấy patch";

  const patch = r.rows[0];
  if (patch.status !== "pending") return "Patch đã xử lý rồi";

  const branchName = `hermes/patch-${id}`;

  await execAsync(`git fetch origin`, { cwd: PROJECT_ROOT, shell: "/bin/bash" });
  await execAsync(`git checkout main`, { cwd: PROJECT_ROOT, shell: "/bin/bash" });
  await execAsync(`git pull origin main`, { cwd: PROJECT_ROOT, shell: "/bin/bash" });

  await execAsync(`git checkout -B ${branchName}`, {
    cwd: PROJECT_ROOT,
    shell: "/bin/bash",
  });

  const lines = patch.diff_text
    .split("\n")
    .filter((l) => !l.startsWith("- "))
    .map((l) => l.replace(/^\+ |^  /, ""));

  const fullPath = path.resolve(PROJECT_ROOT, patch.file_path);
  fs.writeFileSync(fullPath, lines.join("\n"), "utf8");

  // ===== SMART TEST GATE =====
  let buildOutput = "";

  if (shouldRunBuildForFile(patch.file_path)) {
    try {
      const build = await execAsync(`npm run build`, {
        cwd: PROJECT_ROOT,
        shell: "/bin/bash",
        timeout: 300000,
        maxBuffer: 1024 * 1024 * 5,
        env: process.env,
      });

      buildOutput = build.stdout || build.stderr || "";
    } catch (err) {
      const backupPath = findLatestBackup(fullPath);

      if (backupPath) {
        fs.copyFileSync(backupPath, fullPath);
      }

      return [
        "❌ Build FAILED → Patch bị từ chối",
        "",
        "Hermes đã rollback file.",
        "",
        err.stdout || err.stderr || err.message || "",
      ].join("\n");
    }
  } else {
    buildOutput = `Smart test gate: skipped build for docs/non-code file: ${patch.file_path}`;
  }

  await execAsync(`git add ${patch.file_path}`, {
    cwd: PROJECT_ROOT,
    shell: "/bin/bash",
  });

  await execAsync(`git commit -m "hermes: apply patch ${id}"`, {
    cwd: PROJECT_ROOT,
    shell: "/bin/bash",
  });

  await execAsync(`git push -u origin ${branchName}`, {
    cwd: PROJECT_ROOT,
    shell: "/bin/bash",
  });

  const prRes = await axios.post(
  `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pulls`,
  {
    title: `Hermes patch ${id}`,
    head: branchName,
    base: "main",
    body: `Auto-created by Hermes for patch #${id}.`,
  },
  {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }
);

const prUrl = prRes.data.html_url;
   

let previewUrl = "";

try {
  const repo = process.env.GITHUB_REPO;
  const owner = process.env.GITHUB_OWNER;

  const depRes = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/deployments`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  const latest = depRes.data.find((d) => d.ref === branchName);

  if (latest) {
    const statusRes = await axios.get(latest.statuses_url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });

    const success = statusRes.data.find((s) => s.state === "success");

    if (success && success.environment_url) {
      previewUrl = success.environment_url;
    }
  }
} catch (e) {
  console.log("Preview fetch failed:", e.message);
}

return [
  `Đã push lên branch riêng: ${branchName} ✅`,
  "",
  "Pull Request:",
  prUrl,
  "",
  previewUrl
    ? `Preview Deploy:\n${previewUrl}`
    : "Preview đang build... vào PR để xem",
].join("\n");
   
}

   if (intent === "check_preview") {
  const m = text.match(/\d+/);
  if (!m) return "Dùng: check preview <PR number>";

  const prNumber = m[0];

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  try {
    // lấy PR
    const prRes = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        },
      }
    );

    const branchName = prRes.data.head.ref;

    // lấy deployments
    const depRes = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/deployments`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        },
      }
    );

    const latest = depRes.data.find((d) => d.ref === branchName);

    if (!latest) {
      return `PR #${prNumber} chưa có deployment.`;
    }

    const statusRes = await axios.get(latest.statuses_url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    });

    const success = statusRes.data.find((s) => s.state === "success");

    if (success && success.environment_url) {
      return [
        `PR #${prNumber}`,
        "",
        `Preview:`,
        success.environment_url,
      ].join("\n");
    }

    return `Preview vẫn đang build... thử lại sau.`;

  } catch (err) {
    return "Lỗi khi lấy preview: " + (err.response?.data?.message || err.message);
  }
}

  if (
  intent === "learn" &&
  text.includes("TASK_TYPE")
) {
  return "Không lưu memory từ system prompt.";
}

  if (intent === "learn") {
  const memoryText = text
    .replace(/nhớ rằng/gi, "")
    .replace(/ghi nhớ/gi, "")
    .trim();

  if (!memoryText) {
    return "Bạn muốn Hermes ghi nhớ điều gì?";
  }

  await query(
    `insert into hermes_memories (memory_key, memory_text, source)
     values ($1, $2, 'telegram')`,
    ["general", memoryText]
  );

  return `Hermes đã ghi nhớ: ${memoryText}`;
}


  const isAudit = text.toLowerCase().includes("audit")    || text.toLowerCase().includes("đánh giá")    || text.toLowerCase().includes("phân tích");  const isExecute = text.toLowerCase().includes("fix")   || text.toLowerCase().includes("sửa")   || text.toLowerCase().includes("build");  const isComplex = isAudit || isExecute;




  if (intent === "repo_status") {
    if (!fs.existsSync(PROJECT_ROOT)) {
      return `Không tìm thấy repo tại: ${PROJECT_ROOT}`;
    }

    const files = fs
      .readdirSync(PROJECT_ROOT, { withFileTypes: true })
      .slice(0, 80)
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .join("\n");

    return `Repo root:\n${PROJECT_ROOT}\n\nFiles:\n${files || "(trống)"}`;
  }


  if (intent === "branch_status") {
    const current = await execAsync(`git branch --show-current`, {
      cwd: PROJECT_ROOT,
      shell: "/bin/bash",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    const branches = await execAsync(`git branch -a --sort=-committerdate | head -20`, {
      cwd: PROJECT_ROOT,
      shell: "/bin/bash",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    return [
      `Branch hiện tại: ${current.stdout.trim()}`,
      "",
      "Branches gần đây:",
      branches.stdout || branches.stderr || "",
    ].filter(Boolean).join("\n");
  }

  if (intent === "read_file") {
    const fileMatch = text.match(/xem file\s+(.+)/i);
    if (!fileMatch) return "Bạn nói theo mẫu: xem file README.md";

    const filePath = fileMatch[1].trim();
    if (!isSafePath(filePath)) return "File path không an toàn.";

    const fullPath = path.resolve(PROJECT_ROOT, filePath);
    if (!fs.existsSync(fullPath)) return `Không tìm thấy file: ${filePath}`;

    const content = fs.readFileSync(fullPath, "utf8");
    return `Nội dung ${filePath}:\n\n${content.slice(0, 3500)}`;
  }

  if (intent === "run_command") {
    const command = text.replace(/chạy lệnh/gi, "").trim();
    if (!command) return "Bạn nói theo mẫu: chạy lệnh npm run build";

    const output = await runSafeCommand(task.id, command);
    await logAction(task.id, "run_command", { command }, { output }, "success");
    return output;
  }


  if (intent === "rollback_patch") {
    const m = text.match(/\d+/);
    if (!m) return "Dùng: rollback patch <id>";

    const patchId = Number(m[0]);

    const r = await query(`select * from hermes_patches where id=$1`, [patchId]);
    if (!r.rows.length) return `Không tìm thấy patch #${patchId}`;

    const patch = r.rows[0];
    assertCanEditFile(patch.file_path);

    const fullPath = path.resolve(PROJECT_ROOT, patch.file_path);
    const backupPath = findLatestBackup(fullPath);

    if (!backupPath) {
      return `Không tìm thấy backup cho file: ${patch.file_path}`;
    }

    fs.copyFileSync(backupPath, fullPath);

    const commitMsg = `hermes: rollback patch ${patchId}`;

    const add = await execAsync(`git add ${patch.file_path}`, {
      cwd: PROJECT_ROOT,
      shell: "/bin/bash",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    const commit = await execAsync(`git commit -m "${commitMsg}"`, {
      cwd: PROJECT_ROOT,
      shell: "/bin/bash",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    const push = await execAsync(`git push`, {
      cwd: PROJECT_ROOT,
      shell: "/bin/bash",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    await query(
      `update hermes_patches set status='rolled_back' where id=$1`,
      [patchId]
    );

    return [
      `Đã rollback patch #${patchId} ✅`,
      `File: ${patch.file_path}`,
      `Backup: ${path.basename(backupPath)}`,
      `Commit: ${commitMsg}`,
      "",
      add.stdout || add.stderr || "",
      commit.stdout || commit.stderr || "",
      push.stdout || push.stderr || "",
    ].filter(Boolean).join("\n");
  }

  if (intent === "rollback_commit") {
    const match = text.match(/[a-f0-9]{7,40}/i);
    if (!match) return "Dùng: rollback commit <commit_hash>";

    const hash = match[0];

    const revert = await execAsync(`git revert --no-edit ${hash}`, {
      cwd: PROJECT_ROOT,
      shell: "/bin/bash",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    const push = await execAsync(`git push`, {
      cwd: PROJECT_ROOT,
      shell: "/bin/bash",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });

    return [
      `Đã revert commit ${hash} ✅`,
      "",
      revert.stdout || revert.stderr || "",
      push.stdout || push.stderr || "",
    ].filter(Boolean).join("\n");
  }

  if (intent === "approve_task") {
  const match = text.match(/\d+/);
  if (!match) return "Bạn cần nói: duyệt task 12";

  const targetTaskId = Number(match[0]);

  const result = await query(
    `select * from hermes_approvals
     where task_id=$1 and status='pending'
     order by id desc limit 1`,
    [targetTaskId]
  );

  const approval = result.rows[0];
  if (!approval) return `Không có approval pending cho task #${targetTaskId}`;

  await query(
    `update hermes_approvals
     set status='approved', approved_at=now()
     where id=$1`,
    [approval.id]
  );

  // 🔥 CHẠY LỆNH SAU KHI DUYỆT
  try {
    const { stdout, stderr } = await execAsync(approval.command, {
  cwd: PROJECT_ROOT,
  shell: "/bin/bash",
  timeout: 120000,
  maxBuffer: 1024 * 1024,
  env: process.env,
});

const output = [stdout, stderr].filter(Boolean).join("\n") || "Lệnh chạy xong, không có output.";
    return `Đã duyệt task #${targetTaskId} ✅\n\nĐã chạy lệnh:\n${approval.command}\n\nOutput:\n${output}`;
  } catch (err) {
    return `Đã duyệt nhưng chạy lệnh lỗi:\n${err.message}`;
  }
}  


  const memories = await loadMemories();
  const useMemory = intent === "learn" || intent === "recall_memory";

const memoryContext = useMemory
  ? (memories || "(chưa có memory)")
  : "(memory disabled for this task)";
  
  const CURRENT_HERMES_SYSTEM_CONTEXT = `
Detected Hermes system:
- worker.js uses Telegram bot to receive and return task results.
- worker.js uses PostgreSQL through query("./db").
- Existing DB tables referenced: hermes_tasks, hermes_task_events, hermes_action_logs, hermes_approvals, hermes_memories.
- worker.js has safe command execution via runSafeCommand().
- worker.js has command allowlist and dangerous command blocking.
- worker.js has protected file guard for .env, docker-compose.yml, package-lock.json, migrations, .git, node_modules.
- worker.js can inspect repo files under PROJECT_ROOT.
- gbrain.js stores and retrieves memories.
- docker-compose.yml runs app, worker, and db services.
`;



  const response = await ai.chat.completions.create({
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    reasoning_effort: "high",    extra_body: {      thinking: { type: "enabled" }    },

    messages: [
  {
    role: "system",
    content: `Bạn là Hermes — AI agent.
    
    CURRENT HERMES SYSTEM CONTEXT:
${CURRENT_HERMES_SYSTEM_CONTEXT}

RULE:
Audit only based on this detected context.
Do not say Hermes lacks DB, logging, command execution, filesystem guard, Telegram, Docker, or memory because they are detected.
If a capability is unclear, write UNKNOWN instead of MISSING.

QUAN TRỌNG:
- Nếu task là audit / phân tích / build / fix → KHÔNG dùng memory
- KHÔNG trả về insight đơn lẻ
- KHÔNG trả dạng "#1 — ..."
- LUÔN trả structured output

Nếu audit:
# HERMES AUDIT REPORT

AUDIT OUTPUT FORMAT — REQUIRED:
# HERMES AUDIT REPORT

## 1. Detected Capabilities

## 2. Real Gaps / UNKNOWN Areas

## 3. Root Cause

## 4. Priority Fix Plan
### P0 — Fix immediately
- intent router hardening
- memory gate
- prevent audit/execute from writing to gbrain
- Telegram message chunking

### P1 — Build next
- lightweight planner
- step runner with retry
- event logging standard

### P2 — Later
- health check
- backups
- auth/RBAC
- monitoring

## 5. Exact Next Patch

Nếu execute:
# EXECUTION PLAN

Memory:
${memoryContext}
`,
  },
  {
    role: "user",
    content: text,
  },
],

  });

  return response.choices?.[0]?.message?.content || "Hermes chưa tạo được câu trả lời.";
}

async function processOneTask() {
  const result = await query(
    `select * from hermes_tasks where status='pending' order by id asc limit 1`
  );

  const task = result.rows[0];
  if (!task) return;

  try {
    await query(`update hermes_tasks set status='running', updated_at=now() where id=$1`, [task.id]);
    await event(task.id, "started", "Worker started task");

    const output = await runAction(task);

    await query(
      `update hermes_tasks set status='completed', result_text=$1, updated_at=now() where id=$2`,
      [output, task.id]
    );

    await event(task.id, "completed", "Task completed");
    await sendTelegramMessage(task.telegram_chat_id, `Task #${task.id} hoàn tất:\n\n${output}`);
  } catch (err) {
    const errorText = err.response?.data ? JSON.stringify(err.response.data) : err.message;

    await query(
      `update hermes_tasks set status='failed', error_text=$1, updated_at=now() where id=$2`,
      [errorText, task.id]
    );

    await event(task.id, "failed", errorText);
    await sendTelegramMessage(task.telegram_chat_id, `Task #${task.id} bị lỗi:\n${errorText}`);
  }
}

async function loop() {
  try {
    await processOneTask();
  } catch (err) {
    console.error("Worker loop error:", err.message);
  }

  setTimeout(loop, 2000);
}

console.log("Hermes Dev Agent worker started");
loop();
