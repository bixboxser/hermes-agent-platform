const SAFE_PATTERNS = [
  /^ls(\s|$)/,
  /^cat(\s|$)/,
  /^grep(\s|$)/,
  /^git status(\s|$)/,
  /^git diff(\s|$)/,
  /^npm (test|run test|run build|build)(\s|$)/,
];

const RISKY_PATTERNS = [
  /^git commit(\s|$)/,
  /^npm install(\s|$)/,
  /^docker restart(\s|$)/,
];

const DANGEROUS_PATTERNS = [
  /^rm(\s|$)/,
  /^git reset --hard(\s|$)/,
  /^docker down(\s|$)/,
  /\bmigration\b/,
  /^git push(\s|$)/,
];

function classifyCommand(command) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return { allowed: false, riskLevel: 'unknown', reason: 'empty command' };
  if (DANGEROUS_PATTERNS.some((p) => p.test(cmd))) return { allowed: true, riskLevel: 'dangerous' };
  if (RISKY_PATTERNS.some((p) => p.test(cmd))) return { allowed: true, riskLevel: 'risky' };
  if (SAFE_PATTERNS.some((p) => p.test(cmd))) return { allowed: true, riskLevel: 'safe' };
  return { allowed: false, riskLevel: 'unknown', reason: 'unknown command' };
}

function shouldRequireApproval(command, envName) {
  const c = classifyCommand(command);
  if (!c.allowed) return { ...c, requiresApproval: false };
  const isProd = envName === 'prod';
  if (c.riskLevel === 'dangerous') return { ...c, requiresApproval: true };
  if (c.riskLevel === 'risky' && isProd) return { ...c, requiresApproval: true };
  return { ...c, requiresApproval: false };
}

module.exports = { classifyCommand, shouldRequireApproval };
