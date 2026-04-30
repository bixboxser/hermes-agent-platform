const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function runGate(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return { status: 'passed', checks: [] };
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const scripts = pkg.scripts || {};

  const checks = [
    ['lint', 'npm run lint'],
    ['typecheck', 'npm run typecheck'],
    ['test', 'npm run test'],
    ['build', 'npm run build'],
  ];

  const results = [];
  for (const [name, cmd] of checks) {
    if (!scripts[name] && !(name === 'test' && scripts.test) && !(name === 'build' && scripts.build)) {
      results.push({ name, status: 'skipped' });
      continue;
    }
    try {
      await execAsync(cmd, { cwd: projectRoot, shell: '/bin/bash', timeout: 600000, maxBuffer: 1024 * 1024 * 8 });
      results.push({ name, status: 'passed' });
    } catch (e) {
      results.push({ name, status: 'failed', error: e.stderr || e.stdout || e.message });
    }
  }

  const failed = results.some((r) => r.status === 'failed');
  return { status: failed ? 'PATCH DONE BUT GATE FAILED' : 'PATCH DONE AND GATE PASSED', checks: results };
}

module.exports = { runGate };
