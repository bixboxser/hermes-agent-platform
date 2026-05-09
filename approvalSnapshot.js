const nodeCrypto = require('node:crypto');

function normalizeInputText(inputText) {
  return String(inputText || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}

function canonicalizeApprovalSnapshot({ taskId, payload, inputText, intent, appEnv }) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const canonical = {
    action_list: toStringArray(source.action_list),
    app_env: String(source.app_env || appEnv || 'development'),
    execution_plan: toStringArray(source.execution_plan),
    intent: String(source.intent || intent || ''),
    memory_ids_used: toStringArray(source.memory_ids_used),
    normalized_input: String(source.normalized_input || normalizeInputText(inputText)),
    risk_level: String(source.risk_level || 'unknown'),
    task_id: String(taskId),
  };
  return sortKeysDeep(canonical);
}

function hashApprovalSnapshot(canonicalPayload) {
  return nodeCrypto
    .createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(canonicalPayload)))
    .digest('hex');
}

module.exports = {
  canonicalizeApprovalSnapshot,
  hashApprovalSnapshot,
  normalizeInputText,
  sortKeysDeep,
};
