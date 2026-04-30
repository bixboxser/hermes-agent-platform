import axios from "axios";
import { Plan, Task } from "./types";

export async function syncGithubComment(task: Task): Promise<void> {
  if (!task.github_issue_id || task.status !== "done" || !task.plan) return;

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) return;

  const plan = task.plan as Plan;
  const body = `---\n✅ Task completed\n\n**Intent:** ${plan.intent}\n**Risk:** ${plan.risk_level}\n\n**Steps:**\n${plan.steps
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n")}\n\n**Result:** ${task.result ?? task.result_text ?? "(no result)"}\n---`;

  await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/issues/${task.github_issue_id}/comments`,
    { body },
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
}
