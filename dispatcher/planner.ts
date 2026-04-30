import OpenAI from "openai";
import { normalizeError } from "./errors";
import { logEvent } from "./events";
import { validateTransition } from "./fsm";
import { Plan, Queryable, Task } from "./types";

const DEPLOYMENT_KEYWORDS = ["git push", "docker", "db write", "migration", "production"];
const CODE_CHANGE_KEYWORDS = ["refactor", "fix", "implement", "update", "change", "edit", "add", "remove", "code", "typescript", "javascript", "test", "build", "lint", "typecheck"];

function deterministicRisk(input: string): Plan["risk_level"] {
  const lower = input.toLowerCase();
  if (DEPLOYMENT_KEYWORDS.some((k) => lower.includes(k))) return "high";
  if (CODE_CHANGE_KEYWORDS.some((k) => lower.includes(k))) return "medium";
  return "low";
}

export async function planTask(db: Queryable, task: Task, memoryContext: string): Promise<Plan> {
  try {
    const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `Task: ${task.input_text}\n\nMemory context:\n${memoryContext || "(none)"}\n\nReturn JSON with keys: intent, read_first, steps, expected_output.`;

    const completion = await ai.chat.completions.create({
      model: process.env.HERMES_PLANNER_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    const plan: Plan = {
      intent: String(parsed.intent ?? "Execute requested task"),
      risk_level: deterministicRisk(task.input_text),
      read_first: Array.isArray(parsed.read_first) ? parsed.read_first.map(String) : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : [],
      expected_output: String(parsed.expected_output ?? "Task completed with verifiable output"),
    };

    await db.query("BEGIN");
    try {
      validateTransition(task.status, "planned");
      const upd = await db.query(`UPDATE hermes_tasks SET plan = $1::jsonb, status = 'planned' WHERE id = $2 AND status = $3`, [JSON.stringify(plan), task.id, task.status]);
      if ((upd.rowCount ?? 0) === 0) throw new Error("Race condition while setting planned status");
      await logEvent(db, task.id, "plan_created", "Task plan generated", { risk_level: plan.risk_level });
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }

    return plan;
  } catch (error) {
    const normalized = normalizeError(error);
    await logEvent(db, task.id, "planning_failed", "Planning failed", { error: normalized });
    throw error;
  }
}
