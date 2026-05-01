const path = require('path');

const rawAppEnv = (process.env.APP_ENV || '').toLowerCase();
const rawHermesEnv = (process.env.HERMES_ENV || '').toLowerCase();

let HERMES_ENV = 'dev';
let APP_ENV = 'development';

if (rawAppEnv) {
  if (!['development', 'staging', 'production'].includes(rawAppEnv)) {
    throw new Error(`[env] Invalid APP_ENV=${rawAppEnv}. Use development|staging|production`);
  }
  APP_ENV = rawAppEnv;
  HERMES_ENV = (rawAppEnv === 'production' || rawAppEnv === 'staging') ? 'prod' : 'dev';
} else {
  HERMES_ENV = rawHermesEnv || 'dev';
  if (!['dev', 'prod'].includes(HERMES_ENV)) {
    throw new Error(`[env] Invalid HERMES_ENV=${HERMES_ENV}. Use dev|prod`);
  }
  APP_ENV = HERMES_ENV === 'prod' ? 'production' : 'development';
}

const projectRootDev = process.env.PROJECT_ROOT_DEV || process.env.PROJECT_ROOT || process.cwd();
const projectRootProd = process.env.PROJECT_ROOT_PROD || process.env.PROJECT_ROOT || process.cwd();

const projectRoot = path.resolve(HERMES_ENV === 'prod' ? projectRootProd : projectRootDev);
const prodRoot = path.resolve(projectRootProd);

if (HERMES_ENV === 'dev' && projectRoot === prodRoot) {
  throw new Error('[env] dev mode cannot target PROJECT_ROOT_PROD');
}

const telegramToken = HERMES_ENV === 'prod'
  ? (process.env.TELEGRAM_BOT_TOKEN_PROD || process.env.TELEGRAM_TOKEN)
  : (process.env.TELEGRAM_BOT_TOKEN_DEV || process.env.TELEGRAM_TOKEN);

function logStartupConfig() {
  console.log(`[env] HERMES_ENV=${HERMES_ENV}`);
  console.log(`[env] APP_ENV=${APP_ENV}`);
  console.log(`[env] projectRoot=${projectRoot}`);
}

module.exports = {
  HERMES_ENV,
  APP_ENV,
  projectRoot,
  projectRootDev: path.resolve(projectRootDev),
  projectRootProd: prodRoot,
  TELEGRAM_TOKEN: telegramToken,
  effectiveTelegramEnabled: process.env.DISABLE_TELEGRAM !== 'true',
  logStartupConfig,
};
