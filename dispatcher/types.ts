export type TaskStatus =
  | "pending"
  | "planned"
  | "pending_approval"
  | "approved"
  | "running"
  | "done"
  | "failed";

export interface Plan {
  intent: string;
  risk_level: "low" | "medium" | "high";
  read_first: string[];
  steps: string[];
  expected_output: string;
}

export interface Task {
  id: number;
  input_text: string;
  status: TaskStatus;
  plan: Plan | null;
  github_issue_id: number | null;
  retry_count: number;
  running_since: string | null;
  result?: string | null;
  result_text?: string | null;
}


export interface Memory {
  id: number;
  [key: string]: unknown;
}

export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}
