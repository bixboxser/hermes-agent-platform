const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TOOL_NAMES = [
  'company-goat',
  'contact-goat',
  'flight-goat',
  'archive-is',
  'apartments',
  'hackernews',
  'espn',
  'printing-press',
];

const TOOL_DEFINITIONS = {
  'company-goat': {
    label: 'startup/company diligence',
    keywords: ['company-goat', 'startup', 'company diligence', 'company', 'diligence', 'investor', 'market research'],
    safeSmokeCommand: 'command -v company-goat && company-goat --help | head -40',
  },
  'contact-goat': {
    label: 'contact discovery/enrichment',
    keywords: ['contact-goat', 'contact', 'email', 'lead'],
    safeSmokeCommand: 'command -v contact-goat && contact-goat --help | head -40',
  },
  'flight-goat': {
    label: 'flight search',
    keywords: ['flight-goat', 'flight', 'airfare', 'airport'],
    safeSmokeCommand: 'command -v flight-goat && flight-goat --help | head -40',
  },
  'archive-is': {
    label: 'clean markdown extraction',
    keywords: ['archive-is', 'archive', 'clean markdown', 'markdown extraction', 'extract markdown', 'article extraction'],
    safeSmokeCommand: 'command -v archive-is && archive-is --help | head -40',
  },
  apartments: {
    label: 'apartment search',
    keywords: ['apartments', 'apartment', 'rent', 'rental', 'housing'],
    safeSmokeCommand: 'command -v apartments && apartments --help | head -40',
  },
  hackernews: {
    label: 'Hacker News search/summarization',
    keywords: ['hackernews', 'hacker news', 'hn'],
    safeSmokeCommand: 'command -v hackernews && hackernews --help | head -40',
  },
  espn: {
    label: 'sports information',
    keywords: ['espn', 'sports', 'score', 'game', 'standings'],
    safeSmokeCommand: 'command -v espn && espn --help | head -40',
  },
  'printing-press': {
    label: 'publishing/formatting',
    keywords: ['printing-press', 'printing press', 'publish', 'press', 'format'],
    safeSmokeCommand: 'command -v printing-press && printing-press --help | head -40',
  },
};

function redact(text = '') {
  return String(text || '')
    .replace(/(token|apikey|api_key|authorization|password|bearer|secret)\s*[:=]?\s*[^\s]+/gi, '$1=[REDACTED]')
    .slice(0, 6000);
}

function mentionsNoRun(text = '') {
  const t = String(text || '').toLowerCase();
  return /do not run commands|không chạy lệnh|don't run commands|no commands/.test(t);
}

function routeTool(text = '') {
  const lower = String(text || '').toLowerCase();
  for (const name of TOOL_NAMES) {
    if ((TOOL_DEFINITIONS[name].keywords || []).some((keyword) => lower.includes(keyword))) {
      return { name, ...TOOL_DEFINITIONS[name] };
    }
  }
  return null;
}

function isExternalCliTask(text = '') {
  const lower = String(text || '').toLowerCase();
  return lower.includes('capability routing inventory')
    || lower.includes('remembered capability')
    || TOOL_NAMES.some((name) => lower.includes(name))
    || Boolean(routeTool(text));
}

function buildPlan(tool, commands) {
  return [
    { step: 'route_capability', tool: tool?.name || null },
    { step: 'validate_safe_allowlist', commands },
    { step: 'execute_safe_smoke_commands', commands },
    { step: 'log_action_results' },
    { step: 'reply_summary' },
  ];
}

function parseSafeRequestedCommands(text = '', routedToolName = null) {
  const lower = String(text || '').toLowerCase();
  const commands = [];
  for (const name of TOOL_NAMES) {
    if (routedToolName && name !== routedToolName) continue;
    if (lower.includes(`command -v ${name}`)) commands.push(`command -v ${name}`);
    if (lower.includes(`${name} --help | head -40`)) commands.push(`${name} --help | head -40`);
    if (lower.includes(`${name} --agent`)) commands.push(`${name} --agent`);
  }
  return [...new Set(commands)];
}

function parseAllowedSmokeCommand(command = '') {
  const trimmed = String(command || '').trim();
  let match = trimmed.match(/^command -v ([a-z0-9][a-z0-9-]*)$/);
  if (match && TOOL_NAMES.includes(match[1])) {
    return { type: 'command-v', tool: match[1] };
  }

  match = trimmed.match(/^([a-z0-9][a-z0-9-]*) --help(?: \| head -(\d{1,2}))?$/);
  if (match && TOOL_NAMES.includes(match[1])) {
    const lines = match[2] ? Number(match[2]) : 80;
    if (lines >= 1 && lines <= 80) return { type: 'help', tool: match[1], lines };
  }

  match = trimmed.match(/^([a-z0-9][a-z0-9-]*) --agent(?: \| head -(\d{1,2}))?$/);
  if (match && TOOL_NAMES.includes(match[1])) {
    const lines = match[2] ? Number(match[2]) : 80;
    if (lines >= 1 && lines <= 80) return { type: 'agent', tool: match[1], lines };
  }

  return null;
}

async function runAllowedSmokeCommand(command, options = {}) {
  const parsed = parseAllowedSmokeCommand(command);
  if (!parsed) {
    return { command, status: 'blocked', output: '', error: 'not_in_external_cli_allowlist' };
  }

  try {
    if (parsed.type === 'command-v') {
      const result = await execFileAsync('/bin/bash', ['-lc', `command -v ${parsed.tool}`], {
        timeout: options.timeout || 10000,
        maxBuffer: 128 * 1024,
        env: process.env,
      });
      return { command, status: 'completed', output: redact(result.stdout || result.stderr || '') };
    }

    const arg = parsed.type === 'help' ? '--help' : '--agent';
    const result = await execFileAsync(parsed.tool, [arg], {
      shell: false,
      timeout: options.timeout || 15000,
      maxBuffer: 256 * 1024,
      env: process.env,
    });
    const output = redact(result.stdout || result.stderr || '').split('\n').slice(0, parsed.lines).join('\n');
    return { command, status: 'completed', output };
  } catch (err) {
    const output = redact(`${err.stdout || ''}${err.stderr || ''}`.trim());
    return { command, status: 'failed', output, error: redact(err.message || 'command_failed') };
  }
}

async function logAction(query, taskId, actionName, input, output, status) {
  await query(
    `insert into hermes_action_logs (task_id, action_name, input, output, status)
     values ($1, $2, $3::jsonb, $4::jsonb, $5)`,
    [taskId, actionName, JSON.stringify(input || {}), JSON.stringify(output || {}), status],
  );
}

async function handleExternalCliTask(task, deps) {
  const text = task.input_text || '';
  if (!isExternalCliTask(text)) return null;

  const tool = routeTool(text);
  let commands = mentionsNoRun(text) ? [] : parseSafeRequestedCommands(text, tool?.name || null);
  if (!mentionsNoRun(text) && tool && commands.length === 0) {
    commands = [`command -v ${tool.name}`, `${tool.name} --help | head -40`];
  }
  const plan = buildPlan(tool, commands);

  if (!tool) {
    const summary = {
      status: 'blocked',
      output: 'No remembered capability tool matched this Telegram task.',
      tool: null,
      commands,
      plan,
    };
    await logAction(deps.query, task.id, 'external_cli_route', { text }, summary, 'blocked');
    return summary;
  }

  if (commands.length === 0) {
    const summary = {
      status: 'completed',
      output: `Recommended tool: ${tool.name} (${tool.label}). No commands were run.`,
      tool: tool.name,
      commands: [],
      plan,
    };
    await logAction(deps.query, task.id, 'external_cli_route', { text }, summary, 'completed');
    return summary;
  }

  const results = [];
  for (const command of commands) {
    const result = await runAllowedSmokeCommand(command);
    results.push(result);
    await logAction(deps.query, task.id, 'external_cli_command', { tool: tool.name, command }, result, result.status);
  }

  const summary = {
    status: results.every((r) => r.status === 'completed') ? 'completed' : 'failed',
    output: results.map((r) => `$ ${r.command}\n${r.output || r.error || r.status}`).join('\n\n'),
    tool: tool.name,
    commands,
    plan,
    results,
  };
  await logAction(deps.query, task.id, 'external_cli_route', { text, tool: tool.name, commands }, summary, summary.status);
  return summary;
}

module.exports = {
  TOOL_NAMES,
  TOOL_DEFINITIONS,
  routeTool,
  isExternalCliTask,
  parseAllowedSmokeCommand,
  parseSafeRequestedCommands,
  runAllowedSmokeCommand,
  handleExternalCliTask,
};
