const destructivePatterns = [
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\btruncate\b/i,
  /\bgit\s+push\b/i,
  /\bdocker\s+rm\b/i,
  /\bdocker\s+down\b/i,
];

const writePatterns = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bgit\s+commit\b/i,
];

const readOnlyPatterns = [
  /^\s*select\b/i,
  /^\s*get\b/i,
  /^\s*ls\b/i,
  /^\s*cat\b/i,
  /^\s*git\s+status\b/i,
  /^\s*git\s+log\b/i,
];

function classifyCommand(cmd = "") {
  const command = String(cmd).trim();

  if (destructivePatterns.some((p) => p.test(command))) return "destructive";
  if (writePatterns.some((p) => p.test(command))) return "write";
  if (readOnlyPatterns.some((p) => p.test(command))) return "read-only";
  return "unknown";
}

function checkCommand(cmd, env = "development") {
  const kind = classifyCommand(cmd);

  if (env === "development") {
    if (kind === "destructive") {
      return { allowed: false, requiresApproval: false, reason: "[command] destructive_blocked_development" };
    }
    return { allowed: true, requiresApproval: false, reason: `[command] allowed_${kind}` };
  }

  if (env === "staging") {
    if (kind === "destructive") {
      return { allowed: true, requiresApproval: true, reason: "[command] destructive_requires_approval_staging" };
    }
    return { allowed: true, requiresApproval: false, reason: `[command] allowed_${kind}` };
  }

  if (env === "production") {
    if (kind === "read-only") {
      return { allowed: true, requiresApproval: false, reason: "[command] read_only_allowed_production" };
    }

    if (kind === "write" || kind === "destructive") {
      return { allowed: true, requiresApproval: true, reason: `[command] ${kind}_requires_approval_production` };
    }

    return { allowed: false, requiresApproval: false, reason: "[command] unknown_blocked_production" };
  }

  return { allowed: false, requiresApproval: false, reason: "[command] invalid_env" };
}

module.exports = { checkCommand };
