const axios = require("axios");
const { query } = require("./db");

async function ensureGBrainSchema() {
  await query(`
    create table if not exists gbrain_memories (
      id bigserial primary key,
      category text not null,
      title text not null,
      summary text not null,
      lesson text,
      tags text[] not null default '{}',
      confidence text not null default 'medium',
      source text not null default 'hermes',
      created_at timestamptz not null default now()
    );

    create index if not exists gbrain_memories_category_idx
      on gbrain_memories(category);

    create index if not exists gbrain_memories_created_at_idx
      on gbrain_memories(created_at desc);

  `);
 
    await query(`
    create table if not exists hermes_sessions (
      telegram_user_id bigint primary key,
      state text,
      updated_at timestamptz default now()
    );

    alter table hermes_tasks
      add column if not exists issue_url text;

    alter table hermes_tasks
      add column if not exists issue_number bigint;

    alter table hermes_tasks
      add column if not exists codex_triggered_at timestamptz;

    alter table hermes_tasks
      add column if not exists codex_trigger_comment_url text;

    alter table hermes_tasks
      add column if not exists pull_request_url text;

    alter table hermes_tasks
      add column if not exists pull_request_number bigint;

    alter table hermes_tasks
      add column if not exists pull_request_detected_at timestamptz;

    alter table hermes_approvals
      add column if not exists executed_at timestamptz;
  `);

}

function cleanJson(text) {
  return String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function callDeepSeek(prompt) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("Missing DEEPSEEK_API_KEY");
  }

  const res = await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
    }
  );

  return res.data?.choices?.[0]?.message?.content || "";
}

async function learnFromText(input, source = "telegram") {
  const text = String(input || "");
  const t = text.toLowerCase();

  // ===== 1) FILTER (chặn noise) =====
  if (
    t.includes("test") ||
    t.includes("thử") ||
    t.includes("demo") ||
    t.includes("tên người dùng") ||
    t.includes("mason") ||
    t.trim() === "hello" ||
    t.trim() === "hi"
  ) {
    return {
      title: "Bỏ qua memory (noise)",
      summary: "Không lưu vì là test/personal/misc",
      lesson: "",
      skipped: true,
    };
  }

  // ===== 2) CLASSIFY CATEGORY =====
  let category = "coding_rule";

  if (t.includes("payment") || t.includes("qr") || t.includes("payos")) {
    category = "known_bug";
  } else if (t.includes("deploy") || t.includes("vercel") || t.includes("env")) {
    category = "deployment_rule";
  } else if (t.includes("cleaner") || t.includes("ops") || t.includes("sop")) {
    category = "ops_sop";
  } else if (t.includes("booking") || t.includes("admin")) {
    category = "project_context";
  }

  // ===== 3) EXTRACT =====
  const title = text.split("\n")[0].slice(0, 120);

  const summary =
    text.length > 300 ? text.slice(0, 300) + "..." : text;

  const lesson = text;

  // ===== 4) SAVE DB =====
  const result = await query(
    `insert into gbrain_memories (title, summary, lesson, category)
     values ($1, $2, $3, $4)
     returning id, title`,
    [title, summary, lesson, category]
  );

  return {
    id: result.rows[0].id,
    title: result.rows[0].title,
    category,
  };
}

async function recallMemories(searchText) {
  const q = `%${searchText}%`;

  const result = await query(
    `select *
     from gbrain_memories
     where title ilike $1
        or summary ilike $1
        or lesson ilike $1
        or array_to_string(tags, ',') ilike $1
     order by created_at desc
     limit 8`,
    [q]
  );

  return result.rows;
}

async function runHermesDispatcher(input) {

  const lowerInput = String(input || "").toLowerCase();

  if (
    lowerInput.includes("payment") ||
    lowerInput.includes("qr") ||
    lowerInput.includes("payos") ||
    lowerInput.includes("thanh toán")
  ) {
    return {
      intent: "DEV_DEBUG",
      risk: "safe",
      memories: [],
      reply: `Nhận định nhanh:
Hermes VPS hiện chỉ có Hermes agent, chưa có context trực tiếp của app payment/homestay. Không được giả định repo, service, domain, framework hay path.

Lệnh kiểm tra an toàn trên VPS Hermes:
cd /root/hermes
docker logs hermes_app --tail 80
docker logs hermes_worker --tail 80

Prompt Codex/Cursor để debug app payment:
READ FIRST:
- app/api/payments/create/route.ts
- app/api/payments/[id]/status/route.ts
- app/payment/page.tsx
- components/payment/Payment.tsx
- lib/payments/**
- lib/payos/**
- .env.example

TASK:
Debug lỗi payment không hiển thị QR.

CHECK:
1. API create payment có trả checkoutUrl/qrPayload/qrCodeUrl không.
2. API status có trả empty string làm overwrite QR không.
3. Frontend có merge state bằng non-empty string chưa.
4. PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY có đủ chưa.
5. paymentMode có bị fallback không.

OUTPUT:
- Root cause
- Files changed
- Patch summary
- Tests run
- Risks

NEXT ACTION:
Gửi task này cho Codex trong repo app homestay, hoặc paste log API payment/create gần nhất vào Hermes.`
    };
  }

  const memories = await recallMemories(input);

  const memoryText = memories.length
    ? memories
        .map(
          (m, i) =>
            `[Memory ${i + 1}]
Title: ${m.title}
Summary: ${m.summary}
Lesson: ${m.lesson || ""}
Tags: ${(m.tags || []).join(", ")}`
        )
        .join("\n\n")
    : "Không có memory liên quan.";

  const prompt = `
Bạn là Hermes Dispatcher Agent của Mason.

PROJECT CONTEXT BẮT BUỘC:
- Hermes hiện chạy trong /root/hermes bằng Docker Compose.
- Services: hermes_app, hermes_worker, hermes_db.
- App chính: index.js.
- Worker chính: worker.js.
- DB helper: db.js.
- GBrain logic: gbrain.js.
- Không được tự bịa service như hermes-frontend, Laravel, nginx nếu user chưa nói.
- Nếu cần kiểm tra log Hermes, dùng:
  docker logs hermes_app --tail 80
  docker logs hermes_worker --tail 80
- Nếu cần restart Hermes, dùng:
  docker-compose down
  docker-compose up -d --build
- Nếu task là coding cho homestay Next.js, phải hỏi hoặc yêu cầu repo/path cụ thể, không giả định nằm trong VPS Hermes.



OUTPUT RULES:
- Không hỏi lan man.
- Luôn đưa bước tiếp theo có thể làm ngay.
- Nếu thiếu thông tin, chỉ hỏi 1 câu duy nhất.
- Không bịa file/path/service.
- Với DEV_DEBUG, output phải có:
  1. Root cause khả nghi
  2. Lệnh kiểm tra đúng môi trường
  3. Prompt Codex nếu cần
  4. NEXT ACTIONx



QUY TẮC:
- Không trả lời kiểu chatbot chung chung.
- Luôn ưu tiên context từ GBrain.
- Nếu có memory liên quan, phải nói rõ "Dựa trên GBrain".
- Nếu là lỗi code, trả về:
  1. Nhận định khả năng cao
  2. File/khu vực cần kiểm tra
  3. Prompt ngắn để đưa Codex/Cursor
  4. Bước test
- Nếu thiếu dữ liệu, chỉ hỏi tối đa 1 câu quan trọng nhất.
- Trả lời tiếng Việt, ngắn, thực dụng.

CRITICAL BEHAVIOR RULES:
- Không được hỏi nhiều câu.
- Không được trả lời kiểu support chatbot.
- Không được nói “nếu bạn cho phép”.
- Không được yêu cầu user cung cấp quá nhiều thông tin.
- Nếu thiếu context, phải tự đưa checklist kiểm tra theo môi trường đã biết.
- Chỉ hỏi tối đa 1 câu ở cuối nếu thật sự bắt buộc.
- Với lỗi dev, luôn trả:
  1. Nhận định nhanh
  2. Lệnh kiểm tra ngay
  3. Prompt Codex/Cursor nếu cần
  4. NEXT ACTION


ABSOLUTE RULES:
- Cấm dùng placeholder path như /path/to/log/file.
- Cấm hỏi checklist dài.
- Cấm hỏi quá 1 câu.
- Cấm nói “tôi cần thêm thông tin” làm câu mở đầu.
- Cấm bịa stack, service, framework, file path.
- Nếu user nói lỗi payment/QR nhưng không đưa repo/log, hãy nói rõ: Hermes VPS hiện không có app payment, chỉ có Hermes agent.
- Phải đưa hành động kiểm tra đúng môi trường hiện tại.

CURRENT VPS CONTEXT:
- Path hiện tại: /root/hermes
- Docker command: docker-compose
- Services thật: hermes_app, hermes_worker, hermes_db
- Files thật: index.js, worker.js, db.js, gbrain.js, docker-compose.yml
- Log thật:
  docker logs hermes_app --tail 80
  docker logs hermes_worker --tail 80

WHEN USER ASKS ABOUT UNKNOWN PROJECT BUG:
Output exactly:
1. Nhận định nhanh
2. Không được giả định
3. Lệnh kiểm tra an toàn
4. Prompt cho Codex/Cursor
5. NEXT ACTION

KNOWN ENVIRONMENT:
- Hermes VPS path: /root/hermes
- Docker services: hermes_app, hermes_worker, hermes_db
- Commands use docker-compose, NOT docker compose
- Main files: index.js, worker.js, db.js, gbrain.js
- Không bịa service payment/frontend nếu chưa được cung cấp.

Trả lời ngắn, quyết đoán, như operator senior. Không hỏi lan man. Không bịa đường dẫn.

GBrain liên quan:
${memoryText}

Yêu cầu user:
${input}
`;

  const reply = await callDeepSeek(prompt);

  return {
    reply,
    memories,
  };

}


async function classifyIntent(input) {   const prompt = ` Bạn là Hermes Intent Classifier.  Phân loại nội dung thành 1 intent: - DEV_DEBUG: lỗi code, terminal, bug, build fail - BUILD_PROMPT: cần prompt cho Codex/Cursor/Claude - PATCH_REVIEW: review patch, PR, files changed - DEPLOY_CHECK: deploy, Docker, Vercel, env, production - OPS_SOP: SOP, vận hành, cleaner, homestay, staff - CONTENT_REELS: TikTok, Reels, content, personal brand - GENERAL: việc khác  Chỉ trả JSON: {   "intent": "...",   "risk": "safe | needs_approval | dangerous",   "reason": "..." }  Input: ${input} `;    const raw = await callDeepSeek(prompt);   return JSON.parse(cleanJson(raw)); }  async function runDispatcher(input) {   const classified = await classifyIntent(input);   const memories = await recallMemories(input);    const memoryText = memories     .map((m, i) => {       return `[Memory ${i + 1}] Title: ${m.title} Summary: ${m.summary} Lesson: ${m.lesson || ""} Tags: ${(m.tags || []).join(", ")}`;     })     .join("\n\n");    const prompt = ` Bạn là Hermes Dispatcher Agent của Mason.  Nhiệm vụ: - Không chỉ trả lời như chatbot. - Phải đưa ra next action rõ ràng. - Ưu tiên thực tế, ngắn, làm được ngay. - Nếu là code/dev: nêu root cause, file cần kiểm tra, prompt cho Codex nếu cần. - Nếu là deploy: đưa checklist an toàn. - Nếu là ops: đưa checklist/SOP. - Nếu là content: đưa hook, script, shot list. - Không tự ý deploy/xóa DB/đổi production nếu chưa được duyệt.  Intent: ${classified.intent} Risk: ${classified.risk} Reason: ${classified.reason}  GBrain liên quan: ${memoryText || "Không có memory liên quan."}  Yêu cầu của user: ${input}  Trả lời bằng tiếng Việt. Cuối câu trả lời thêm mục: NEXT ACTION: - ... `;    const reply = await callDeepSeek(prompt);    return {     intent: classified.intent,     risk: classified.risk,     reply,     memories,   }; }


async function buildCodexPrompt(input) {
 
     const lowerInput = String(input || "").toLowerCase();

  if (
    lowerInput.includes("payment") ||
    lowerInput.includes("qr") ||
    lowerInput.includes("payos") ||
    lowerInput.includes("thanh toán")
  ) {
    return `STACK:
Next.js 15 App Router | TypeScript strict | Supabase | payOS | Vercel

READ FIRST:
- src/app/api/payments/create/route.ts
- src/app/api/payments/[id]/status/route.ts
- src/components/payment/**
- src/lib/payments/**
- src/lib/payos/**
- src/lib/booking-engine/**
- .env.example

TASK:
Debug lỗi payment không hiển thị QR / checkoutUrl trong flow payOS.

CHECK:
1. API create payment có trả checkoutUrl, qrPayload hoặc qrCodeUrl không.
2. API status/polling có trả empty string làm overwrite QR state không.
3. Frontend có merge payment state bằng non-empty string chưa.
4. PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY có đủ và chỉ dùng server-side chưa.
5. Nếu payOS chưa configured, UI có fallback/error rõ ràng không.
6. Không tạo payment duplicate khi polling.
7. Booking/payment status không bị confirm sai nếu webhook chưa xác nhận.

RULES:
- Không mở rộng scope.
- Không sửa production env.
- Không đổi booking/pricing rules.
- Không hardcode secret.
- Không deploy.
- Không refactor lớn.
- Add regression test cho QR state merge nếu có thể.

ACCEPTANCE CRITERIA:
- QR/checkoutUrl hiển thị sau khi tạo payment thành công.
- Polling không làm mất QR/checkoutUrl hợp lệ.
- Không tạo duplicate payment.
- Existing booking/payment tests vẫn pass.

OUTPUT REQUIRED:
1. Root cause
2. Files changed
3. Patch summary
4. Tests run
5. Risks / notes

NEXT ACTION:
Copy prompt này sang Codex/Cursor trong repo Somewhere app.`;
  }

   const memories = await recallMemories(input);

  const memoryText = memories
    .map((m, i) => `[Memory ${i + 1}]
Title: ${m.title}
Summary: ${m.summary}
Lesson: ${m.lesson || ""}
Tags: ${(m.tags || []).join(", ")}`)
    .join("\n\n");

  const prompt = `
Bạn là Hermes Codex Prompt Builder.

Context GBrain:
${memoryText || "Không có memory liên quan."}

User request:
${input}

Tạo prompt cho Codex/Cursor theo format sau, tiếng Việt:

STACK:
Next.js App Router | TypeScript | Supabase | Vercel | Docker where relevant

READ FIRST:
- liệt kê file/path cần đọc trước, nếu không chắc thì ghi "tìm file tương ứng"

TASK:
- mô tả task rõ ràng

RULES:
- Không mở rộng scope
- Không bịa file/path nếu chưa chắc
- Không sửa production env
- Không deploy
- Add/update test nếu phù hợp
- Giữ output ngắn, có root cause

ACCEPTANCE CRITERIA:
- ...

OUTPUT REQUIRED:
1. Root cause
2. Files changed
3. Patch summary
4. Tests run
5. Risks / notes

NEXT ACTION:
Copy prompt này sang Codex/Cursor.
`;

  return callDeepSeek(prompt);
}

async function reviewCodexResult(input) {

    const lowerInput = String(input || "").toLowerCase();

  if (
    lowerInput.includes("payment") ||
    lowerInput.includes("qr") ||
    lowerInput.includes("payos") ||
    lowerInput.includes("checkouturl") ||
    lowerInput.includes("qrpayload")
  ) {
    return `VERDICT:
NEEDS MANUAL CHECK

NHẬN ĐỊNH NHANH:
Đây là patch liên quan payment/payOS/QR nên không được approve chỉ dựa trên summary. Cần xác minh API create payment, polling status và frontend state merge.

CHECKLIST REVIEW:
1. Có sửa đúng các file payment liên quan không:
- src/app/api/payments/create/route.ts
- src/app/api/payments/[id]/status/route.ts
- src/components/payment/**
- src/lib/payments/**
- src/lib/payos/**

2. Có xử lý non-empty merge chưa:
- Không overwrite checkoutUrl/qrPayload hợp lệ bằng empty string/null/undefined từ polling.

3. Có tránh duplicate payment chưa:
- Polling/status không tạo payment mới.
- create payment không bị gọi lặp ngoài ý muốn.

4. Có bảo vệ secret chưa:
- PAYOS_API_KEY và PAYOS_CHECKSUM_KEY không expose client-side.
- Không hardcode secret.

5. Có test/regression chưa:
- Test QR state merge.
- Test API response có checkoutUrl/qrPayload.
- Test fallback khi payOS chưa configured.

RỦI RO:
- QR hiện nhưng payment status/webhook confirm sai.
- Fix frontend nhưng API vẫn trả thiếu checkoutUrl/qrPayload.
- Lộ secret payOS nếu move env/client sai.
- Duplicate payment nếu polling/create flow bị lẫn.

CÓ NÊN APPROVE KHÔNG:
NO, trừ khi Codex đã chứng minh tests pass và có root cause rõ ràng.

LESSON NÊN LƯU VÀO GBRAIN:
- category: known_bug
- title: Payment QR cần bảo vệ checkoutUrl/qrPayload khi polling
- summary: Với payOS, QR có thể mất nếu response polling/status trả empty string và frontend overwrite state hợp lệ.
- lesson: Khi merge payment state, chỉ overwrite checkoutUrl/qrPayload bằng non-empty string và không tạo payment mới trong polling.
- tags: payment, payos, qr, polling, checkoutUrl

NEXT ACTION:
Yêu cầu Codex bổ sung test QR state merge và paste phần Tests run trước khi approve.`;
  }

  const prompt = `
Bạn là Hermes Patch Reviewer.

Review kết quả Codex/Cursor dưới đây.

Yêu cầu output tiếng Việt, format cố định:

VERDICT:
PASS | NEEDS FIX | REJECT

NHẬN ĐỊNH NHANH:
...

RỦI RO:
- ...

TEST THIẾU:
- ...

CÓ NÊN APPROVE KHÔNG:
YES | NO

LESSON NÊN LƯU VÀO GBRAIN:
- category:
- title:
- summary:
- lesson:
- tags:

NEXT ACTION:
...

Kết quả cần review:
${input}
`;

  return callDeepSeek(prompt);
}


async function buildAudit(input) {

    const lowerInput = String(input || "").toLowerCase();

  if (
    lowerInput.includes("payment") ||
    lowerInput.includes("qr") ||
    lowerInput.includes("payos") ||
    lowerInput.includes("thanh toán")
  ) {
    return `NHẬN ĐỊNH NHANH:
Đây là lỗi payment QR trong flow payOS của Somewhere. Khả năng cao nằm ở 1 trong 3 điểm: API create payment không trả checkoutUrl/qrPayload, API status/polling trả empty string làm mất QR, hoặc frontend merge state sai.

ROOT CAUSE KHẢ NGHI:
- API create payment không trả checkoutUrl/qrPayload/qrCodeUrl.
- Polling status overwrite checkoutUrl/qrPayload hợp lệ bằng empty string/null.
- Frontend chỉ render QR theo field sai.
- payOS env thiếu PAYOS_CLIENT_ID/PAYOS_API_KEY/PAYOS_CHECKSUM_KEY.
- paymentMode fallback nhưng UI không báo lỗi rõ.
- create payment bị gọi lặp gây duplicate payment/hold.

CẦN KIỂM TRA:
- src/app/api/payments/create/route.ts
- src/app/api/payments/[id]/status/route.ts
- src/components/payment/**
- src/lib/payments/**
- src/lib/payos/**
- .env.example

LỆNH KIỂM TRA AN TOÀN:
- Kiểm tra health/payment mode nếu có endpoint:
  curl -s https://DOMAIN/api/health
- Kiểm tra log app trên Vercel hoặc local terminal.
- Không in secret PAYOS_* ra chat/log.

PROMPT CODEX/CURSOR:
\`\`\`txt
STACK:
Next.js 15 App Router | TypeScript strict | Supabase | payOS | Vercel

READ FIRST:
- src/app/api/payments/create/route.ts
- src/app/api/payments/[id]/status/route.ts
- src/components/payment/**
- src/lib/payments/**
- src/lib/payos/**
- .env.example

TASK:
Audit và fix lỗi payment không hiển thị QR / checkoutUrl trong flow payOS.

CHECK:
1. API create payment có trả checkoutUrl, qrPayload hoặc qrCodeUrl không.
2. API status/polling có trả empty string làm overwrite QR state không.
3. Frontend có merge payment state bằng non-empty string chưa.
4. PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY chỉ dùng server-side chưa.
5. Nếu payOS chưa configured, UI có fallback/error rõ ràng không.
6. Không tạo duplicate payment khi polling.

RULES:
- Không mở rộng scope.
- Không sửa production env.
- Không đổi booking/pricing rules.
- Không hardcode secret.
- Không deploy.
- Add regression test cho QR state merge nếu có thể.

OUTPUT REQUIRED:
1. Root cause
2. Files changed
3. Patch summary
4. Tests run
5. Risks / notes
\`\`\`

NEXT ACTION:
Copy prompt trên sang Codex/Cursor trong repo Somewhere app.`;
  }

  const memories = await recallMemories(input);

  const memoryText = memories
    .map((m, i) => `[Memory ${i + 1}]
Title: ${m.title}
Summary: ${m.summary}
Lesson: ${m.lesson || ""}
Tags: ${(m.tags || []).join(", ")}`)
    .join("\n\n");

  const prompt = `
Bạn là Hermes Audit Agent.

GBrain liên quan:
${memoryText || "Không có memory liên quan."}

Yêu cầu audit:
${input}

Trả lời tiếng Việt theo format:

NHẬN ĐỊNH NHANH:
...

ROOT CAUSE KHẢ NGHI:
- ...

CẦN KIỂM TRA:
- ...

PROMPT CODEX/CURSOR:
\`\`\`txt
STACK:
...

READ FIRST:
- ...

TASK:
...

RULES:
- Không mở rộng scope
- Không deploy
- Không sửa production env
- Add/update test nếu phù hợp

OUTPUT REQUIRED:
1. Root cause
2. Files changed
3. Patch summary
4. Tests run
5. Risks / notes
\`\`\`

NEXT ACTION:
...
`;

  return callDeepSeek(prompt);
}

async function buildDeployCheck(input) {
  const lowerInput = String(input || "").toLowerCase();

  if (
    lowerInput.includes("payment") ||
    lowerInput.includes("qr") ||
    lowerInput.includes("payos") ||
    lowerInput.includes("thanh toán") ||
    lowerInput.includes("vercel") ||
    lowerInput.includes("deploy")
  ) {
    return `DEPLOY VERDICT:
NEEDS CHECK

NHẬN ĐỊNH NHANH:
Deploy liên quan Somewhere payment/payOS/QR là vùng rủi ro cao. Chỉ deploy khi đã có root cause rõ, test pass, không lộ secret, không đổi booking/pricing rules.

CHECKLIST BẮT BUỘC:
1. Code/branch:
- Đang ở đúng branch fix.
- Diff chỉ nằm trong phạm vi payment/payOS/frontend QR.
- Không có thay đổi ngoài scope booking/pricing/admin nếu không cần.

2. Build/test:
- npm run lint
- npm run build
- chạy test liên quan payment nếu có.
- nếu có test mới cho QR state merge thì càng tốt.

3. payOS/env:
- Chỉ kiểm tra tên biến, KHÔNG in giá trị secret.
- Vercel phải có:
  PAYOS_CLIENT_ID
  PAYOS_API_KEY
  PAYOS_CHECKSUM_KEY
- Không expose PAYOS_API_KEY/PAYOS_CHECKSUM_KEY ra client.
- NEXT_PUBLIC_* chỉ dùng cho biến public thật sự.

4. API/payment:
- src/app/api/payments/create/route.ts trả checkoutUrl/qrPayload/qrCodeUrl đúng.
- src/app/api/payments/[id]/status/route.ts không trả empty string làm mất QR.
- Polling không tạo duplicate payment.
- Webhook là nguồn confirm payment cuối cùng.

5. Frontend:
- QR/checkoutUrl không bị overwrite bằng empty string/null.
- UI có fallback rõ khi payOS chưa configured.
- Không loop tạo payment nhiều lần.

6. Rollback:
- Có thể rollback Vercel về deployment trước đó.
- Không chạy migration phá dữ liệu nếu chưa kiểm tra.

LỆNH KIỂM TRA AN TOÀN:
\`\`\`bash
# kiểm tra branch + diff
git branch --show-current
git status --short
git diff --name-only

# build/test local
npm run lint
npm run build

# tìm code liên quan payment, không in secret
grep -R "PAYOS_" -n src .env.example 2>/dev/null
grep -R "checkoutUrl\\|qrPayload\\|qrCodeUrl" -n src 2>/dev/null

# nếu có health endpoint production
curl -s https://somewhere-sanctuary-hub-main-final.vercel.app/api/health
\`\`\`

KHÔNG ĐƯỢC CHẠY:
\`\`\`bash
cat .env.production
printenv | grep PAYOS
echo $PAYOS_API_KEY
\`\`\`

RỦI RO:
- QR hiện nhưng webhook/payment_status sai.
- Fix frontend nhưng API create/status vẫn trả thiếu checkoutUrl/qrPayload.
- Lộ secret payOS nếu dùng sai NEXT_PUBLIC.
- Duplicate payment nếu create/polling flow bị gọi lặp.
- Deploy nhầm branch hoặc deploy khi chưa build pass.

NEXT ACTION:
Chỉ deploy sau khi Codex/dev cung cấp:
1. Root cause
2. Files changed
3. Tests run
4. Build pass
5. Xác nhận không expose secret`;
  }

  const prompt = `
Bạn là Hermes Deploy Check Agent cho project Somewhere.

Project context:
- Next.js 15 App Router
- TypeScript strict
- Supabase
- payOS
- Vercel
- Không dùng Prisma trừ khi user nói rõ
- Không bịa endpoint/path
- Không in secret env

User request:
${input}

Trả lời theo format:
DEPLOY VERDICT:
PASS | NEEDS CHECK | BLOCKED

NHẬN ĐỊNH NHANH:
...

CHECKLIST BẮT BUỘC:
- ...

LỆNH KIỂM TRA AN TOÀN:
\`\`\`bash
...
\`\`\`

KHÔNG ĐƯỢC CHẠY:
\`\`\`bash
...
\`\`\`

RỦI RO:
- ...

NEXT ACTION:
...
`;

  return callDeepSeek(prompt);
}


module.exports = {
  ensureGBrainSchema,
  learnFromText,
  recallMemories,
  classifyIntent,
  runDispatcher,
  buildCodexPrompt,
  reviewCodexResult,
  buildAudit,
  buildDeployCheck, 
};
