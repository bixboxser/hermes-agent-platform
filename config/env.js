const path = require("path");

const VALID_ENVS = ["development", "staging", "production"];
const APP_ENV = process.env.APP_ENV || "development";

if (!VALID_ENVS.includes(APP_ENV)) {
  throw new Error(`[env] Invalid APP_ENV: ${APP_ENV}. Valid values: ${VALID_ENVS.join(", ")}`);
}

function isTrue(value) {
  return String(value).toLowerCase() === "true";
}

function isFalse(value) {
  return String(value).toLowerCase() === "false";
}

function resolveTelegramEnabled() {
  if (isTrue(process.env.DISABLE_TELEGRAM)) return false;

  if (APP_ENV === "production") {
    return !isFalse(process.env.TELEGRAM_ENABLED);
  }

  return isTrue(process.env.TELEGRAM_ENABLED);
}

const effectiveTelegramEnabled = resolveTelegramEnabled();

const COMMAND_MODE_BY_ENV = {
  development: "safe-block",
  staging: "approval-required",
  production: "strict-approval",
};

const commandMode = COMMAND_MODE_BY_ENV[APP_ENV];
const projectRoot = process.env.PROJECT_ROOT || "/root/projects/somewhere-sanctuary-hub-main-final";

function logStartupConfig() {
  console.log(`[env] APP_ENV=${APP_ENV}`);
  console.log(`[env] commandMode=${commandMode}`);
  console.log(`[env] effectiveTelegramEnabled=${effectiveTelegramEnabled}`);
  console.log(`[env] projectRoot=${path.resolve(projectRoot)}`);
}

module.exports = {
  APP_ENV,
  effectiveTelegramEnabled,
  commandMode,
  projectRoot,
  logStartupConfig,
};
