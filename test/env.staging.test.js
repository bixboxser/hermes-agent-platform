const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadEnv(appEnv) {
  const envPath = path.resolve(__dirname, '..', 'config', 'env.js');
  delete require.cache[envPath];
  process.env.PROJECT_ROOT_DEV = '/tmp/hermes-dev';
  process.env.PROJECT_ROOT_PROD = '/tmp/hermes-prod';
  delete process.env.HERMES_ENV;
  process.env.APP_ENV = appEnv;
  return require(envPath);
}

test('APP_ENV=staging maps to HERMES_ENV=prod', () => {
  const cfg = loadEnv('staging');
  assert.equal(cfg.APP_ENV, 'staging');
  assert.equal(cfg.HERMES_ENV, 'prod');
});
