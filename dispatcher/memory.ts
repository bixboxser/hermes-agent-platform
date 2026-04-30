import { logEvent } from "./events";
import { Memory, Queryable } from "./types";

async function resolveMemoryTextColumn(db: Queryable): Promise<string> {
  const res = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'hermes_memories'
       AND column_name IN ('memory_text', 'content', 'text', 'body')
     ORDER BY CASE column_name
       WHEN 'memory_text' THEN 1
       WHEN 'content' THEN 2
       WHEN 'text' THEN 3
       WHEN 'body' THEN 4
       ELSE 100 END
     LIMIT 1`,
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new Error("No supported text/content column found in hermes_memories");
  }
  return res.rows[0].column_name as string;
}

async function hasSimilarity(db: Queryable): Promise<boolean> {
  const res = await db.query(`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS enabled`);
  return Boolean(res.rows[0]?.enabled);
}

export async function recallMemories(db: Queryable, taskId: number, taskInputText: string): Promise<Memory[]> {
  const textCol = await resolveMemoryTextColumn(db);
  const similarityEnabled = await hasSimilarity(db);

  const sql = similarityEnabled
    ? `SELECT * FROM hermes_memories
       WHERE similarity(${textCol}, $1) > 0.3
       ORDER BY importance DESC NULLS LAST, created_at DESC
       LIMIT 5`
    : `SELECT * FROM hermes_memories
       WHERE ${textCol} ILIKE '%' || $1 || '%'
       ORDER BY importance DESC NULLS LAST, created_at DESC
       LIMIT 5`;

  const memories = await db.query(sql, [taskInputText]);
  await logEvent(db, taskId, "memory_loaded", `Loaded ${memories.rows.length} memories`, {
    count: memories.rows.length,
    similarityEnabled,
    text_column: textCol,
  });
  return memories.rows as Memory[];
}
