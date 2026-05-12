const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../db');

const execFileAsync = promisify(execFile);

const DEFAULT_LOG_LINES = 80;
const MAX_LOG_LINES = 200;
const HOST_CONTAINERS = {
  app: 'hermes_app',
  worker: 'hermes_worker',
};
const DOCKER_PS_CONTAINERS = ['hermes_app', 'hermes_worker', 'hermes_db'];
const HOST_COMMAND_TIMEOUT_MS = 8000;
const HOST_COMMAND_MAX_BUFFER = 512 * 1024;
const DB_UNAVAILABLE_MESSAGE = 'psql is host/operator tool required; DB status unavailable from container.';
const DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE = 'Docker host diagnostics unavailable from this container. docker CLI is not installed and no safe host wrapper is configured.';

const BLOCKED_COMMAND_PATTERNS = [
  /docker-compose\s+down/i,
  /docker\s+compose\s+down/i,
  /docker\s+volume\s+rm/i,
  /docker\s+rm\b/i,
  /docker\s+rmi\b/i,
  /rm\s+-rf/i,
  /\bDROP\b/i,
  /\bDELETE\b/i,
  /\bUPDATE\b/i,
  /\bINSERT\b/i,
  /\bALTER\b/i,
  /\bTRUNCATE\b/i,
  /git\s+reset\b/i,
  /git\s+checkout\b/i,
  /git\s+pull\b/i,
  /git\s+push\b/i,
  /git\s+merge\b/i,
];

function redactSensitiveText(text = '') {
  let redacted = String(text || '');

  redacted = redacted.replace(
    /\b(TELEGRAM_BOT_TOKEN|TELEGRAM_TOKEN|DEEPSEEK_API_KEY|DATABASE_URL|GH_TOKEN|GITHUB_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)\b\s*[:=]\s*([^\s'"`]+)/gi,
    '$1=[REDACTED]',
  );
  redacted = redacted.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, 'postgres://[REDACTED]');
  redacted = redacted.replace(/https?:\/\/([^:\s'"`/@]+):([^@\s'"`]+)@/gi, 'https://[REDACTED]@');
  redacted = redacted.replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]');
  redacted = redacted.replace(/\b(token|api[_-]?key|apikey|authorization|password|passwd|pwd|secret|bearer|key)\b\s*[:=]\s*(?:Bearer\s+)?([^\s'"`]+)/gi, '$1=[REDACTED]');
  redacted = redacted.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]');
  redacted = redacted.replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TOKEN]');

  return redacted;
}

function parseLogLineLimit(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_LINES;
  return Math.min(parsed, MAX_LOG_LINES);
}

function assertNoBlockedCommand(commandText) {
  const candidate = Array.isArray(commandText) ? commandText.join(' ') : String(commandText || '');
  const blocked = BLOCKED_COMMAND_PATTERNS.find((pattern) => pattern.test(candidate));
  if (blocked) {
    const err = new Error('host_readonly_command_blocked');
    err.code = 'host_readonly_command_blocked';
    err.pattern = String(blocked);
    throw err;
  }
  return true;
}

function commandToText(file, args = []) {
  return [file, ...args].join(' ');
}

function buildDockerPsCommand() {
  const args = [
    'ps',
    '--filter', 'name=^/hermes_app$',
    '--filter', 'name=^/hermes_worker$',
    '--filter', 'name=^/hermes_db$',
    '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}',
  ];
  assertNoBlockedCommand(commandToText('docker', args));
  return { file: 'docker', args, label: 'docker ps hermes containers' };
}

function buildDockerLogsCommand(target, lineValue) {
  if (!Object.prototype.hasOwnProperty.call(HOST_CONTAINERS, target)) {
    throw new Error('invalid_host_logs_target');
  }
  const lines = parseLogLineLimit(lineValue);
  const args = ['logs', `--tail=${lines}`, HOST_CONTAINERS[target]];
  assertNoBlockedCommand(commandToText('docker', args));
  return { file: 'docker', args, label: `docker logs ${HOST_CONTAINERS[target]} --tail=${lines}`, lines, container: HOST_CONTAINERS[target] };
}

function buildGitStatusCommands() {
  const commands = [
    { file: 'git', args: ['status', '--short'], label: 'git status --short' },
    { file: 'git', args: ['log', '--oneline', '--decorate', '-5'], label: 'git log --oneline --decorate -5' },
  ];
  for (const command of commands) assertNoBlockedCommand(commandToText(command.file, command.args));
  return commands;
}

function isMissingDockerCliError(command, err = {}) {
  if (command?.file !== 'docker') return false;
  const detail = [err.code, err.errno, err.syscall, err.path, err.message, err.stderr]
    .filter(Boolean)
    .join(' ');
  return /\bENOENT\b/i.test(detail) || /spawn\s+docker\s+ENOENT/i.test(detail);
}

async function runReadOnlyCommand(command, options = {}) {
  assertNoBlockedCommand(commandToText(command.file, command.args));
  const execFileFn = options.execFileFn || execFileAsync;
  try {
    const result = await execFileFn(command.file, command.args, {
      cwd: options.cwd || process.cwd(),
      shell: false,
      timeout: options.timeout || HOST_COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || HOST_COMMAND_MAX_BUFFER,
      env: process.env,
    });
    return { ok: true, stdout: redactSensitiveText(result.stdout || ''), stderr: redactSensitiveText(result.stderr || '') };
  } catch (err) {
    if (isMissingDockerCliError(command, err)) {
      return {
        ok: false,
        stdout: '',
        stderr: DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE,
        unavailableReason: 'docker_cli_missing',
      };
    }
    return {
      ok: false,
      stdout: redactSensitiveText(err.stdout || ''),
      stderr: redactSensitiveText(err.stderr || err.message || 'command_failed'),
    };
  }
}

function fetchLocalHealth(options = {}) {
  if (options.healthFetcher) return options.healthFetcher();
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3000/health', { timeout: 4000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, data: JSON.parse(body) });
        } catch (err) {
          resolve({ ok: false, statusCode: res.statusCode, error: err.message, raw: body });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('health_request_timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function formatHostHealth(healthResult) {
  const health = healthResult?.data || healthResult || {};
  const queue = health.queue || {};
  const warnings = Array.isArray(health.warnings) ? health.warnings : [];
  return redactSensitiveText([
    'Host Health (read-only)',
    `- status: ${health.status || (healthResult?.ok ? 'ok' : 'unknown')}`,
    `- db.ok: ${health.db?.ok === true ? 'true' : 'false'}`,
    `- worker.alive: ${health.worker?.alive === true ? 'true' : 'false'}`,
    `- queue.pending: ${queue.pending || 0}`,
    `- queue.pending_approval: ${queue.pending_approval || 0}`,
    `- queue.running: ${queue.running || 0}`,
    `- queue.stuck_running: ${queue.stuck_running || 0}`,
    `- warnings: ${warnings.length ? warnings.slice(0, 5).join('; ') : 'none'}`,
  ].join('\n'));
}

function isDockerDiagnosticsUnavailable(result = {}) {
  return result.unavailableReason === 'docker_cli_missing'
    || result.stderr === DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE;
}

function formatDockerPsOutput(result) {
  if (isDockerDiagnosticsUnavailable(result)) return DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE;
  if (!result.ok) return `Host docker-ps (read-only)\n- unavailable: ${redactSensitiveText(result.stderr || 'docker ps failed')}`;
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  if (!lines.length) return 'Host docker-ps (read-only)\n- no hermes containers found';
  const rows = lines.map((line) => {
    const [name = '-', status = '-', image = '-', ports = '-'] = line.split('\t');
    return `- ${name}: ${status} | image=${image || '-'} | ports=${ports || '-'}`;
  });
  return redactSensitiveText(['Host docker-ps (read-only)', ...rows].join('\n'));
}

function formatLogsOutput(target, command, result) {
  if (isDockerDiagnosticsUnavailable(result)) return DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE;
  const header = `Host logs ${target} (read-only, tail=${command.lines})`;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (!result.ok && !output) return `${header}\n- unavailable: docker logs failed`;
  return redactSensitiveText(`${header}\n${output || '- no log output'}`).slice(0, 3500);
}

function formatGitStatusOutput(results) {
  const [status, log] = results;
  return redactSensitiveText([
    'Host git-status (read-only)',
    '$ git status --short',
    status.ok ? (status.stdout.trim() || '(clean)') : `unavailable: ${status.stderr || 'git status failed'}`,
    '',
    '$ git log --oneline --decorate -5',
    log.ok ? (log.stdout.trim() || '(no commits)') : `unavailable: ${log.stderr || 'git log failed'}`,
  ].join('\n')).slice(0, 3500);
}

async function buildDbStatusMessage(options = {}) {
  const queryFn = options.queryFn || query;
  if (!process.env.DATABASE_URL && !options.queryFn) return DB_UNAVAILABLE_MESSAGE;
  const output = ['Host DB status (read-only)'];
  try {
    const now = await queryFn('SELECT now();');
    output.push(`- now: ${now.rows?.[0]?.now ? new Date(now.rows[0].now).toISOString() : '-'}`);

    const counts = await queryFn('SELECT status, COUNT(*)::int AS count FROM hermes_tasks GROUP BY status ORDER BY status;');
    const countRows = counts.rows || [];
    output.push('- task status counts:');
    output.push(...(countRows.length ? countRows.map((row) => `  - ${row.status}: ${row.count}`) : ['  - none: 0']));

    const table = await queryFn("SELECT to_regclass('public.hermes_worker_status') AS table_name;");
    if (table.rows?.[0]?.table_name) {
      const workers = await queryFn('SELECT worker_id,last_heartbeat_at,status FROM hermes_worker_status ORDER BY last_heartbeat_at DESC LIMIT 3;');
      output.push('- worker heartbeat:');
      output.push(...((workers.rows || []).length ? workers.rows.map((row) => `  - ${row.worker_id || '-'} ${row.status || '-'} ${row.last_heartbeat_at ? new Date(row.last_heartbeat_at).toISOString() : '-'}`) : ['  - none']));
    } else {
      output.push('- worker heartbeat: hermes_worker_status table not found');
    }
  } catch (err) {
    return `${DB_UNAVAILABLE_MESSAGE}\n- detail: ${redactSensitiveText(err.message || 'query failed')}`;
  }
  return redactSensitiveText(output.join('\n')).slice(0, 3500);
}

function isHostCommand(text = '') {
  return /^\/host(?:@\w+)?(?:\s|$)/i.test(String(text || '').trim());
}

function isOperatorAuthorized(userId, allowedUserIds = []) {
  return allowedUserIds.map(Number).includes(Number(userId));
}

async function buildHostCommandReply(text, options = {}) {
  const input = String(text || '').trim();
  const allowedUserIds = options.allowedUserIds || [];
  if (!isOperatorAuthorized(options.userId, allowedUserIds)) {
    return 'Operator authorization required for /host commands.';
  }

  if (/^\/host(?:@\w+)?\s+health$/i.test(input)) {
    return formatHostHealth(await fetchLocalHealth(options));
  }

  if (/^\/host(?:@\w+)?\s+docker-ps$/i.test(input)) {
    const command = buildDockerPsCommand();
    return formatDockerPsOutput(await runReadOnlyCommand(command, options));
  }

  const logsMatch = input.match(/^\/host(?:@\w+)?\s+logs\s+(\S+)(?:\s+(\S+))?$/i);
  if (logsMatch) {
    const target = String(logsMatch[1] || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(HOST_CONTAINERS, target)) {
      return 'Dùng: /host logs app [lines] hoặc /host logs worker [lines]';
    }
    const command = buildDockerLogsCommand(target, logsMatch[2]);
    return formatLogsOutput(target, command, await runReadOnlyCommand(command, options));
  }

  if (/^\/host(?:@\w+)?\s+db-status$/i.test(input)) {
    return buildDbStatusMessage(options);
  }

  if (/^\/host(?:@\w+)?\s+git-status$/i.test(input)) {
    const commands = buildGitStatusCommands();
    const results = [];
    for (const command of commands) results.push(await runReadOnlyCommand(command, { ...options, cwd: options.repoRoot || process.cwd() }));
    return formatGitStatusOutput(results);
  }

  return 'Dùng: /host health | docker-ps | logs app [lines] | logs worker [lines] | db-status | git-status';
}

module.exports = {
  BLOCKED_COMMAND_PATTERNS,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  DB_UNAVAILABLE_MESSAGE,
  DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE,
  redactSensitiveText,
  parseLogLineLimit,
  assertNoBlockedCommand,
  buildDockerPsCommand,
  buildDockerLogsCommand,
  buildGitStatusCommands,
  buildDbStatusMessage,
  runReadOnlyCommand,
  buildHostCommandReply,
  isHostCommand,
  isOperatorAuthorized,
};
