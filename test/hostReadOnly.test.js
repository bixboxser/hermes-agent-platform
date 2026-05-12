process.env.DISABLE_TELEGRAM = 'true';
process.env.APP_ENV = process.env.APP_ENV || 'staging';
process.env.PROJECT_ROOT_PROD = process.env.PROJECT_ROOT_PROD || '/tmp/hermes-prod-root-for-tests';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/hermes';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDockerLogsCommand,
  buildDockerPsCommand,
  buildGitStatusCommands,
  buildHostCommandReply,
  DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE,
  assertNoBlockedCommand,
  isHostCommand,
  redactSensitiveText,
} = require('../dispatcher/hostReadOnly');
const { isTaskLikeTelegramInput } = require('../index');

const operatorOptions = {
  userId: 42,
  allowedUserIds: [42],
};

function missingDockerError() {
  const err = new Error('spawn docker ENOENT');
  err.code = 'ENOENT';
  err.syscall = 'spawn docker';
  err.path = 'docker';
  return err;
}

test('/host health is recognized for early routing before task creation', async () => {
  assert.equal(isHostCommand('/host health'), true);
  assert.equal(isTaskLikeTelegramInput('/host health'), false);
  const reply = await buildHostCommandReply('/host health', {
    ...operatorOptions,
    healthFetcher: async () => ({
      ok: true,
      data: {
        status: 'ok',
        db: { ok: true },
        worker: { alive: true },
        queue: { pending: 1, pending_approval: 2, running: 3, stuck_running: 4 },
        warnings: ['sample warning'],
      },
    }),
  });
  assert.match(reply, /Host Health \(read-only\)/);
  assert.match(reply, /status: ok/);
  assert.match(reply, /db\.ok: true/);
  assert.match(reply, /worker\.alive: true/);
  assert.match(reply, /queue\.pending: 1/);
  assert.match(reply, /queue\.pending_approval: 2/);
  assert.match(reply, /queue\.running: 3/);
  assert.match(reply, /queue\.stuck_running: 4/);
  assert.match(reply, /sample warning/);
});

test('/host docker-ps returns safe unavailable message when docker CLI is missing', async () => {
  const seen = [];
  const reply = await buildHostCommandReply('/host docker-ps', {
    ...operatorOptions,
    execFileFn: async (file, args) => {
      seen.push([file, args]);
      throw missingDockerError();
    },
  });

  assert.equal(reply, DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE);
  assert.deepEqual(seen, [[buildDockerPsCommand().file, buildDockerPsCommand().args]]);
});

test('/host logs app and worker return safe unavailable message when docker CLI is missing', async () => {
  for (const target of ['app', 'worker']) {
    const reply = await buildHostCommandReply(`/host logs ${target} 80`, {
      ...operatorOptions,
      execFileFn: async () => {
        throw missingDockerError();
      },
    });

    assert.equal(reply, DOCKER_HOST_DIAGNOSTICS_UNAVAILABLE_MESSAGE);
  }
});

test('raw spawn docker ENOENT is not exposed to Telegram /host replies', async () => {
  for (const command of ['/host docker-ps', '/host logs app 80', '/host logs worker 80']) {
    const reply = await buildHostCommandReply(command, {
      ...operatorOptions,
      execFileFn: async () => {
        throw missingDockerError();
      },
    });

    assert.doesNotMatch(reply, /spawn docker ENOENT|ENOENT/);
    assert.match(reply, /Docker host diagnostics unavailable from this container/);
  }
});

test('/host docker-ps uses allowlisted docker ps command only', () => {
  const command = buildDockerPsCommand();
  assert.equal(command.file, 'docker');
  assert.deepEqual(command.args.slice(0, 1), ['ps']);
  assert.equal(command.args.includes('down'), false);
  assert.equal(command.args.includes('rm'), false);
  assert.equal(command.args.includes('rmi'), false);
  assert.doesNotThrow(() => assertNoBlockedCommand([command.file, ...command.args]));
});

test('/host docker-ps remains read-only and never uses docker socket or compose', async () => {
  const seen = [];
  await buildHostCommandReply('/host docker-ps', {
    ...operatorOptions,
    execFileFn: async (file, args, opts) => {
      seen.push({ file, args, opts });
      return { stdout: 'hermes_app\tUp 1 minute\thermes-app:latest\t3000/tcp\n', stderr: '' };
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, 'docker');
  assert.deepEqual(seen[0].args.slice(0, 1), ['ps']);
  assert.equal(seen[0].opts.shell, false);
  const commandText = [seen[0].file, ...seen[0].args].join(' ');
  assert.doesNotMatch(commandText, /docker-compose|docker compose|restart|rm\b|rmi\b|create/);
  assert.doesNotMatch(commandText, /docker\.sock|\/var\/run\/docker\.sock/);
});

test('/host logs app caps lines at 200', () => {
  const command = buildDockerLogsCommand('app', '9999');
  assert.equal(command.file, 'docker');
  assert.deepEqual(command.args, ['logs', '--tail=200', 'hermes_app']);
  assert.equal(command.lines, 200);
});

test('/host logs worker caps lines at 200', () => {
  const command = buildDockerLogsCommand('worker', '500');
  assert.equal(command.file, 'docker');
  assert.deepEqual(command.args, ['logs', '--tail=200', 'hermes_worker']);
  assert.equal(command.lines, 200);
});

test('/host logs app and worker remain bounded to max 200 lines', async () => {
  for (const target of ['app', 'worker']) {
    const seen = [];
    const reply = await buildHostCommandReply(`/host logs ${target} 9999`, {
      ...operatorOptions,
      execFileFn: async (file, args, opts) => {
        seen.push({ file, args, opts });
        return { stdout: 'line\n'.repeat(250), stderr: '' };
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].file, 'docker');
    assert.deepEqual(seen[0].args.slice(0, 2), ['logs', '--tail=200']);
    assert.equal(seen[0].opts.shell, false);
    assert.match(reply, new RegExp(`Host logs ${target} \\(read-only, tail=200\\)`));
    assert.ok(reply.length <= 3500);
  }
});

test('invalid /host logs target is rejected', async () => {
  const reply = await buildHostCommandReply('/host logs db 80', operatorOptions);
  assert.match(reply, /Dùng: \/host logs app \[lines\] hoặc \/host logs worker \[lines\]/);
});

test('unsafe commands are blocked by guard', () => {
  const unsafeCommands = [
    'docker-compose down',
    'docker compose down',
    'docker volume rm hermes_db',
    'docker rm hermes_app',
    'docker rmi image',
    'rm -rf /',
    'DROP TABLE hermes_tasks',
    'DELETE FROM hermes_tasks',
    'UPDATE hermes_tasks SET status=failed',
    'INSERT INTO hermes_tasks DEFAULT VALUES',
    'ALTER TABLE hermes_tasks ADD COLUMN x text',
    'TRUNCATE hermes_tasks',
    'git reset --hard HEAD',
    'git checkout main',
    'git pull',
    'git push',
    'git merge main',
  ];
  for (const command of unsafeCommands) {
    assert.throws(() => assertNoBlockedCommand(command), /host_readonly_command_blocked/);
  }
});

test('redaction removes DATABASE_URL/token/password/API key values', () => {
  const input = [
    'DATABASE_URL=postgres://user:pass@db:5432/hermes',
    'TELEGRAM_BOT_TOKEN=123456:ABCDEF_secret',
    'GH_TOKEN=ghp_123456789012345678901234567890123456',
    'password=swordfish',
    'api_key=sk-abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Bearer abc.defghijklmnopqrstuvwxyz.12345678901234567890',
  ].join('\n');
  const output = redactSensitiveText(input);
  assert.doesNotMatch(output, /user:pass|swordfish|abcdefghijklmnopqrstuvwxyz123456|ghp_123456|ABCDEF_secret|abc\.defgh/);
  assert.match(output, /DATABASE_URL=\[REDACTED\]/);
  assert.match(output, /password=\[REDACTED\]/i);
});

test('non-operator cannot use /host commands', async () => {
  const reply = await buildHostCommandReply('/host health', { userId: 7, allowedUserIds: [42] });
  assert.match(reply, /Operator authorization required/);
});

test('/host git-status does not run git pull/push/checkout/reset/merge', async () => {
  const commands = buildGitStatusCommands();
  assert.deepEqual(commands.map((command) => [command.file, command.args]), [
    ['git', ['status', '--short']],
    ['git', ['log', '--oneline', '--decorate', '-5']],
  ]);
  const seen = [];
  const reply = await buildHostCommandReply('/host git-status', {
    ...operatorOptions,
    execFileFn: async (file, args) => {
      seen.push([file, args]);
      return { stdout: file === 'git' && args[0] === 'status' ? ' M index.js\n' : 'abc123 (HEAD) test commit\n', stderr: '' };
    },
  });
  const joined = seen.map(([file, args]) => [file, ...args].join(' ')).join('\n');
  assert.doesNotMatch(joined, /git (pull|push|checkout|reset|merge)\b/);
  assert.match(reply, /git status --short/);
  assert.match(reply, /git log --oneline --decorate -5/);
});
